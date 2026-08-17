import { app } from "electron";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, mkdir, unlink, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { getValidAccessToken } from "./auth.js";

const API_BASE = "https://api.yotoplay.com";
const NATIVE_EXTS = new Set([".mp3"]);

function ffmpegPath(): string {
  // ffmpeg-static returns the path; in packaged Electron it lives inside app.asar.unpacked
  const raw = (ffmpegStatic as unknown as string) || "";
  if (!raw) throw new Error("ffmpeg binary not found in bundle");
  return raw.replace("app.asar", "app.asar.unpacked");
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function tempPath(suffix: string): Promise<string> {
  const tmpDir = path.join(app.getPath("temp"), "desktop-for-yoto");
  await mkdir(tmpDir, { recursive: true });
  return path.join(tmpDir, `${randomBytes(8).toString("hex")}${suffix}`);
}

async function transcodeToMp3(inputPath: string, signal?: AbortSignal): Promise<string> {
  const out = await tempPath(".mp3");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath(), [
      "-y",
      "-i", inputPath,
      "-vn",
      "-codec:a", "libmp3lame",
      "-b:a", "192k",
      out,
    ]);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    const onAbort = () => proc.kill("SIGTERM");
    if (signal) {
      if (signal.aborted) { proc.kill("SIGTERM"); reject(new Error("aborted")); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("aborted"));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.split("\n").slice(-4).join(" | ")}`));
    });
  });
  return out;
}

async function getAudioUploadUrl(sha256: string, filename: string, signal?: AbortSignal): Promise<{ uploadId: string; uploadUrl: string | null }> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("not signed in");
  const url = new URL(`${API_BASE}/media/transcode/audio/uploadUrl`);
  url.searchParams.set("sha256", sha256);
  if (filename) url.searchParams.set("filename", filename);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`upload-url request failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as { upload: { uploadId: string; uploadUrl: string | null } };
  return data.upload;
}

async function putAudio(uploadUrl: string, filePath: string, signal?: AbortSignal): Promise<void> {
  const data = await readFile(filePath);
  const res = await fetch(uploadUrl, {
    method: "PUT",
    body: data,
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`upload PUT failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
}

async function getTranscoded(uploadId: string, signal?: AbortSignal): Promise<{
  phase?: string;
  transcodedSha256?: string;
  durationSec?: number;
  fileSize?: number;
  format?: string;
  channels?: string;
}> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("not signed in");
  const res = await fetch(
    `${API_BASE}/media/upload/${encodeURIComponent(uploadId)}/transcoded?loudnorm=false`,
    {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal,
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`transcoded poll failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as {
    transcode?: {
      progress?: { phase?: string };
      transcodedSha256?: string;
      transcodedInfo?: {
        duration?: number;
        fileSize?: number;
        format?: string;
        channels?: string;
      };
    };
  };
  const t = data.transcode ?? {};
  return {
    phase: t.progress?.phase,
    transcodedSha256: t.transcodedSha256,
    durationSec: t.transcodedInfo?.duration,
    fileSize: t.transcodedInfo?.fileSize,
    format: t.transcodedInfo?.format,
    channels: t.transcodedInfo?.channels,
  };
}

async function cancellableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const FAILURE_PHASES = new Set(["failed", "error", "errored", "rejected", "cancelled"]);

async function pollUntilTranscoded(uploadId: string, signal?: AbortSignal) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    const status = await getTranscoded(uploadId, signal);
    if (status.transcodedSha256 || status.phase === "complete") return status;
    if (status.phase && FAILURE_PHASES.has(status.phase.toLowerCase())) {
      throw new Error(`server-side transcoding failed: ${status.phase}`);
    }
    await cancellableSleep(3000, signal);
  }
  throw new Error("server-side transcoding timed out after 10 minutes");
}

export interface UploadResult {
  uploadId: string;
  trackSha256: string;
  durationSec?: number;
  serverFileSize?: number;
  localSizeBytes: number;
  alreadyExisted: boolean;
  format?: string;
  channels?: string;
}

export type ProgressStage = "transcoding-local" | "hashing" | "uploading" | "transcoding-server" | "done";

export async function uploadAudioFile(
  filePath: string,
  onStage?: (stage: ProgressStage) => void,
  signal?: AbortSignal
): Promise<UploadResult> {
  const ext = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath, path.extname(filePath));

  let toUpload = filePath;
  let cleanup = false;
  if (!NATIVE_EXTS.has(ext)) {
    onStage?.("transcoding-local");
    toUpload = await transcodeToMp3(filePath, signal);
    cleanup = true;
  }

  try {
    if (signal?.aborted) throw new Error("aborted");
    onStage?.("hashing");
    const sha = await hashFile(toUpload);
    const stats = await stat(toUpload);

    if (signal?.aborted) throw new Error("aborted");
    onStage?.("uploading");
    const upload = await getAudioUploadUrl(sha, `${baseName}.mp3`, signal);
    if (upload.uploadUrl) await putAudio(upload.uploadUrl, toUpload, signal);

    onStage?.("transcoding-server");
    const status = await pollUntilTranscoded(upload.uploadId, signal);
    if (!status.transcodedSha256) throw new Error("transcoding finished but no sha returned");

    onStage?.("done");
    return {
      uploadId: upload.uploadId,
      trackSha256: status.transcodedSha256,
      durationSec: status.durationSec,
      serverFileSize: status.fileSize,
      localSizeBytes: stats.size,
      alreadyExisted: !upload.uploadUrl,
      format: status.format,
      channels: status.channels,
    };
  } finally {
    if (cleanup) {
      try { await unlink(toUpload); } catch {}
    }
  }
}
