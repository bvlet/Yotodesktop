import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { dialog, BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from "pdf-lib";

// --- Layout constants -------------------------------------------------
// 1mm in PDF points (72 pt / inch, 25.4mm / inch)
const MM = 72 / 25.4;

const PAGE_W = 210 * MM; // A4 portrait
const PAGE_H = 297 * MM;

// Standard credit-card size (ISO/IEC 7810 ID-1), portrait-oriented — matches a MYO NFC card
// held the way Yoto prints/sells them (taller than wide).
const CARD_W = 53.98 * MM;
const CARD_H = 85.6 * MM;

const MARGIN = 10 * MM;
const GUTTER = 4 * MM;
const LABEL_H = 4.2 * MM; // space reserved above each card for the playlist title
const FOOTER_H = 9 * MM; // extra space reserved at the bottom for the ruler/dimension note
const CORNER_R = 3.18 * MM; // ISO/IEC 7810 ID-1 corner radius — real card corners are rounded, not square

const CELL_W = CARD_W;
const CELL_H = CARD_H + LABEL_H;

const COLS = Math.max(1, Math.floor((PAGE_W - 2 * MARGIN + GUTTER) / (CELL_W + GUTTER)));
const ROWS = Math.max(1, Math.floor((PAGE_H - MARGIN - (MARGIN + FOOTER_H) + GUTTER) / (CELL_H + GUTTER)));
const PER_PAGE = COLS * ROWS;

export interface StickerItem {
  title: string;
  coverUrl?: string;
  // "contain" (default) fits the whole image inside the card, letterboxed if the aspect
  // ratio doesn't match. "cover" scales the image to fill the entire card, cropping the
  // overflow — used for images picked from the online search, since those are usually
  // arbitrary photos rather than Yoto's own (near-square) icon artwork.
  fit?: "contain" | "cover";
}

export interface StickerResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  count?: number;
  skipped?: string[];
}

export interface ImageSearchResult {
  url: string;
  thumbUrl: string;
  title: string;
  source: string;
}

// Suggests up to 3 candidate cover images for a playlist that has none, using Openverse
// (openverse.org) — a free, keyless search API over openly-licensed (CC) images. No API
// key needed, which keeps this a zero-config feature for a personal fork like this one.
async function searchCoverImages(query: string): Promise<ImageSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const apiUrl = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=3&mature=false`;
    const res = await fetch(apiUrl, { headers: { "user-agent": "desktop-for-yoto/sticker-tool (personal use)" } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{ url?: string; thumbnail?: string; title?: string; source?: string }>;
    };
    return (data.results ?? [])
      .filter((r) => !!r.url)
      .slice(0, 3)
      .map((r) => ({
        url: r.url as string,
        thumbUrl: r.thumbnail || (r.url as string),
        title: r.title || q,
        source: r.source || "openverse",
      }));
  } catch {
    return [];
  }
}

function sniffFormat(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  return null;
}

// Reads the EXIF "Orientation" tag out of a JPEG (values 1–8; 1 = normal). Phone/camera
// photos routinely store their pixel data in the sensor's native landscape grid and rely
// on this tag to say "rotate 90/180/270 before showing" — pdf-lib draws raw pixels and
// ignores it entirely, which is exactly the kind of "only part of the card has content"
// look a sideways-stored portrait photo produces. Deliberately defensive: any parsing
// hiccup just falls back to "1" (draw as-is) rather than throwing.
function readJpegExifOrientation(bytes: Uint8Array): number {
  try {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      if (marker === 0xda) break; // start-of-scan — EXIF always appears before this
      const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (marker === 0xe1 && segLen >= 8) {
        const segStart = offset + 4;
        const isExif =
          bytes[segStart] === 0x45 && bytes[segStart + 1] === 0x78 &&
          bytes[segStart + 2] === 0x69 && bytes[segStart + 3] === 0x66;
        if (isExif) {
          const tiffStart = segStart + 6;
          const little = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
          const u16 = (o: number) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
          const u32 = (o: number) =>
            little
              ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
              : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
          const ifd0 = tiffStart + u32(tiffStart + 4);
          if (ifd0 + 2 <= bytes.length) {
            const entryCount = u16(ifd0);
            for (let i = 0; i < entryCount; i++) {
              const entryOffset = ifd0 + 2 + i * 12;
              if (entryOffset + 12 > bytes.length) break;
              if (u16(entryOffset) === 0x0112) {
                const value = u16(entryOffset + 8);
                if (value >= 1 && value <= 8) return value;
              }
            }
          }
        }
        return 1;
      }
      offset += 2 + segLen;
    }
  } catch {
    // fall through to "normal"
  }
  return 1;
}

async function fetchImage(
  url: string | undefined
): Promise<{ bytes: Uint8Array; kind: "png" | "jpg"; orientation: number } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const kind = sniffFormat(bytes);
    if (!kind) return null; // unsupported format (e.g. webp/svg/gif) — caller records as skipped
    const orientation = kind === "jpg" ? readJpegExifOrientation(bytes) : 1;
    return { bytes, kind, orientation };
  } catch {
    return null;
  }
}

// --- Rounded-rectangle cut guide ---------------------------------------
// pdf-lib has no built-in rounded-rectangle primitive, so this builds an SVG path (the
// same syntax page.drawSvgPath() expects) with quarter-circle arcs in the corners. The
// path is defined top-left-origin / y-down, matching SVG convention.
function roundedRectPath(w: number, h: number, r: number): string {
  return [
    `M ${r},0`,
    `L ${w - r},0`,
    `A ${r},${r} 0 0 1 ${w},${r}`,
    `L ${w},${h - r}`,
    `A ${r},${r} 0 0 1 ${w - r},${h}`,
    `L ${r},${h}`,
    `A ${r},${r} 0 0 1 0,${h - r}`,
    `L 0,${r}`,
    `A ${r},${r} 0 0 1 ${r},0`,
    "Z",
  ].join(" ");
}

const CARD_CUT_PATH = roundedRectPath(CARD_W, CARD_H, CORNER_R);

// Four small "wedge" shapes — one per corner — covering exactly the sliver between the
// card's square bounding box and its rounded outline. pdf-lib has no image-clipping
// primitive we can rely on here, so instead the image is drawn as an ordinary square-
// cornered rectangle first, then these wedges are painted white on top to visually punch
// the corners back out to match the rounded cut guide. Same arc geometry as
// roundedRectPath (using `r`), so the rounded boundary lines up with the guide almost
// exactly (top-left origin, y-down).
//
// Two separate knobs, kept deliberately independent:
//  - `r` (arc radius) controls how round the visible image corner looks. This must stay
//    essentially equal to the guide's own radius (CORNER_R) — making it bigger doesn't
//    hide anything extra, it just over-rounds the image relative to the dashed guide, so
//    the white mask visibly eats into the guide line instead of stopping at it.
//  - `overshoot` extends the wedge's OUTER apex diagonally past the true square corner
//    point, out into the blank page margin/gutter beyond the card. That's safe to be
//    generous with (it's blank space, never touching the rounded image content), and it's
//    what actually swallows any hairline sharp-corner artifact right at the square corner
//    (antialiasing, rounding, whatever) that a pure radius tweak can't reach without also
//    over-rounding the visible curve.
function cornerWedgePaths(w: number, h: number, r: number, overshoot: number): string[] {
  const o = overshoot;
  return [
    `M ${w + o},${-o} L ${w - r},0 A ${r},${r} 0 0 1 ${w},${r} Z`, // top-right
    `M ${w + o},${h + o} L ${w},${h - r} A ${r},${r} 0 0 1 ${w - r},${h} Z`, // bottom-right
    `M ${-o},${h + o} L ${r},${h} A ${r},${r} 0 0 1 0,${h - r} Z`, // bottom-left
    `M ${-o},${-o} L 0,${r} A ${r},${r} 0 0 1 ${r},0 Z`, // top-left
  ];
}

const CARD_CORNER_WEDGES = cornerWedgePaths(CARD_W, CARD_H, CORNER_R + 0.4, 2.5);

function truncateToWidth(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(out + "…", size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + "…";
}

// A 50mm ruler + explicit dimensions printed on every page, so you can check with an
// actual ruler after printing that the page came out at 100% scale (many print dialogs
// default to "fit to page", which silently shrinks everything and would make the cut-out
// stickers smaller than a real card).
function drawPageFooter(page: PDFPage, font: PDFFont): void {
  const rulerMm = 50;
  const rulerX = MARGIN;
  const rulerY = MARGIN * 0.6;

  page.drawLine({
    start: { x: rulerX, y: rulerY },
    end: { x: rulerX + rulerMm * MM, y: rulerY },
    thickness: 1,
    color: rgb(0.25, 0.25, 0.25),
  });
  for (let mm = 0; mm <= rulerMm; mm += 10) {
    const x = rulerX + mm * MM;
    const tickH = mm % 50 === 0 ? 4 : 2.5;
    page.drawLine({
      start: { x, y: rulerY },
      end: { x, y: rulerY + tickH },
      thickness: 0.75,
      color: rgb(0.25, 0.25, 0.25),
    });
  }

  const label =
    "Liniaal 0–50 mm — controleer na printen. Print op 100% / \"werkelijke grootte\" (niet \"aan pagina aanpassen\"). Stickerformaat: 53,98 × 85,6 mm (breed × hoog).";
  page.drawText(label, {
    x: rulerX,
    y: rulerY - 8,
    size: 6.5,
    font,
    color: rgb(0.45, 0.45, 0.45),
  });
}

type EmbeddedImage = { embedded: Awaited<ReturnType<PDFDocument["embedPng"]>>; width: number; height: number; orientation: number };

// Draws `image` fitted into the (cellX..cellX+CARD_W, cardBottomY..cardBottomY+CARD_H) box,
// correcting for JPEG EXIF orientation (pdf-lib draws raw pixels and ignores that tag).
// For a 90°-rotated photo (orientation 6/8), pdf-lib's `rotate` pivots the box around its
// own (x, y) anchor rather than its visual center, so the anchor has to be offset by the
// post-rotation width/height to land the image where we actually want it — see the
// per-orientation cases below. Returns the final on-page visual width/height so the caller
// can mask any "cover" overflow relative to the card bounds.
function drawFittedImage(
  page: PDFPage,
  image: EmbeddedImage,
  cellX: number,
  cardBottomY: number,
  fit: "contain" | "cover"
): { drawW: number; drawH: number } {
  const rotated90 = image.orientation === 6 || image.orientation === 8;
  const effW = rotated90 ? image.height : image.width;
  const effH = rotated90 ? image.width : image.height;

  const scale = fit === "cover" ? Math.max(CARD_W / effW, CARD_H / effH) : Math.min(CARD_W / effW, CARD_H / effH);
  const drawW = effW * scale; // final on-page visual size (post-rotation)
  const drawH = effH * scale;
  const targetX = cellX + (CARD_W - drawW) / 2;
  const targetY = cardBottomY + (CARD_H - drawH) / 2;

  // Pre-rotation box dimensions always scale the image's raw (unrotated) pixel size.
  const widthParam = image.width * scale;
  const heightParam = image.height * scale;

  if (image.orientation === 6) {
    page.drawImage(image.embedded, {
      x: targetX,
      y: targetY + widthParam,
      width: widthParam,
      height: heightParam,
      rotate: degrees(-90),
    });
  } else if (image.orientation === 8) {
    page.drawImage(image.embedded, {
      x: targetX + heightParam,
      y: targetY,
      width: widthParam,
      height: heightParam,
      rotate: degrees(90),
    });
  } else if (image.orientation === 3) {
    page.drawImage(image.embedded, {
      x: targetX + widthParam,
      y: targetY + heightParam,
      width: widthParam,
      height: heightParam,
      rotate: degrees(180),
    });
  } else {
    page.drawImage(image.embedded, { x: targetX, y: targetY, width: drawW, height: drawH });
  }

  return { drawW, drawH };
}

function drawCard(
  page: PDFPage,
  font: PDFFont,
  cellX: number,
  cellTopY: number,
  title: string,
  image: EmbeddedImage | null,
  fit: "contain" | "cover"
): void {
  // Caption above the card
  const labelSize = 7;
  const label = truncateToWidth(font, title, labelSize, CELL_W);
  const labelWidth = font.widthOfTextAtSize(label, labelSize);
  page.drawText(label, {
    x: cellX + (CELL_W - labelWidth) / 2,
    y: cellTopY - LABEL_H + 1.5,
    size: labelSize,
    font,
    color: rgb(0.35, 0.35, 0.35),
  });

  const cardTopY = cellTopY - LABEL_H;
  const cardBottomY = cardTopY - CARD_H;

  // 1) White rounded background (fill only — the dashed outline is drawn last, on top of
  // everything, so the image/corner-wedges below never obscure it).
  page.drawSvgPath(CARD_CUT_PATH, { x: cellX, y: cardTopY, color: rgb(1, 1, 1) });

  if (image) {
    // 2) The image itself, drawn as an ordinary square-cornered rectangle (EXIF-rotation-
    // corrected). "cover" scales up until one axis exactly matches the card and the other
    // overflows; "contain" scales down until both axes fit, leaving letterboxing.
    const { drawW, drawH } = drawFittedImage(page, image, cellX, cardBottomY, fit);

    // 2b) "cover" only ever overflows on one axis at a time (the other is scaled to match
    // the card exactly) — mask that overflow with plain white bands, anchored exactly at
    // the card edge and extending outward (never inward, so real image content near the
    // edge is never covered up) plus a hairline pad into the (blank) gutter for safety.
    const white = rgb(1, 1, 1);
    const pad = 1;
    const overflowH = (drawH - CARD_H) / 2;
    if (overflowH > 0.01) {
      page.drawRectangle({ x: cellX - pad, y: cardTopY, width: CARD_W + 2 * pad, height: overflowH + pad, color: white });
      page.drawRectangle({ x: cellX - pad, y: cardBottomY - overflowH - pad, width: CARD_W + 2 * pad, height: overflowH + pad, color: white });
    }
    const overflowW = (drawW - CARD_W) / 2;
    if (overflowW > 0.01) {
      page.drawRectangle({ x: cellX - overflowW - pad, y: cardBottomY - pad, width: overflowW + pad, height: CARD_H + 2 * pad, color: white });
      page.drawRectangle({ x: cellX + CARD_W, y: cardBottomY - pad, width: overflowW + pad, height: CARD_H + 2 * pad, color: white });
    }

    // 3) ...then its square corners are painted back out to white, matching the rounded
    // cut guide, so what prints lines up with what you cut.
    for (const wedge of CARD_CORNER_WEDGES) {
      page.drawSvgPath(wedge, { x: cellX, y: cardTopY, color: white });
    }
  } else {
    const msgSize = 8;
    const msg = "geen afbeelding";
    const msgWidth = font.widthOfTextAtSize(msg, msgSize);
    page.drawText(msg, {
      x: cellX + (CARD_W - msgWidth) / 2,
      y: cardBottomY + CARD_H / 2 - msgSize / 2,
      size: msgSize,
      font,
      color: rgb(0.7, 0.7, 0.7),
    });
  }

  // 4) Cut guide (dashed, rounded corners like a real card), drawn last so it's always
  // crisp and visible on top of the image/wedges.
  page.drawSvgPath(CARD_CUT_PATH, {
    x: cellX,
    y: cardTopY,
    borderColor: rgb(0.65, 0.65, 0.65),
    borderWidth: 0.6,
    borderDashArray: [3, 2],
  });
}

async function buildStickerPdf(items: StickerItem[]): Promise<{ pdfBytes: Uint8Array; skipped: string[] }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const skipped: string[] = [];

  const gridW = COLS * CELL_W + (COLS - 1) * GUTTER;
  const startX = (PAGE_W - gridW) / 2; // center horizontally
  const startY = PAGE_H - MARGIN; // align to the top margin (unused rows just leave blank space at the bottom)

  for (let pageStart = 0; pageStart < items.length; pageStart += PER_PAGE) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const pageItems = items.slice(pageStart, pageStart + PER_PAGE);

    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cellX = startX + col * (CELL_W + GUTTER);
      const cellTopY = startY - row * (CELL_H + GUTTER);

      const fetched = await fetchImage(item.coverUrl);
      let image: EmbeddedImage | null = null;
      if (fetched) {
        try {
          const embedded = fetched.kind === "png" ? await doc.embedPng(fetched.bytes) : await doc.embedJpg(fetched.bytes);
          image = { embedded, width: embedded.width, height: embedded.height, orientation: fetched.orientation };
        } catch {
          image = null;
        }
      }
      if (!image) skipped.push(item.title);

      drawCard(
        page,
        font,
        cellX,
        cellTopY,
        item.title,
        image,
        item.fit === "cover" ? "cover" : "contain"
      );
    }

    drawPageFooter(page, font);
  }

  const pdfBytes = await doc.save();
  return { pdfBytes, skipped };
}

export function registerStickerHandlers(ipc: IpcMain): void {
  ipc.handle("stickers:searchImages", async (_e: IpcMainInvokeEvent, query: string): Promise<ImageSearchResult[]> => {
    return searchCoverImages(query);
  });

  ipc.handle("stickers:generate", async (event: IpcMainInvokeEvent, items: StickerItem[]): Promise<StickerResult> => {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Geen playlists geselecteerd.");
    }

    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const opts: Electron.SaveDialogOptions = {
      title: "Stickervel opslaan als PDF",
      defaultPath: `yoto-stickers-${items.length}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    };
    const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }

    const { pdfBytes, skipped } = await buildStickerPdf(items);
    await writeFile(result.filePath, pdfBytes);

    return { ok: true, path: result.filePath, count: items.length, skipped };
  });
}
