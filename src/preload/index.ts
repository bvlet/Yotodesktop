import { contextBridge, ipcRenderer, webUtils } from "electron";

type AudioStage = "transcoding-local" | "hashing" | "uploading" | "transcoding-server" | "done";

interface UploadResult {
  uploadId: string;
  trackSha256: string;
  durationSec?: number;
  serverFileSize?: number;
  localSizeBytes: number;
  alreadyExisted: boolean;
  format?: string;
  channels?: string;
}

interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
}

interface Track {
  key?: string;
  title: string;
  durationSec?: number;
  iconUrl?: string;
}

interface Chapter {
  key?: string;
  title: string;
  durationSec?: number;
  iconUrl?: string;
  tracks: Track[];
}

interface PublicIcon {
  displayIconId: string;
  mediaId: string;
  title: string;
  url: string;
  tags: string[];
}

interface UserIcon {
  displayIconId: string;
  mediaId: string;
  url: string;
}

interface CoverImage {
  mediaId: string;
  mediaUrl: string;
}

interface PlaylistSummary {
  cardId: string;
  title: string;
  coverUrl?: string;
  updatedAt?: string;
}

interface Playlist extends PlaylistSummary {
  chapters: Chapter[];
  totalDurationSec?: number;
  trackCount: number;
  editable?: boolean;
}

interface StickerItem {
  title: string;
  coverUrl?: string;
  fit?: "contain" | "cover";
}

interface StickerResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  count?: number;
  skipped?: string[];
}

interface ImageSearchResult {
  url: string;
  thumbUrl: string;
  title: string;
  source: string;
}

interface CardArtComposeInput {
  title: string;
  artist?: string;
  style?: "photo" | "illustrated";
  imageUrl?: string;
  imagePath?: string;
  tracks?: string[];
  variant?: number;
  zoom?: number;
  panX?: number;
  panY?: number;
  showTitle?: boolean;
}

interface CardArtComposeResult {
  ok: boolean;
  dataUrl?: string;
  error?: string;
}

interface CardArtSaveResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
}

const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion"),
  },
  auth: {
    status: (): Promise<{ signedIn: boolean }> => ipcRenderer.invoke("auth:status"),
    start: (): Promise<DeviceCodeInfo> => ipcRenderer.invoke("auth:start"),
    cancel: (): Promise<void> => ipcRenderer.invoke("auth:cancel"),
    signOut: (): Promise<void> => ipcRenderer.invoke("auth:signout"),
    onComplete: (cb: (result: { ok: boolean; error?: string }) => void) => {
      const listener = (_: unknown, result: { ok: boolean; error?: string }) => cb(result);
      ipcRenderer.on("auth:complete", listener);
      return () => ipcRenderer.removeListener("auth:complete", listener);
    },
  },
  playlists: {
    list: (): Promise<PlaylistSummary[]> => ipcRenderer.invoke("playlists:list"),
    listFamily: (): Promise<PlaylistSummary[]> => ipcRenderer.invoke("playlists:listFamily"),
    get: (cardId: string): Promise<Playlist> => ipcRenderer.invoke("playlists:get", cardId),
    rename: (cardId: string, newTitle: string): Promise<void> =>
      ipcRenderer.invoke("playlists:rename", cardId, newTitle),
    reorder: (cardId: string, chapterKeys: string[]): Promise<void> =>
      ipcRenderer.invoke("playlists:reorder", cardId, chapterKeys),
    deleteChapter: (cardId: string, chapterKey: string): Promise<void> =>
      ipcRenderer.invoke("playlists:deleteChapter", cardId, chapterKey),
    setTitles: (cardId: string, updates: Array<{ chapterIndex: number; title: string }>): Promise<void> =>
      ipcRenderer.invoke("playlists:setTitles", cardId, updates),
    create: (input: {
      title: string;
      coverMediaUrl?: string;
      tracks: Array<{
        title: string;
        trackSha256: string;
        durationSec?: number;
        fileSize?: number;
        iconRef?: string;
        format?: string;
        channels?: string;
      }>;
    }): Promise<{ cardId: string }> => ipcRenderer.invoke("playlists:create", input),
    repair: (cardId: string): Promise<void> => ipcRenderer.invoke("playlists:repair", cardId),
    delete: (cardId: string): Promise<void> => ipcRenderer.invoke("playlists:delete", cardId),
    setCover: (cardId: string, mediaUrl: string | null): Promise<void> =>
      ipcRenderer.invoke("playlists:setCover", cardId, mediaUrl),
    setChapterIcon: (cardId: string, chapterIndex: number, iconRef: string): Promise<void> =>
      ipcRenderer.invoke("playlists:setChapterIcon", cardId, chapterIndex, iconRef),
    setIcons: (cardId: string, updates: Array<{ chapterIndex: number; iconRef: string }>): Promise<void> =>
      ipcRenderer.invoke("playlists:setIcons", cardId, updates),
    appendTracks: (
      cardId: string,
      tracks: Array<{
        title: string;
        trackSha256: string;
        durationSec?: number;
        fileSize?: number;
        iconRef?: string;
        format?: string;
        channels?: string;
      }>
    ): Promise<void> => ipcRenderer.invoke("playlists:appendTracks", cardId, tracks),
  },
  cover: {
    upload: (filePath: string): Promise<CoverImage> => ipcRenderer.invoke("cover:upload", filePath),
  },
  icons: {
    listPublic: (): Promise<PublicIcon[]> => ipcRenderer.invoke("icons:listPublic"),
    listUser: (): Promise<UserIcon[]> => ipcRenderer.invoke("icons:listUser"),
    upload: (filePath: string): Promise<UserIcon> => ipcRenderer.invoke("icons:upload", filePath),
    semanticMatch: (
      titles: string[],
      icons: Array<{ mediaId: string; title: string; url: string; tags: string[] }>,
      threshold?: number
    ): Promise<Array<{ title: string; mediaId: string | null; url: string | null; iconTitle: string | null; score: number }>> =>
      ipcRenderer.invoke("icons:semanticMatch", titles, icons, threshold),
  },
  audio: {
    upload: (
      opId: string,
      filePath: string,
      onStage?: (stage: AudioStage) => void
    ): Promise<UploadResult> => {
      let listener: ((_: unknown, msg: { opId: string; stage: AudioStage }) => void) | null = null;
      if (onStage) {
        listener = (_e, msg) => {
          if (msg.opId === opId && msg.stage) onStage(msg.stage);
        };
        ipcRenderer.on("audio:progress", listener);
      }
      const cleanup = () => {
        if (listener) ipcRenderer.removeListener("audio:progress", listener);
      };
      return ipcRenderer.invoke("audio:upload", opId, filePath).finally(cleanup);
    },
    cancel: (opId: string): Promise<void> => ipcRenderer.invoke("audio:cancel", opId),
  },
  files: {
    pathForDroppedFile: (file: File): string => webUtils.getPathForFile(file),
    resolveDropPaths: (paths: string[]): Promise<{ folderName?: string; audioFiles: string[] }> =>
      ipcRenderer.invoke("files:resolveDropPaths", paths),
    pickImage: (): Promise<string | null> => ipcRenderer.invoke("files:pickImage"),
  },
  stickers: {
    generate: (items: StickerItem[]): Promise<StickerResult> => ipcRenderer.invoke("stickers:generate", items),
    searchImages: (query: string): Promise<ImageSearchResult[]> => ipcRenderer.invoke("stickers:searchImages", query),
  },
  cardArt: {
    searchOfficial: (query: string): Promise<ImageSearchResult[]> => ipcRenderer.invoke("cardart:searchOfficial", query),
    searchBooks: (query: string): Promise<ImageSearchResult[]> => ipcRenderer.invoke("cardart:searchBooks", query),
    compose: (input: CardArtComposeInput): Promise<CardArtComposeResult> => ipcRenderer.invoke("cardart:compose", input),
    writeTemp: (dataUrl: string): Promise<string> => ipcRenderer.invoke("cardart:writeTemp", dataUrl),
    saveAs: (dataUrl: string, suggestedName: string): Promise<CardArtSaveResult> =>
      ipcRenderer.invoke("cardart:saveAs", dataUrl, suggestedName),
  },
};

contextBridge.exposeInMainWorld("yoto", api);

export type YotoApi = typeof api;
