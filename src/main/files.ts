import type { IpcMain } from "electron";
import { dialog, BrowserWindow } from "electron";
import { open, stat, readdir } from "node:fs/promises";
import path from "node:path";

const AUDIO_EXTS = new Set([
  ".mp3", ".m4a", ".m4b", ".aac",
  ".ogg", ".oga", ".opus",
  ".wav", ".flac", ".alac",
  ".aiff", ".aif", ".wma", ".webm",
]);

export interface ResolvedDrop {
  folderName?: string;
  audioFiles: string[];
}

function syncSafeInt(bytes: Uint8Array): number {
  return ((bytes[0] & 0x7f) << 21) | ((bytes[1] & 0x7f) << 14) | ((bytes[2] & 0x7f) << 7) | (bytes[3] & 0x7f);
}

function decodeUtf16Be(value: Buffer): string {
  const swapped = Buffer.allocUnsafe(value.length - (value.length % 2));
  for (let i = 0; i < swapped.length; i += 2) {
    swapped[i] = value[i + 1];
    swapped[i + 1] = value[i];
  }
  return swapped.toString("utf16le");
}

function decodeId3Text(value: Buffer): string | null {
  if (value.length < 2) return null;
  const encoding = value[0];
  let text: string;
  if (encoding === 0) text = value.subarray(1).toString("latin1");
  else if (encoding === 3) text = value.subarray(1).toString("utf8");
  else if (encoding === 1) {
    const textBytes = value.subarray(1);
    if (textBytes[0] === 0xfe && textBytes[1] === 0xff) text = decodeUtf16Be(textBytes.subarray(2));
    else text = textBytes.subarray(textBytes[0] === 0xff && textBytes[1] === 0xfe ? 2 : 0).toString("utf16le");
  } else if (encoding === 2) text = decodeUtf16Be(value.subarray(1));
  else return null;
  const title = text.replace(/\0/g, "").trim();
  return title || null;
}

function readId3v2Title(tag: Buffer): string | null {
  if (tag.length < 10 || tag.subarray(0, 3).toString("ascii") !== "ID3") return null;
  const version = tag[3];
  if (version < 2 || version > 4) return null;
  const flags = tag[5];
  const tagEnd = Math.min(tag.length, 10 + syncSafeInt(tag.subarray(6, 10)));
  let offset = 10;

  if (flags & 0x40) {
    if (offset + 4 > tagEnd) return null;
    const extendedSize = version === 4 ? syncSafeInt(tag.subarray(offset, offset + 4)) : tag.readUInt32BE(offset);
    offset += version === 4 ? extendedSize : extendedSize + 4;
  }

  const frameId = version === 2 ? "TT2" : "TIT2";
  const frameHeaderSize = version === 2 ? 6 : 10;
  while (offset + frameHeaderSize <= tagEnd) {
    const idLength = version === 2 ? 3 : 4;
    const id = tag.subarray(offset, offset + idLength).toString("ascii");
    if (!/^[A-Z0-9]{3,4}$/.test(id)) return null;
    const sizeOffset = offset + idLength;
    const frameSize = version === 2
      ? (tag[sizeOffset] << 16) | (tag[sizeOffset + 1] << 8) | tag[sizeOffset + 2]
      : version === 4
        ? syncSafeInt(tag.subarray(sizeOffset, sizeOffset + 4))
        : tag.readUInt32BE(sizeOffset);
    if (frameSize <= 0 || offset + frameHeaderSize + frameSize > tagEnd) return null;
    if (id === frameId) return decodeId3Text(tag.subarray(offset + frameHeaderSize, offset + frameHeaderSize + frameSize));
    offset += frameHeaderSize + frameSize;
  }
  return null;
}

async function readId3Title(filePath: string): Promise<string | null> {
  try {
    const file = await open(filePath, "r");
    try {
      const header = Buffer.alloc(10);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (bytesRead === 10 && header.subarray(0, 3).toString("ascii") === "ID3") {
        const tagSize = syncSafeInt(header.subarray(6, 10));
        const bytesToRead = Math.min(tagSize, 1024 * 1024);
        const tag = Buffer.alloc(10 + bytesToRead);
        header.copy(tag);
        await file.read(tag, 10, bytesToRead, 10);
        const v2Title = readId3v2Title(tag);
        if (v2Title) return v2Title;
      }

      const { size } = await file.stat();
      if (size < 128) return null;
      const v1 = Buffer.alloc(128);
      await file.read(v1, 0, v1.length, size - v1.length);
      if (v1.subarray(0, 3).toString("ascii") !== "TAG") return null;
      return v1.subarray(3, 33).toString("latin1").replace(/\0/g, "").trim() || null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

export function registerFileHandlers(ipc: IpcMain): void {
  ipc.handle("files:resolveDropPaths", async (_e, paths: string[]): Promise<ResolvedDrop> => {
    const audioFiles: string[] = [];
    let folderName: string | undefined;
    let folderCount = 0;

    for (const p of paths) {
      let s;
      try { s = await stat(p); } catch { continue; }
      if (s.isDirectory()) {
        folderCount += 1;
        if (folderCount === 1) folderName = path.basename(p);
        const entries = await readdir(p);
        for (const entry of entries) {
          const full = path.join(p, entry);
          let es;
          try { es = await stat(full); } catch { continue; }
          if (es.isFile() && AUDIO_EXTS.has(path.extname(entry).toLowerCase())) {
            audioFiles.push(full);
          }
        }
      } else if (s.isFile() && AUDIO_EXTS.has(path.extname(p).toLowerCase())) {
        audioFiles.push(p);
      }
    }

    if (folderCount > 1) folderName = undefined;

    audioFiles.sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: "base" })
    );

    return { folderName, audioFiles };
  });

  ipc.handle("files:pickImage", async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = {
      title: "Choose an image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipc.handle("files:pickAudioFiles", async (event): Promise<string[] | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = {
      title: "Choose the original audio files",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Audio", extensions: Array.from(AUDIO_EXTS, (ext) => ext.slice(1)) }],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths.sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: "base" })
    );
  });

  ipc.handle("files:readId3Titles", async (_e, filePaths: string[]): Promise<Array<string | null>> =>
    Promise.all(filePaths.map(readId3Title))
  );
}
