import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { shell } from "electron";
import http from "node:http";
import crypto from "node:crypto";
import { loadTokens, saveTokens, clearTokens, type StoredTokens } from "./storage.js";

// Bring your own client: register a free "public client" at https://dashboard.yoto.dev
// and set YOTO_CLIENT_ID (required) before starting the app, e.g.:
//   YOTO_CLIENT_ID=xxxxxxxx npm run dev
// Register this exact redirect URI on the dashboard for your client:
//   http://127.0.0.1:8787/callback
const CLIENT_ID = process.env.YOTO_CLIENT_ID || "vfGPYN2Au3wv2m2QHd8SFLs7QVWCH5Yg";
const CALLBACK_PORT = Number(process.env.YOTO_CALLBACK_PORT || 8787);
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const AUTH_BASE = "https://login.yotoplay.com";
const AUDIENCE = "https://api.yotoplay.com";
const SCOPE = "openid profile offline_access user:content:manage user:content:view user:icons:manage family:library:manage family:library:view family:devices:view";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makePkce() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

let activeServer: http.Server | null = null;

function stopServer(): void {
  activeServer?.close();
  activeServer = null;
}

async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<TokenResponse> {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json() as Promise<TokenResponse>;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
  return res.json() as Promise<TokenResponse>;
}

export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await loadTokens();
  if (!tokens) return null;
  if (tokens.expiresAt && Date.now() < tokens.expiresAt - 60_000) return tokens.accessToken;
  try {
    const fresh = await refreshAccessToken(tokens.refreshToken);
    const updated: StoredTokens = {
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + fresh.expires_in * 1000,
    };
    await saveTokens(updated);
    return updated.accessToken;
  } catch {
    return null;
  }
}

function startLoginFlow(onDone: (ok: boolean, error?: string) => void): void {
  stopServer();

  if (!CLIENT_ID) {
    onDone(false, "Geen YOTO_CLIENT_ID ingesteld. Registreer een client op https://dashboard.yoto.dev en start de app met YOTO_CLIENT_ID=... npm run dev");
    return;
  }

  const state = base64url(crypto.randomBytes(16));
  const { codeVerifier, codeChallenge } = makePkce();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${CALLBACK_PORT}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }

    const returnedState = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const errorParam = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (errorParam) {
      res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>Inloggen mislukt</h2><p>${errorParam}: ${errorDescription || ""}</p><p>Je kan dit venster sluiten.</p></body></html>`);
      stopServer();
      onDone(false, errorDescription || errorParam);
      return;
    }
    if (!code || returnedState !== state) {
      res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>Inloggen mislukt</h2><p>Ongeldige respons.</p></body></html>`);
      stopServer();
      onDone(false, "invalid callback response");
      return;
    }

    res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>Gelukt!</h2><p>Je bent ingelogd. Je kan dit venster sluiten en teruggaan naar Desktop for Yoto.</p></body></html>`);
    stopServer();

    exchangeCodeForTokens(code, codeVerifier)
      .then(async (tokens) => {
        await saveTokens({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
        });
        onDone(true);
      })
      .catch((err) => onDone(false, err instanceof Error ? err.message : String(err)));
  });

  server.listen(CALLBACK_PORT, "127.0.0.1", () => {
    const authorizeUrl = new URL("/authorize", AUTH_BASE);
    authorizeUrl.searchParams.set("audience", AUDIENCE);
    authorizeUrl.searchParams.set("scope", SCOPE);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    shell.openExternal(authorizeUrl.toString());
  });

  activeServer = server;
}

export function registerAuthHandlers(ipc: IpcMain): void {
  ipc.handle("auth:status", async () => {
    const token = await getValidAccessToken();
    return { signedIn: !!token };
  });

  ipc.handle("auth:start", async (event: IpcMainInvokeEvent) => {
    startLoginFlow((ok, error) => {
      event.sender.send("auth:complete", { ok, error });
    });
    return { verificationUri: `${AUTH_BASE}/authorize` };
  });

  ipc.handle("auth:cancel", async () => {
    stopServer();
  });

  ipc.handle("auth:signout", async () => {
    stopServer();
    await clearTokens();
  });
}
