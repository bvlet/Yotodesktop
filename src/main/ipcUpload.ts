import type { IpcMain } from "electron";
import { uploadAudioFile, type UploadResult } from "./upload.js";

const ops = new Map<string, AbortController>();

export function registerUploadHandlers(ipc: IpcMain): void {
  ipc.handle(
    "audio:upload",
    async (event, opId: string, filePath: string): Promise<UploadResult> => {
      const ctrl = new AbortController();
      ops.set(opId, ctrl);
      try {
        return await uploadAudioFile(
          filePath,
          (stage) => event.sender.send("audio:progress", { opId, stage }),
          ctrl.signal
        );
      } finally {
        ops.delete(opId);
      }
    }
  );

  ipc.handle("audio:cancel", async (_e, opId: string): Promise<void> => {
    ops.get(opId)?.abort();
  });
}
