import type { IpcMain } from "electron";
import { app } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { getValidAccessToken } from "./auth.js";

function genUid(): string {
  return randomBytes(12).toString("base64url");
}

const API_BASE = "https://api.yotoplay.com";

export interface Track {
  key?: string;
  title: string;
  durationSec?: number;
  iconUrl?: string;
}

export interface Chapter {
  key?: string;
  title: string;
  durationSec?: number;
  iconUrl?: string;
  tracks: Track[];
}

export interface PlaylistSummary {
  cardId: string;
  title: string;
  coverUrl?: string;
  updatedAt?: string;
}

export interface Playlist extends PlaylistSummary {
  chapters: Chapter[];
  totalDurationSec?: number;
  trackCount: number;
  // false for family-library cards you don't own yourself (fetched via /card/{id} because
  // /content/{id} 403'd) — Yoto's API only accepts edits through /content, so these can be
  // viewed/played but not renamed, re-titled, re-iconed, or trimmed from this app.
  editable?: boolean;
}

interface CachedRaw {
  cardId: string;
  title: string;
  content: Record<string, unknown>;
  metadata: Record<string, unknown>;
  editable: boolean;
}

const cache = new Map<string, CachedRaw>();

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("not signed in");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`${path} → ${res.status} ${res.statusText} ${bodyText}`.trim());
  }
  return res;
}

async function getJson(path: string): Promise<unknown> {
  return (await authed(path)).json();
}

function pickCoverUrl(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const cover = metadata.cover as { imageL?: string; imageS?: string } | undefined;
  return cover?.imageL || cover?.imageS;
}

function pickIconUrl(display: unknown): string | undefined {
  if (!display || typeof display !== "object") return undefined;
  const ref = (display as { icon16x16?: string }).icon16x16;
  if (typeof ref !== "string") return undefined;
  return ref.startsWith("http") ? ref : undefined;
}

function parseTrack(t: Record<string, unknown>, i: number): Track {
  return {
    key: typeof t.key === "string" ? t.key : undefined,
    title: String(t.title ?? `Track ${i + 1}`),
    durationSec: typeof t.duration === "number" ? t.duration : undefined,
    iconUrl: pickIconUrl(t.display),
  };
}

function parseChapter(ch: Record<string, unknown>, i: number): Chapter {
  const tracksRaw = (ch.tracks as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    key: typeof ch.key === "string" ? ch.key : undefined,
    title: String(ch.title ?? `Chapter ${i + 1}`),
    durationSec: typeof ch.duration === "number" ? ch.duration : undefined,
    iconUrl: pickIconUrl(ch.display) || pickIconUrl(tracksRaw[0]?.display),
    tracks: tracksRaw.map(parseTrack),
  };
}

function parseSummary(c: Record<string, unknown>): PlaylistSummary {
  const meta = (c.metadata as Record<string, unknown> | undefined) ?? {};
  return {
    cardId: String(c.cardId ?? c.id ?? ""),
    title: String((meta.title as string) || c.title || "Untitled"),
    coverUrl: pickCoverUrl(meta),
    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : undefined,
  };
}

function parseFullCard(c: Record<string, unknown>, editable: boolean): Playlist {
  const summary = parseSummary(c);
  const content = (c.content as Record<string, unknown> | undefined) ?? {};
  const chaptersRaw = (content.chapters as Array<Record<string, unknown>> | undefined) ?? [];
  const chapters = chaptersRaw.map(parseChapter);
  const meta = (c.metadata as Record<string, unknown> | undefined) ?? {};
  const media = meta.media as { duration?: number } | undefined;
  return {
    ...summary,
    chapters,
    totalDurationSec:
      typeof media?.duration === "number"
        ? media.duration
        : chapters.reduce((n, ch) => n + (ch.durationSec ?? 0), 0) || undefined,
    trackCount: chapters.reduce((n, ch) => n + ch.tracks.length, 0),
    editable,
  };
}

function cacheRaw(c: Record<string, unknown>, editable: boolean) {
  const cardId = String(c.cardId ?? c.id ?? "");
  if (!cardId) return;
  cache.set(cardId, {
    cardId,
    title: String(c.title ?? ""),
    content: (c.content as Record<string, unknown>) ?? {},
    metadata: (c.metadata as Record<string, unknown>) ?? {},
    editable,
  });
}

async function putContent(raw: CachedRaw): Promise<unknown> {
  if (!raw.editable) {
    throw new Error(
      "Deze playlist is niet van jouw eigen account (gedeeld via de familie-bibliotheek) — Yoto staat bewerken daarvan alleen toe voor de eigenaar zelf."
    );
  }
  const body = {
    cardId: raw.cardId,
    title: raw.title,
    content: raw.content,
    metadata: raw.metadata,
    deleted: false,
  };
  try {
    const dir = path.join(app.getPath("userData"), "debug", "put");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${raw.cardId}-req.json`), JSON.stringify(body, null, 2));
  } catch {}
  const res = await authed("/content", { method: "POST", body: JSON.stringify(body) });
  const data = await res.json();
  try {
    const dir = path.join(app.getPath("userData"), "debug", "put");
    await writeFile(path.join(dir, `${raw.cardId}-res.json`), JSON.stringify(data, null, 2));
  } catch {}
  return data;
}

const DEFAULT_ICON_REF = "yoto:#aUm9i3ex3qqAMYBv-i-O-pYMKuMJGICtR3Vhf289u2Q";

function buildChapterShape(args: {
  index: number;
  title: string;
  trackUrl: string;
  durationSec?: number;
  fileSize?: number;
  iconRef?: string;
  trackUid?: string;
  format?: string;
  channels?: string;
}) {
  const overlayLabel = String(args.index + 1);
  const iconRef = args.iconRef || DEFAULT_ICON_REF;
  const track = {
    key: "01",
    uid: args.trackUid || genUid(),
    title: args.title,
    trackUrl: args.trackUrl,
    type: "audio",
    format: args.format || "opus",
    channels: args.channels || "stereo",
    duration: args.durationSec,
    fileSize: args.fileSize,
    overlayLabel,
    display: { icon16x16: iconRef },
    ambient: null,
  };
  return {
    key: String(args.index + 1).padStart(3, "0"),
    title: args.title,
    duration: args.durationSec,
    fileSize: args.fileSize,
    hasStreams: false,
    tracks: [track],
    overlayLabel,
    display: { icon16x16: iconRef },
    availableFrom: null,
    ambient: null,
    defaultTrackDisplay: null,
    defaultTrackAmbient: null,
  };
}

export function registerApiHandlers(ipc: IpcMain): void {
  ipc.handle("playlists:list", async (): Promise<PlaylistSummary[]> => {
    const data = (await getJson("/content/mine")) as { cards?: Array<Record<string, unknown>> };
    try {
      const dir = path.join(app.getPath("userData"), "debug");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "list.json"), JSON.stringify(data, null, 2));
    } catch {}
    return (data.cards ?? []).map(parseSummary);
  });

  // The family library ("My family playlists" in the official app) is a different list from
  // "mine": it includes everything shared with/owned by the whole family (other members' MYO
  // content, purchased/official cards), not just content this account created. Items come back
  // nested as { cardId, card: { title, metadata } } rather than flat like /content/mine.
  ipc.handle("playlists:listFamily", async (): Promise<PlaylistSummary[]> => {
    const [data, mine] = await Promise.all([
      getJson("/card/family/library") as Promise<{ cards?: Array<Record<string, unknown>> }>,
      getJson("/content/mine").catch(() => ({ cards: [] })) as Promise<{ cards?: Array<Record<string, unknown>> }>,
    ]);
    try {
      const dir = path.join(app.getPath("userData"), "debug");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "family-list.json"), JSON.stringify(data, null, 2));
    } catch {}
    // "Mine" content also shows up in the family library — exclude it here since it's
    // already listed under "Your playlists", so this section only shows what's NOT already
    // shown there (other family members' content, purchased/official cards).
    const mineIds = new Set((mine.cards ?? []).map((c) => String(c.cardId ?? c.id ?? "")));
    return (data.cards ?? [])
      .filter((item) => !mineIds.has(String(item.cardId ?? "")))
      .map((item) => {
        const nested = (item.card as Record<string, unknown> | undefined) ?? {};
        return parseSummary({ ...nested, cardId: item.cardId });
      });
  });

  ipc.handle("playlists:get", async (_e, cardId: string): Promise<Playlist> => {
    // Regular fetch — used for caching the raw shape (yoto:#X refs preserved for repair/edit operations).
    // /content/{id} only works for cards this account owns; cards elsewhere in the family
    // library (other members' content, purchased/official cards) 403 there and need the
    // /card/{id} endpoint instead. Try the owned-content path first since it's what supports
    // editing, and fall back for everything else.
    let data: { card?: Record<string, unknown> } & Record<string, unknown>;
    let editable = true;
    try {
      data = (await getJson(`/content/${encodeURIComponent(cardId)}`)) as
        & { card?: Record<string, unknown> }
        & Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("403")) throw err;
      editable = false; // fell back to the read-only family/shared-card endpoint
      data = (await getJson(`/card/${encodeURIComponent(cardId)}`)) as
        & { card?: Record<string, unknown> }
        & Record<string, unknown>;
    }
    const card = (data.card ?? data) as Record<string, unknown>;
    cacheRaw(card, editable);

    // Playable fetch — has resolved icon and audio URLs for display
    let displayCard = card;
    try {
      const playable = (await getJson(`/content/${encodeURIComponent(cardId)}?playable=true`)) as
        & { card?: Record<string, unknown> }
        & Record<string, unknown>;
      displayCard = (playable.card ?? playable) as Record<string, unknown>;
    } catch {
      try {
        const playable = (await getJson(`/card/${encodeURIComponent(cardId)}?playable=true`)) as
          & { card?: Record<string, unknown> }
          & Record<string, unknown>;
        displayCard = (playable.card ?? playable) as Record<string, unknown>;
      } catch {}
    }

    try {
      const dir = path.join(app.getPath("userData"), "debug", "cards");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${cardId}.json`), JSON.stringify(data, null, 2));
      await writeFile(path.join(dir, `${cardId}-playable.json`), JSON.stringify({ card: displayCard }, null, 2));
    } catch {}

    return parseFullCard(displayCard, editable);
  });

  ipc.handle("playlists:rename", async (_e, cardId: string, newTitle: string): Promise<void> => {
    const raw = cache.get(cardId);
    if (!raw) throw new Error("playlist not loaded yet");
    raw.title = newTitle;
    raw.metadata = { ...raw.metadata, title: newTitle };
    await putContent(raw);
  });

  ipc.handle(
    "playlists:create",
    async (
      _e,
      input: {
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
      }
    ): Promise<{ cardId: string }> => {
      const chapters = input.tracks.map((t, i) =>
        buildChapterShape({
          index: i,
          title: t.title,
          trackUrl: `yoto:#${t.trackSha256}`,
          durationSec: t.durationSec,
          fileSize: t.fileSize,
          iconRef: t.iconRef,
          format: t.format,
          channels: t.channels,
        })
      );
      const totalDuration = input.tracks.reduce((n, t) => n + (t.durationSec ?? 0), 0);
      const totalFileSize = input.tracks.reduce((n, t) => n + (t.fileSize ?? 0), 0);
      const body = {
        title: input.title,
        deleted: false,
        content: {
          chapters,
          config: { resumeTimeout: 2592000 },
          hidden: false,
          playbackType: "linear",
          activity: "yoto_Player",
          version: "1",
          restricted: true,
        },
        metadata: {
          title: input.title,
          hidden: false,
          cover: input.coverMediaUrl ? { imageL: input.coverMediaUrl } : { imageL: null },
          media: { duration: totalDuration, fileSize: totalFileSize },
          authors: [],
          narrators: [],
          copyrights: [],
          accents: [],
          abridged: false,
        },
      };
      const res = await authed("/content", { method: "POST", body: JSON.stringify(body) });
      const data = (await res.json()) as { card?: { cardId?: string }; cardId?: string };
      const cardId = data.card?.cardId || data.cardId;
      if (!cardId) throw new Error("publish succeeded but no cardId returned");
      return { cardId };
    }
  );

  ipc.handle("cover:upload", async (_e, filePath: string): Promise<{ mediaId: string; mediaUrl: string }> => {
    const token = await getValidAccessToken();
    if (!token) throw new Error("not signed in");
    const data = await readFile(filePath);
    const url = new URL("https://api.yotoplay.com/media/coverImage/user/me/upload");
    // "myo" appears to route through a different (square-cropping) processing pipeline than
    // what yoto.dev's official example uses ("default") — uploads via this app were coming back
    // cropped/square compared to uploading the same file on the Yoto website, which preserves
    // the full portrait card image. Match the documented example.
    url.searchParams.set("coverType", "default");
    url.searchParams.set("autoconvert", "true");
    url.searchParams.set("filename", path.basename(filePath));
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/octet-stream",
      },
      body: data,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cover upload failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    const result = (await res.json()) as { coverImage: { mediaId: string; mediaUrl: string } };
    return result.coverImage;
  });

  ipc.handle("playlists:setCover", async (_e, cardId: string, mediaUrl: string | null): Promise<void> => {
    const raw = cache.get(cardId);
    if (!raw) throw new Error("playlist not loaded yet");
    raw.metadata = {
      ...raw.metadata,
      cover: mediaUrl ? { imageL: mediaUrl } : { imageL: null },
    };
    await putContent(raw);
  });

  ipc.handle("playlists:setIcons", async (_e, cardId: string, updates: Array<{ chapterIndex: number; iconRef: string }>): Promise<void> => {
    const raw = cache.get(cardId);
    if (!raw) throw new Error("playlist not loaded yet");
    const chapters = (raw.content.chapters as Array<Record<string, unknown>> | undefined) ?? [];
    for (const u of updates) {
      const ch = chapters[u.chapterIndex];
      if (!ch) continue;
      ch.display = { ...((ch.display as object | undefined) ?? {}), icon16x16: u.iconRef };
      const tracks = (ch.tracks as Array<Record<string, unknown>> | undefined) ?? [];
      for (const t of tracks) {
        t.display = { ...((t.display as object | undefined) ?? {}), icon16x16: u.iconRef };
      }
    }
    raw.content = { ...raw.content, chapters };
    await putContent(raw);
  });

  ipc.handle("playlists:setChapterIcon", async (_e, cardId: string, chapterIndex: number, iconRef: string): Promise<void> => {
    const raw = cache.get(cardId);
    if (!raw) throw new Error("playlist not loaded yet");
    const chapters = (raw.content.chapters as Array<Record<string, unknown>> | undefined) ?? [];
    const ch = chapters[chapterIndex];
    if (!ch) throw new Error(`chapter ${chapterIndex} not found`);
    ch.display = { ...((ch.display as object | undefined) ?? {}), icon16x16: iconRef };
    const tracks = (ch.tracks as Array<Record<string, unknown>> | undefined) ?? [];
    for (const t of tracks) {
      t.display = { ...((t.display as object | undefined) ?? {}), icon16x16: iconRef };
    }
    raw.content = { ...raw.content, chapters };
    await putContent(raw);
  });

  ipc.handle("icons:listPublic", async (): Promise<Array<{ displayIconId: string; mediaId: string; title: string; url: string; tags: string[] }>> => {
    const token = await getValidAccessToken();
    if (!token) throw new Error("not signed in");
    const res = await fetch("https://api.yotoplay.com/media/displayIcons/user/yoto", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`icons:listPublic ${res.status}`);
    const data = (await res.json()) as { displayIcons?: Array<Record<string, unknown>> };
    const mapped = (data.displayIcons ?? []).map((i) => ({
      displayIconId: String(i.displayIconId ?? ""),
      mediaId: String(i.mediaId ?? ""),
      title: String(i.title ?? ""),
      url: String(i.url ?? ""),
      tags: Array.isArray(i.publicTags) ? (i.publicTags as string[]) : [],
    }));
    try {
      const dir = path.join(app.getPath("userData"), "debug");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "public-icons.json"),
        JSON.stringify({ count: mapped.length, icons: mapped }, null, 2)
      );
    } catch {}
    return mapped;
  });

  ipc.handle("icons:listUser", async (): Promise<Array<{ displayIconId: string; mediaId: string; url: string }>> => {
    const token = await getValidAccessToken();
    if (!token) throw new Error("not signed in");
    const res = await fetch("https://api.yotoplay.com/media/displayIcons/user/me", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`icons:listUser ${res.status}`);
    const data = (await res.json()) as { displayIcons?: Array<Record<string, unknown>> };
    return (data.displayIcons ?? []).map((i) => ({
      displayIconId: String(i.displayIconId ?? ""),
      mediaId: String(i.mediaId ?? ""),
      url: typeof i.url === "string" ? i.url : "",
    }));
  });

  ipc.handle(
    "icons:semanticMatch",
    async (
      _e,
      titles: string[],
      icons: Array<{ mediaId: string; title: string; url: string; tags: string[] }>,
      threshold?: number
    ) => {
      const { matchTitles } = await import("./semantics.js");
      return matchTitles(titles, icons, threshold ?? 0.3);
    }
  );

  ipc.handle("icons:upload", async (_e, filePath: string): Promise<{ displayIconId: string; mediaId: string; url: string }> => {
    const token = await getValidAccessToken();
    if (!token) throw new Error("not signed in");
    const data = await readFile(filePath);
    const url = new URL("https://api.yotoplay.com/media/displayIcons/user/me/upload");
    url.searchParams.set("autoConvert", "true");
    url.searchParams.set("filename", path.basename(filePath));
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/octet-stream",
      },
      body: data,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`icon upload failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    const result = (await res.json()) as { displayIcon: { displayIconId: string; mediaId: string; url: string | object } };
    return {
      displayIconId: result.displayIcon.displayIconId,
      mediaId: result.displayIcon.mediaId,
      url: typeof result.displayIcon.url === "string" ? result.displayIcon.url : "",
    };
  });

  ipc.handle("playlists:delete", async (_e, cardId: string): Promise<void> => {
    const token = await getValidAccessToken();
    if (!token) throw new Error("not signed in");
    const res = await fetch(`https://api.yotoplay.com/content/${encodeURIComponent(cardId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`delete failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    cache.delete(cardId);
  });

  ipc.handle(
    "playlists:appendTracks",
    async (
      _e,
      cardId: string,
      newTracks: Array<{
        title: string;
        trackSha256: string;
        durationSec?: number;
        fileSize?: number;
        iconRef?: string;
        format?: string;
        channels?: string;
      }>
    ): Promise<void> => {
      const raw = cache.get(cardId);
      if (!raw) throw new Error("playlist not loaded yet — open it first");
      const oldChapters = (raw.content.chapters as Array<Record<string, unknown>> | undefined) ?? [];
      const startIndex = oldChapters.length;
      const appended = newTracks.map((t, i) =>
        buildChapterShape({
          index: startIndex + i,
          title: t.title,
          trackUrl: `yoto:#${t.trackSha256}`,
          durationSec: t.durationSec,
          fileSize: t.fileSize,
          iconRef: t.iconRef,
          format: t.format,
          channels: t.channels,
        })
      );
      const allChapters = [...oldChapters, ...appended];
      raw.content = { ...raw.content, chapters: allChapters, playbackType: "linear" };
      const totalDuration = allChapters.reduce((n, c) => n + ((c.duration as number | undefined) ?? 0), 0);
      const totalFileSize = allChapters.reduce((n, c) => n + ((c.fileSize as number | undefined) ?? 0), 0);
      raw.metadata = {
        ...raw.metadata,
        media: { duration: totalDuration, fileSize: totalFileSize },
      };
      await putContent(raw);
    }
  );

  ipc.handle("playlists:repair", async (_e, cardId: string): Promise<void> => {
    const raw = cache.get(cardId);
    if (!raw) throw new Error("playlist not loaded yet — open it first");
    // Fetch playable URLs so we can detect each track's actual format from Content-Type
    let playableTracks: Array<{ trackUrl?: string }> = [];
    try {
      const playable = (await getJson(`/content/${encodeURIComponent(cardId)}?playable=true`)) as
        & { card?: { content?: { chapters?: Array<{ tracks?: Array<{ trackUrl?: string }> }> } } }
        & Record<string, unknown>;
      const card = (playable.card ?? playable) as { content?: { chapters?: Array<{ tracks?: Array<{ trackUrl?: string }> }> } };
      const chapters = card.content?.chapters ?? [];
      playableTracks = chapters.map((c) => c.tracks?.[0] ?? {});
    } catch {}
    const oldChapters = (raw.content.chapters as Array<Record<string, unknown>> | undefined) ?? [];
    const newChapters = await Promise.all(oldChapters.map(async (ch, i) => {
      const tracksRaw = (ch.tracks as Array<Record<string, unknown>> | undefined) ?? [];
      const t = tracksRaw[0];
      const trackUrl = String(t?.trackUrl ?? "");
      if (!trackUrl) throw new Error(`chapter ${i + 1} has no trackUrl — can't repair`);
      const chDisplay = ch.display as { icon16x16?: string } | undefined;
      const tDisplay = t?.display as { icon16x16?: string } | undefined;
      const existingUid = typeof t?.uid === "string" ? t.uid : undefined;
      const existingChannels = typeof t?.channels === "string" ? t.channels : undefined;
      // Detect actual format from the playable URL's Content-Type
      // Yoto's transcoder typically outputs Opus inside Ogg (audio/ogg), but old playlists
      // were stored with format "aac". Mismatch → player can't decode → skip.
      let detectedFormat: string | undefined;
      try {
        const playableTrack = playableTracks[i];
        if (playableTrack?.trackUrl) {
          const u = playableTrack.trackUrl.split("#")[0];
          const headRes = await fetch(u, { method: "GET", headers: { range: "bytes=0-3" } });
          const ct = headRes.headers.get("content-type") || "";
          if (ct.includes("ogg")) detectedFormat = "opus";
          else if (ct.includes("mp4") || ct.includes("aac")) detectedFormat = "aac";
        }
      } catch {}
      return buildChapterShape({
        index: i,
        title: String(ch.title ?? t?.title ?? `Track ${i + 1}`),
        trackUrl,
        durationSec: typeof ch.duration === "number" ? ch.duration : (typeof t?.duration === "number" ? t.duration : undefined),
        fileSize: typeof ch.fileSize === "number" ? ch.fileSize : (typeof t?.fileSize === "number" ? t.fileSize : undefined),
        iconRef: chDisplay?.icon16x16 || tDisplay?.icon16x16,
        trackUid: existingUid,
        format: detectedFormat,
        channels: existingChannels,
      });
    }));
    raw.content = {
      ...raw.content,
      chapters: newChapters,
      config: { resumeTimeout: 2592000, ...(raw.content.config as Record<string, unknown> ?? {}) },
      hidden: false,
      playbackType: "linear",
      activity: "yoto_Player",
      version: "1",
      restricted: true,
    };
    const totalDuration = newChapters.reduce((n, c) => n + ((c.duration as number | undefined) ?? 0), 0);
    const totalFileSize = newChapters.reduce((n, c) => n + ((c.fileSize as number | undefined) ?? 0), 0);
    raw.metadata = {
      ...raw.metadata,
      title: raw.title,
      hidden: false,
      media: { duration: totalDuration, fileSize: totalFileSize },
      authors: (raw.metadata.authors as unknown[] | undefined) ?? [],
      narrators: (raw.metadata.narrators as unknown[] | undefined) ?? [],
      copyrights: (raw.metadata.copyrights as unknown[] | undefined) ?? [],
      accents: (raw.metadata.accents as unknown[] | undefined) ?? [],
      abridged: (raw.metadata.abridged as boolean | undefined) ?? false,
    };
    await putContent(raw);
  });

  ipc.handle("playlists:reorder", async (_e, cardId: string, chapterKeys: string[]): Promise<void> => {
    const raw = cache.get(cardId);
    if (!raw) throw new Error("playlist not loaded yet");
    const chapters = (raw.content.chapters as Array<Record<string, unknown>> | undefined) ?? [];
    const byKey = new Map(chapters.map((ch) => [String(ch.key ?? ""), ch]));
    if (byKey.size !== chapters.length) throw new Error("can't reorder: chapters missing keys");
    const reordered = chapterKeys.map((k) => {
      const ch = byKey.get(k);
      if (!ch) throw new Error(`unknown chapter key: ${k}`);
      return ch;
    });
    if (reordered.length !== chapters.length) throw new Error("reorder must include all chapters");
    raw.content = { ...raw.content, chapters: reordered };
    await putContent(raw);
  });

  ipc.handle(
    "playlists:setTitles",
    async (_e, cardId: string, updates: Array<{ chapterIndex: number; title: string }>): Promise<void> => {
      const raw = cache.get(cardId);
      if (!raw) throw new Error("playlist not loaded yet");
      const chapters = (raw.content.chapters as Array<Record<string, unknown>> | undefined) ?? [];
      for (const u of updates) {
        const ch = chapters[u.chapterIndex];
        if (!ch) continue;
        ch.title = u.title;
        // Single-track chapters display the TRACK's title in the UI (see rowTitle in the
        // renderer), so that has to be kept in sync too or the cleanup won't visibly stick.
        const tracks = (ch.tracks as Array<Record<string, unknown>> | undefined) ?? [];
        if (tracks.length === 1) tracks[0].title = u.title;
      }
      raw.content = { ...raw.content, chapters };
      await putContent(raw);
    }
  );

  ipc.handle("playlists:deleteChapter", async (_e, cardId: string, chapterKey: string): Promise<void> => {
    const raw = cache.get(cardId);
    if (!raw) throw new Error("playlist not loaded yet");
    const chapters = (raw.content.chapters as Array<Record<string, unknown>> | undefined) ?? [];
    const remaining = chapters.filter((ch) => String(ch.key ?? "") !== chapterKey);
    if (remaining.length === chapters.length) throw new Error(`unknown chapter key: ${chapterKey}`);
    if (remaining.length === 0) throw new Error("can't delete the last track — delete the whole playlist instead");
    raw.content = { ...raw.content, chapters: remaining };
    await putContent(raw);
  });
}
