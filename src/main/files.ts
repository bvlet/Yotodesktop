import type { IpcMain } from "electron";
import { dialog, BrowserWindow } from "electron";
import { stat, readdir } from "node:fs/promises";
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
}
