import { app, safeStorage } from "electron";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}

function tokenPath() {
  return path.join(app.getPath("userData"), "tokens.bin");
}

export async function saveTokens(t: StoredTokens): Promise<void> {
  await mkdir(app.getPath("userData"), { recursive: true });
  const json = JSON.stringify(t);
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, "utf8");
  await writeFile(tokenPath(), buf);
}

export async function loadTokens(): Promise<StoredTokens | null> {
  try {
    const buf = await readFile(tokenPath());
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString("utf8");
    return JSON.parse(json) as StoredTokens;
  } catch {
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  try {
    await unlink(tokenPath());
  } catch {}
}
