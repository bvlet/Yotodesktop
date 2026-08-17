import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { app, BrowserWindow, dialog } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

// Real card-size raster art for a playlist: fetch/compose an image with the title (and
// optionally artist) baked directly onto it, so the result can be set as the playlist's
// actual Yoto cover — not just something drawn at print time. This is the in-app version of
// the "make a nice card image" routine, so once generated here the existing print/sticker
// step (stickers.ts) just needs to lay out whatever cover image is already on the playlist.
//
// Two styles: "photo" (cover-crop a real image — official art, a generic photo, or a picked
// file — with the title baked over a blurred/scrimmed band), and "illustrated" (no photo at
// all: a generated gradient-and-cassette-tape design with the actual tracklist printed on the
// tape label) — for homemade mixtapes/compilations that have no real cover to find.

// Standard credit-card size (ISO/IEC 7810 ID-1), portrait — matches a MYO NFC card, rendered
// at 300 DPI so the result is sharp enough to print, not just to view on screen.
const DPI = 300;
const CARD_W_PX = Math.round((53.98 / 25.4) * DPI); // 637
const CARD_H_PX = Math.round((85.6 / 25.4) * DPI); // 1011

export interface ImageSearchResult {
  url: string;
  thumbUrl: string;
  title: string;
  source: string;
}

export interface CardArtComposeInput {
  title: string;
  artist?: string;
  // "photo" (default) needs imageUrl or imagePath. "illustrated" needs neither — it draws a
  // generated gradient + cassette-tape design instead, using `tracks` for the tape label.
  style?: "photo" | "illustrated";
  imageUrl?: string;
  imagePath?: string;
  tracks?: string[];
  // Bumped by the caller to get a different gradient/decoration pick for "illustrated" —
  // same title otherwise produces the same deterministic result, so this is the "shuffle".
  variant?: number;
  // Manual crop adjustment for "photo" style, so a bad automatic crop (a face or a line of
  // text cut off) can be nudged by hand instead of just re-rolling a different source image.
  // zoom: 1 = the minimal "cover" scale (no manual zoom); up to ~2.5. panX/panY: -1..1, 0 is
  // centered — panY defaults to a slight top bias (-0.6) matching the old fixed crop so
  // untouched sliders reproduce the previous behavior.
  zoom?: number;
  panX?: number;
  panY?: number;
  // "photo" style only. Defaults to true (bake the title/artist over a blurred/scrimmed
  // band, as before). Set to false when the cover art is clear/legible enough on its own —
  // skips the text entirely, and with it the blur band and scrim, so the card is just the
  // cropped cover art untouched.
  showTitle?: boolean;
}

export interface CardArtComposeResult {
  ok: boolean;
  dataUrl?: string;
  error?: string;
}

export interface CardArtSaveResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
}

// Looks up real official cover art via the iTunes Search API — free, keyless, no auth
// needed. This is the automatic stand-in for the manual "search Spotify/Apple Music in a
// browser" step of the original routine. A plain music/album search misses a lot of what
// actually ends up on a Yoto card — a kids' show soundtrack, an audio drama, a podcast — so
// this tries several media types in parallel and merges whatever comes back, rather than
// assuming everything is a music album.
const ITUNES_SEARCHES: Array<{ media: string; entity: string; label: string }> = [
  { media: "music", entity: "album", label: "Apple Music" },
  { media: "audiobook", entity: "audiobook", label: "Apple Books (luisterboek)" },
  { media: "podcast", entity: "podcast", label: "Apple Podcasts" },
  { media: "tvShow", entity: "tvSeason", label: "Apple TV" },
];

async function searchOfficialCoverArt(query: string): Promise<ImageSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const batches = await Promise.all(
    ITUNES_SEARCHES.map(async ({ media, entity, label }) => {
      try {
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=${media}&entity=${entity}&limit=5`;
        const res = await fetch(url, { headers: { "user-agent": "desktop-for-yoto/card-art (personal use)" } });
        if (!res.ok) return [];
        const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
        return (data.results ?? []).map((r) => ({ r, label }));
      } catch {
        return [];
      }
    })
  );
  const seen = new Set<string>();
  const out: ImageSearchResult[] = [];
  for (const batch of batches) {
    for (const { r, label } of batch) {
      const artwork100 = typeof r.artworkUrl100 === "string" ? r.artworkUrl100 : "";
      if (!artwork100 || seen.has(artwork100)) continue;
      seen.add(artwork100);
      // iTunes artwork URLs encode the requested size in the filename — swap it up to a
      // print-usable resolution instead of the 100x100 thumbnail the API returns by default.
      const artworkBig = artwork100.replace(/\/\d+x\d+bb\.(jpg|jpeg|png)$/i, "/1200x1200bb.$1");
      const name =
        typeof r.collectionName === "string" ? r.collectionName :
        typeof r.trackName === "string" ? r.trackName :
        "";
      const artistName = typeof r.artistName === "string" ? r.artistName : "";
      out.push({
        url: artworkBig,
        thumbUrl: artwork100,
        title: [name, artistName].filter(Boolean).join(" — ") || q,
        source: label,
      });
    }
  }
  return out.slice(0, 16);
}

// Looks up real book/audiobook ("luisterboek") cover art via the Google Books API — free,
// keyless (within reasonable personal use), and this is where most Dutch/Flemish children's
// picture-book and luisterboek covers actually live, since a lot of that content simply
// isn't in Apple's music/podcast catalog at all.
async function searchBookCovers(query: string): Promise<ImageSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=10`;
    const res = await fetch(url, { headers: { "user-agent": "desktop-for-yoto/card-art (personal use)" } });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
    const out: ImageSearchResult[] = [];
    for (const item of data.items ?? []) {
      const volumeInfo = (item.volumeInfo as Record<string, unknown>) ?? {};
      const imageLinks = (volumeInfo.imageLinks as Record<string, unknown>) ?? {};
      const rawThumb =
        typeof imageLinks.thumbnail === "string" ? imageLinks.thumbnail :
        typeof imageLinks.smallThumbnail === "string" ? imageLinks.smallThumbnail :
        "";
      if (!rawThumb) continue;
      // Google Books serves these over http by default and defaults to a low zoom level —
      // force https and ask for a somewhat bigger version for print use.
      const thumb = rawThumb.replace(/^http:/, "https:");
      const bigger = thumb.replace(/([?&])zoom=\d/, "$1zoom=3").replace(/&edge=curl/, "");
      const title = typeof volumeInfo.title === "string" ? volumeInfo.title : q;
      const authors = Array.isArray(volumeInfo.authors) ? (volumeInfo.authors as string[]).join(", ") : "";
      out.push({
        url: bigger,
        thumbUrl: thumb,
        title: [title, authors].filter(Boolean).join(" — "),
        source: "Google Books",
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function resolveImageDataUrl(input: CardArtComposeInput): Promise<string> {
  if (input.imagePath) {
    const bytes = await readFile(input.imagePath);
    const ext = path.extname(input.imagePath).toLowerCase();
    const mime =
      ext === ".png" ? "image/png" :
      ext === ".webp" ? "image/webp" :
      ext === ".gif" ? "image/gif" :
      ext === ".bmp" ? "image/bmp" :
      "image/jpeg";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }
  if (input.imageUrl) {
    const res = await fetch(input.imageUrl);
    if (!res.ok) throw new Error(`kon afbeelding niet ophalen (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }
  throw new Error("geen afbeelding opgegeven");
}

// Builds the script run inside a hidden renderer window to do the actual compositing.
// pdf-lib (used for the printable sheet) can only draw vector shapes — it has no way to blur
// a bitmap or measure text against a real font. A hidden BrowserWindow gives us Chromium's
// own <canvas> 2D context instead: real font metrics for wrapping/shrink-to-fit, a real
// `blur()` filter for the photo style's feathered band, and enough drawing primitives
// (gradients, rounded rects, arcs) to build the illustrated style from scratch — all without
// a new native dependency, just Electron's own rendering engine.
function buildComposeScript(params: {
  style: "photo" | "illustrated";
  imageDataUrl: string | null;
  title: string;
  artist: string;
  tracks: string[];
  variant: number;
  zoom: number;
  panX: number;
  panY: number;
  showTitle: boolean;
}): string {
  const styleJson = JSON.stringify(params.style);
  const imageDataUrlJson = JSON.stringify(params.imageDataUrl);
  const titleJson = JSON.stringify(params.title);
  const artistJson = JSON.stringify(params.artist);
  const tracksJson = JSON.stringify(params.tracks);
  const variantJson = JSON.stringify(params.variant);
  const zoomJson = JSON.stringify(params.zoom);
  const panXJson = JSON.stringify(params.panX);
  const panYJson = JSON.stringify(params.panY);
  const showTitleJson = JSON.stringify(params.showTitle);
  return `
(async () => {
  const CARD_W = ${CARD_W_PX};
  const CARD_H = ${CARD_H_PX};
  const style = ${styleJson};
  const imageDataUrl = ${imageDataUrlJson};
  const title = ${titleJson};
  const artist = ${artistJson};
  const tracks = ${tracksJson};
  const variant = ${variantJson};
  const zoomIn = ${zoomJson};
  const panXIn = ${panXJson};
  const panYIn = ${panYJson};
  const showTitle = ${showTitleJson};

  if (!title) throw new Error("geen titel opgegeven");

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("kon afbeelding niet decoderen"));
      img.src = src;
    });
  }

  function wrapText(ctx, text, maxWidth) {
    const words = text.split(/\\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const word of words) {
      const trial = cur ? cur + " " + word : word;
      if (ctx.measureText(trial).width <= maxWidth || !cur) {
        cur = trial;
      } else {
        lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function truncateLineToWidth(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let out = text;
    while (out.length > 1 && ctx.measureText(out + "…").width > maxWidth) {
      out = out.slice(0, -1);
    }
    return out.length > 1 ? out + "…" : out;
  }

  function fitText(ctx, text, maxWidth, maxSize, minSize, maxLines, weight) {
    // wrapText only ever refuses to ADD a word to a non-empty line — a single word that's
    // wider than maxWidth all on its own (a long compound Dutch word, say) still gets placed
    // on its own line unchanged. Checking line COUNT alone therefore isn't enough to know the
    // text actually fits: this also has to measure the widest resulting line at each size and
    // keep shrinking until every line is actually within maxWidth, not just few enough of them.
    let size = maxSize;
    let lines = null;
    while (size > minSize) {
      ctx.font = weight + " " + Math.round(size) + "px 'Helvetica Neue', Arial, sans-serif";
      const candidate = wrapText(ctx, text, maxWidth);
      const widest = candidate.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
      if (candidate.length <= maxLines && widest <= maxWidth) {
        lines = candidate;
        break;
      }
      size -= 1;
    }
    if (!lines) {
      size = minSize;
      ctx.font = weight + " " + Math.round(size) + "px 'Helvetica Neue', Arial, sans-serif";
      lines = wrapText(ctx, text, maxWidth).slice(0, maxLines);
    }
    // Last-resort safety net: even at the floor size a single very long token can still
    // overflow — clip it with an ellipsis rather than let it run off the edge of the card.
    ctx.font = weight + " " + Math.round(size) + "px 'Helvetica Neue', Arial, sans-serif";
    lines = lines.map((l) => truncateLineToWidth(ctx, l, maxWidth));
    return { size, lines };
  }

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Deterministic per (title, variant) so re-opening the modal for the same playlist gives
  // the same look, but clicking "Vernieuw voorbeeld" (which bumps variant) reshuffles it.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");

  if (style === "illustrated") {
    const seed = hashStr(title + "|" + variant);
    const rnd = mulberry32(seed);

    const gradients = [
      ["#ff6a88", "#ffb56b"],
      ["#6a11cb", "#2575fc"],
      ["#11998e", "#38ef7d"],
      ["#ee0979", "#ff6a00"],
      ["#4568dc", "#b06ab3"],
      ["#f857a6", "#ff5858"],
      ["#ff9a44", "#fc6076"],
    ];
    const labelColors = ["#8ecae6", "#ffd166", "#ef476f", "#06d6a0", "#c9a0ff", "#f4a261"];
    const g = gradients[seed % gradients.length];
    const labelColor = labelColors[Math.floor(seed / 7) % labelColors.length];

    // 1) Gradient background
    const bgGrad = ctx.createLinearGradient(0, 0, 0, CARD_H);
    bgGrad.addColorStop(0, g[0]);
    bgGrad.addColorStop(1, g[1]);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // 2) Decorative confetti dots scattered in the upper half — deterministic per seed.
    for (let i = 0; i < 16; i++) {
      const cx = rnd() * CARD_W;
      const cy = rnd() * CARD_H * 0.46;
      const r = CARD_W * (0.006 + rnd() * 0.013);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255," + (0.25 + rnd() * 0.35).toFixed(2) + ")";
      ctx.fill();
    }

    // 3) Small decorative dash near the top-left, echoing a "notch" detail.
    ctx.fillStyle = "rgba(20,20,20,0.85)";
    ctx.beginPath();
    ctx.roundRect(CARD_W * 0.065, CARD_H * 0.032, CARD_W * 0.14, CARD_H * 0.011, CARD_H * 0.006);
    ctx.fill();

    // 4) Title (bold, large) + optional subtitle (artist field).
    const MARGIN = CARD_W * 0.09;
    const maxTextWidth = CARD_W - MARGIN * 2;
    const headFit = fitText(ctx, title, maxTextWidth, CARD_W * 0.16, CARD_W * 0.085, 3, "800");
    let y = CARD_H * 0.1 + headFit.size * 0.85;
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "rgba(0,0,0,0.18)";
    ctx.shadowBlur = CARD_W * 0.01;
    ctx.font = "800 " + Math.round(headFit.size) + "px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillStyle = "#ffffff";
    for (const line of headFit.lines) {
      ctx.fillText(line, MARGIN, y);
      y += headFit.size * 1.12;
    }
    if (artist && artist.trim()) {
      const subFit = fitText(ctx, artist.trim(), maxTextWidth, CARD_W * 0.075, CARD_W * 0.05, 2, "600");
      y += subFit.size * 0.35;
      ctx.font = "600 " + Math.round(subFit.size) + "px 'Helvetica Neue', Arial, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      for (const line of subFit.lines) {
        ctx.fillText(line, MARGIN, y);
        y += subFit.size * 1.25;
      }
    }
    ctx.shadowBlur = 0;

    // 5) Cassette-tape illustration in the lower ~46% of the card, with the real tracklist
    // printed on its label — no stock photo needed at all.
    const capeTop = CARD_H * 0.52;
    const capeH = CARD_H * 0.42;
    const capeX = CARD_W * 0.08;
    const capeW = CARD_W - capeX * 2;
    const capeR = CARD_W * 0.045;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = CARD_W * 0.02;
    ctx.shadowOffsetY = CARD_W * 0.01;
    ctx.fillStyle = "#faf6ee";
    ctx.beginPath();
    ctx.roundRect(capeX, capeTop, capeW, capeH, capeR);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = Math.max(1.5, CARD_W * 0.004);
    ctx.strokeStyle = "rgba(20,20,20,0.85)";
    ctx.beginPath();
    ctx.roundRect(capeX, capeTop, capeW, capeH, capeR);
    ctx.stroke();

    // Corner screws
    const screwR = CARD_W * 0.011;
    const screwInset = CARD_W * 0.045;
    const screwPositions = [
      [capeX + screwInset, capeTop + screwInset],
      [capeX + capeW - screwInset, capeTop + screwInset],
      [capeX + screwInset, capeTop + capeH - screwInset],
      [capeX + capeW - screwInset, capeTop + capeH - screwInset],
    ];
    for (const pos of screwPositions) {
      ctx.beginPath();
      ctx.arc(pos[0], pos[1], screwR, 0, Math.PI * 2);
      ctx.fillStyle = "#faf6ee";
      ctx.fill();
      ctx.stroke();
    }

    // Label window with the tracklist
    const labelX = capeX + capeW * 0.09;
    const labelY = capeTop + capeH * 0.09;
    const labelW = capeW * 0.82;
    const labelH = capeH * 0.5;
    ctx.fillStyle = labelColor;
    ctx.beginPath();
    ctx.roundRect(labelX, labelY, labelW, labelH, CARD_W * 0.02);
    ctx.fill();
    ctx.stroke();

    const headingSize = CARD_W * 0.05;
    ctx.fillStyle = "#1a1a1a";
    ctx.font = "800 " + Math.round(headingSize) + "px 'Helvetica Neue', Arial, sans-serif";
    const trackPad = labelW * 0.09;
    let ty = labelY + labelH * 0.2;
    ctx.fillText("Tracklist", labelX + trackPad, ty);
    ty += headingSize * 1.2;

    const trackFontSize = CARD_W * 0.032;
    ctx.font = "600 " + Math.round(trackFontSize) + "px 'Helvetica Neue', Arial, sans-serif";
    const maxTrackWidth = labelW - trackPad * 2 - CARD_W * 0.025;
    const lineGap = trackFontSize * 1.42;
    const availableH = labelY + labelH - CARD_W * 0.02 - ty;
    const maxTracks = Math.max(1, Math.floor(availableH / lineGap));
    const shown = tracks.slice(0, maxTracks);
    const extra = tracks.length - shown.length;
    for (let i = 0; i < shown.length; i++) {
      let t = shown[i];
      while (t.length > 1 && ctx.measureText(t).width > maxTrackWidth) t = t.slice(0, -1);
      if (t.length < shown[i].length) t = t.replace(/\\s+\\S*$/, "") + "…";
      ctx.beginPath();
      ctx.arc(labelX + trackPad + CARD_W * 0.006, ty - trackFontSize * 0.32, CARD_W * 0.007, 0, Math.PI * 2);
      ctx.fillStyle = "#1a1a1a";
      ctx.fill();
      ctx.fillText(t, labelX + trackPad + CARD_W * 0.022, ty);
      ty += lineGap;
    }
    if (extra > 0 && shown.length > 0) {
      ctx.font = "600 italic " + Math.round(trackFontSize * 0.9) + "px 'Helvetica Neue', Arial, sans-serif";
      ctx.fillText("+" + extra + " meer…", labelX + trackPad + CARD_W * 0.022, ty);
    }

    // Reels
    const reelY = capeTop + capeH * 0.78;
    const reelR = capeH * 0.14;
    const reelXOffset = capeW * 0.24;
    const leftReelX = capeX + capeW / 2 - reelXOffset;
    const rightReelX = capeX + capeW / 2 + reelXOffset;

    ctx.strokeStyle = "rgba(20,20,20,0.85)";
    ctx.lineWidth = Math.max(1.5, CARD_W * 0.006);
    ctx.beginPath();
    ctx.moveTo(leftReelX, reelY);
    ctx.lineTo(rightReelX, reelY);
    ctx.stroke();

    for (const rx of [leftReelX, rightReelX]) {
      ctx.beginPath();
      ctx.arc(rx, reelY, reelR, 0, Math.PI * 2);
      ctx.fillStyle = "#1a1a1a";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(rx, reelY, reelR * 0.38, 0, Math.PI * 2);
      ctx.fillStyle = "#faf6ee";
      ctx.fill();
      for (let s = 0; s < 6; s++) {
        const ang = (s / 6) * Math.PI * 2;
        const hx = rx + Math.cos(ang) * reelR * 0.68;
        const hy = reelY + Math.sin(ang) * reelR * 0.68;
        ctx.beginPath();
        ctx.arc(hx, hy, reelR * 0.09, 0, Math.PI * 2);
        ctx.fillStyle = "#faf6ee";
        ctx.fill();
      }
    }

    return canvas.toDataURL("image/png");
  }

  // --- "photo" style ------------------------------------------------------
  if (!imageDataUrl) throw new Error("geen afbeelding opgegeven");
  const img = await loadImage(imageDataUrl);
  if (!img.width || !img.height) throw new Error("afbeelding heeft geen afmetingen");

  // 1) Full-bleed cover-crop background. Scaled to cover the whole card, then cropped.
  // zoom (>=1) magnifies past the minimal "cover" scale; panX/panY (-1..1, 0 = centered)
  // slide the visible window within whatever overflow that zoom creates — -1 shows the
  // left/top edge, 1 shows the right/bottom edge. Untouched, these default to a slight
  // top bias (panY -0.6) matching the old fixed crop, so a manual nudge is the exception,
  // not something every card needs — for when a face or line of text got cut off.
  const zoom = Math.max(1, Math.min(2.5, Number.isFinite(zoomIn) ? zoomIn : 1));
  const panX = Math.max(-1, Math.min(1, Number.isFinite(panXIn) ? panXIn : 0));
  const panY = Math.max(-1, Math.min(1, Number.isFinite(panYIn) ? panYIn : -0.6));
  const baseScale = Math.max(CARD_W / img.width, CARD_H / img.height);
  const scale = baseScale * zoom;
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const overflowX = Math.max(0, drawW - CARD_W);
  const overflowY = Math.max(0, drawH - CARD_H);
  const dx = -(overflowX / 2) * (1 + panX);
  const dy = -(overflowY / 2) * (1 + panY);
  ctx.drawImage(img, dx, dy, drawW, drawH);

  // When the cover art is clear/legible enough on its own, skip the baked title entirely —
  // and with it the blur band and scrim that only exist to make that text readable. The
  // card is then just the cropped cover art, untouched.
  if (showTitle) {
    // 2) Lay out the text FIRST — title (bold, up to 3 lines) and optional artist (up to 1
    // line) — so the blur/scrim band below is sized to what's actually being drawn rather
    // than a fixed guess. This was the fix that made the earlier print-time version look
    // right: a band sized to the text, not a blanket blur over the whole top half.
    const MARGIN = CARD_W * 0.09;
    const maxTextWidth = CARD_W - MARGIN * 2;
    const titleFit = fitText(ctx, title, maxTextWidth, CARD_W * 0.145, CARD_W * 0.075, 3, "700");
    let artistFit = null;
    if (artist && artist.trim()) {
      artistFit = fitText(ctx, artist.trim(), maxTextWidth, CARD_W * 0.075, CARD_W * 0.05, 1, "500");
    }
    const titleLineH = titleFit.size * 1.18;
    const artistLineH = artistFit ? artistFit.size * 1.3 : 0;
    const textBlockH = titleFit.lines.length * titleLineH + (artistFit ? artistLineH + titleFit.size * 0.25 : 0);
    const bandH = Math.min(CARD_H * 0.62, MARGIN * 2 + textBlockH * 1.35);

    // 3) Blur only that tight band, feathered so it fades back to the sharp image rather than
    // ending in a hard line. Drawn onto an offscreen canvas so the feather mask (a gradient
    // composited with destination-in) doesn't affect the rest of the card.
    const blurCanvas = document.createElement("canvas");
    blurCanvas.width = CARD_W;
    blurCanvas.height = Math.ceil(bandH + 40);
    const bctx = blurCanvas.getContext("2d");
    bctx.filter = "blur(" + Math.round(CARD_W * 0.035) + "px)";
    bctx.drawImage(canvas, 0, 0, CARD_W, blurCanvas.height, -20, -20, CARD_W + 40, blurCanvas.height + 40);
    bctx.filter = "none";
    const feather = bctx.createLinearGradient(0, 0, 0, blurCanvas.height);
    feather.addColorStop(0, "rgba(0,0,0,1)");
    feather.addColorStop(0.78, "rgba(0,0,0,1)");
    feather.addColorStop(1, "rgba(0,0,0,0)");
    bctx.globalCompositeOperation = "destination-in";
    bctx.fillStyle = feather;
    bctx.fillRect(0, 0, CARD_W, blurCanvas.height);
    bctx.globalCompositeOperation = "source-over";
    ctx.drawImage(blurCanvas, 0, 0);

    // 4) Dark gradient scrim over the blurred band for contrast, independent of how light or
    // dark the source art is.
    const scrim = ctx.createLinearGradient(0, 0, 0, bandH);
    scrim.addColorStop(0, "rgba(8,8,12,0.82)");
    scrim.addColorStop(0.7, "rgba(8,8,12,0.55)");
    scrim.addColorStop(1, "rgba(8,8,12,0)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, CARD_W, bandH);

    // 5) Title (bold, white) then artist (smaller, light gray) underneath, with a soft shadow
    // for legibility over busy art.
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = CARD_W * 0.015;
    let y2 = MARGIN + titleFit.size * 0.9;
    ctx.font = "700 " + Math.round(titleFit.size) + "px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillStyle = "#ffffff";
    for (const line of titleFit.lines) {
      ctx.fillText(line, MARGIN, y2);
      y2 += titleLineH;
    }
    if (artistFit) {
      y2 += titleFit.size * 0.25;
      ctx.font = "500 " + Math.round(artistFit.size) + "px 'Helvetica Neue', Arial, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      for (const line of artistFit.lines) {
        ctx.fillText(line, MARGIN, y2);
        y2 += artistLineH;
      }
    }
    ctx.shadowBlur = 0;
  }

  return canvas.toDataURL("image/png");
})()
`;
}

async function composeCardArt(input: CardArtComposeInput): Promise<CardArtComposeResult> {
  let win: BrowserWindow | null = null;
  try {
    const style: "photo" | "illustrated" = input.style === "illustrated" ? "illustrated" : "photo";
    const imageDataUrl = style === "photo" ? await resolveImageDataUrl(input) : null;
    win = new BrowserWindow({
      show: false,
      width: CARD_W_PX,
      height: CARD_H_PX,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    await win.loadURL("data:text/html;charset=utf-8,<!doctype html><html><body></body></html>");
    const script = buildComposeScript({
      style,
      imageDataUrl,
      title: (input.title || "").trim(),
      artist: (input.artist || "").trim(),
      tracks: (input.tracks ?? []).filter((t) => typeof t === "string" && t.trim().length > 0).map((t) => t.trim()),
      variant: Number.isFinite(input.variant) ? Number(input.variant) : 0,
      zoom: Number.isFinite(input.zoom) ? Number(input.zoom) : 1,
      panX: Number.isFinite(input.panX) ? Number(input.panX) : 0,
      panY: Number.isFinite(input.panY) ? Number(input.panY) : -0.6,
      showTitle: input.showTitle !== false,
    });
    const dataUrl = (await win.webContents.executeJavaScript(script)) as string;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
      return { ok: false, error: "onverwacht resultaat bij het samenstellen van de afbeelding" };
    }
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

function dataUrlToPngBuffer(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("ongeldige afbeeldingsgegevens");
  return Buffer.from(match[1], "base64");
}

// Writes the composed PNG to a scratch temp file so it can be handed to the existing
// cover-upload flow (window.yoto.cover.upload takes a file path, same as a manually picked
// file) without duplicating that upload logic here.
async function writeTempCardArt(dataUrl: string): Promise<string> {
  const buf = dataUrlToPngBuffer(dataUrl);
  const dir = path.join(app.getPath("temp"), "desktop-for-yoto-card-art");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `card-${Date.now()}-${randomBytes(4).toString("hex")}.png`);
  await writeFile(filePath, buf);
  return filePath;
}

async function saveCardArtAs(
  event: IpcMainInvokeEvent,
  dataUrl: string,
  suggestedName: string
): Promise<CardArtSaveResult> {
  const buf = dataUrlToPngBuffer(dataUrl);
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const opts: Electron.SaveDialogOptions = {
    title: "Kaartafbeelding opslaan",
    defaultPath: suggestedName || "kaartafbeelding.png",
    filters: [{ name: "PNG", extensions: ["png"] }],
  };
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  await writeFile(result.filePath, buf);
  return { ok: true, path: result.filePath };
}

export function registerCardArtHandlers(ipc: IpcMain): void {
  ipc.handle("cardart:searchOfficial", async (_e: IpcMainInvokeEvent, query: string): Promise<ImageSearchResult[]> => {
    return searchOfficialCoverArt(query);
  });

  ipc.handle("cardart:searchBooks", async (_e: IpcMainInvokeEvent, query: string): Promise<ImageSearchResult[]> => {
    return searchBookCovers(query);
  });

  ipc.handle("cardart:compose", async (_e: IpcMainInvokeEvent, input: CardArtComposeInput): Promise<CardArtComposeResult> => {
    return composeCardArt(input);
  });

  ipc.handle("cardart:writeTemp", async (_e: IpcMainInvokeEvent, dataUrl: string): Promise<string> => {
    return writeTempCardArt(dataUrl);
  });

  ipc.handle(
    "cardart:saveAs",
    async (event: IpcMainInvokeEvent, dataUrl: string, suggestedName: string): Promise<CardArtSaveResult> => {
      return saveCardArtAs(event, dataUrl, suggestedName);
    }
  );
}
