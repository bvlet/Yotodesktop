import type { YotoApi } from "../preload/index.js";
import { ArrowLeftRight, ArrowRight, ArrowUpDown, BroomSparkles, Check, FileImage, GripVertical, HardDriveDownload, Pencil, Plus, Stars, Tags, Trash2, X, createElement as createLucideIcon } from "lucide";

declare global {
  interface Window {
    yoto: YotoApi;
  }
}

const root = document.getElementById("root")!;
const appMenu = document.getElementById("app-menu")!;

// Fetched once at startup (see the bottom of this file) and reused by the Settings → About
// screen, so the version shown there always matches package.json instead of a separately
// hardcoded string that's easy to forget to bump.
let appVersion = "";

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
interface PlaylistSummary {
  cardId: string;
  title: string;
  coverUrl?: string;
  updatedAt?: string;
}

function bustedCoverUrl(url: string | undefined, updatedAt: string | undefined): string | undefined {
  if (!url) return undefined;
  if (!updatedAt) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${encodeURIComponent(updatedAt)}`;
}
interface Playlist extends PlaylistSummary {
  chapters: Chapter[];
  totalDurationSec?: number;
  trackCount: number;
  editable?: boolean;
}

type View = "loading" | "welcome" | "signing-in" | "main";
type Tab = "playlists" | "settings" | "print-card-covers" | "help";

type AudioStage = "transcoding-local" | "hashing" | "uploading" | "transcoding-server" | "done";

interface DraftTrack {
  localId: string;
  filename: string;
  filePath: string;
  title: string;
  status: "queued" | AudioStage | "error" | "cancelled";
  errorMessage?: string;
  trackSha256?: string;
  durationSec?: number;
  fileSize?: number;
  iconRef?: string;
  iconUrl?: string;
  format?: string;
  channels?: string;
}

function isInFlight(s: DraftTrack["status"]): boolean {
  return s === "transcoding-local" || s === "hashing" || s === "uploading" || s === "transcoding-server";
}

interface Draft {
  title: string;
  tracks: DraftTrack[];
  coverMediaUrl?: string;
  coverUploading?: boolean;
  publishing?: boolean;
  publishError?: string;
}

const iconCache: { public?: PublicIcon[]; user?: UserIcon[]; loading: boolean } = { loading: false };
async function ensureIconsLoaded(): Promise<void> {
  if (iconCache.public && iconCache.user) return;
  if (iconCache.loading) {
    while (iconCache.loading) await new Promise((r) => setTimeout(r, 80));
    return;
  }
  iconCache.loading = true;
  try {
    const [pub, user] = await Promise.all([window.yoto.icons.listPublic(), window.yoto.icons.listUser()]);
    iconCache.public = pub;
    iconCache.user = user;
  } catch {
    // leave undefined
  } finally {
    iconCache.loading = false;
  }
}

// Auto-icon picker: match track title words against icon tags + titles
const STOP_WORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","for","with","by","from","is","are","was","were","be","been","being",
  "it","its","this","that","these","those","my","your","our","their","i","you","he","she","they","we","me","him","her","them","us",
  "do","does","did","done","have","has","had","will","would","could","should","may","might","can",
  "just","not","no","yes","up","down","out","off","over","under","into","onto","than","then","so","as","if",
  "feat","ft","featuring","remix","version","edit","mix","remaster","remastered","live","acoustic","instrumental",
  "track","song","title","intro","outro","interlude","bonus","disc","cd","mp3","aac","opus","ogg",
  "pt","part","vol","volume","ep","lp",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

function stemVariants(word: string): string[] {
  const out = [word];
  if (word.length > 3 && word.endsWith("s")) out.push(word.slice(0, -1));
  else out.push(word + "s");
  if (word.length > 4 && word.endsWith("es")) out.push(word.slice(0, -2));
  if (word.length > 4 && word.endsWith("ed")) out.push(word.slice(0, -2));
  if (word.length > 5 && word.endsWith("ing")) out.push(word.slice(0, -3));
  if (word.length > 4 && word.endsWith("er")) out.push(word.slice(0, -2));
  return out;
}

function pickIconForTitle(title: string, icons: PublicIcon[]): PublicIcon | null {
  const words = tokenize(title).filter((w) => w.length >= 4);
  if (words.length === 0) return null;

  const stemSet = new Set<string>();
  for (const w of words) for (const s of stemVariants(w)) if (s.length >= 4) stemSet.add(s);
  if (stemSet.size === 0) return null;

  let best: PublicIcon | null = null;
  let bestScore = 0;

  for (const icon of icons) {
    let score = 0;
    // Only meaningful tags (≥4 chars). Short tags like "it","let","be" are noise from named-song icons.
    const tags = new Set((icon.tags || []).map((t) => t.toLowerCase()).filter((t) => t.length >= 4));
    const titleTokens = new Set(
      (icon.title || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4)
    );

    for (const stem of stemSet) {
      if (tags.has(stem)) { score += 10; continue; }
      if (titleTokens.has(stem)) { score += 5; }
    }
    if (score > bestScore) { bestScore = score; best = icon; }
  }
  return bestScore >= 5 ? best : null;
}

async function autoAssignDraftIcons(opts: { overwrite: boolean }): Promise<{ assigned: number; skipped: number }> {
  if (!state.draft) return { assigned: 0, skipped: 0 };
  await ensureIconsLoaded();
  if (!iconCache.public || iconCache.public.length === 0) return { assigned: 0, skipped: state.draft.tracks.length };
  let assigned = 0, skipped = 0;
  for (const t of state.draft.tracks) {
    if (!opts.overwrite && t.iconRef) { skipped++; continue; }
    const icon = pickIconForTitle(t.title, iconCache.public);
    if (icon) {
      t.iconRef = `yoto:#${icon.mediaId}`;
      t.iconUrl = icon.url;
      assigned++;
    } else {
      skipped++;
    }
  }
  renderDetailArea();
  return { assigned, skipped };
}

interface AppendingTrack {
  localId: string;
  filename: string;
  filePath: string;
  title: string;
  status: "queued" | AudioStage | "error" | "cancelled";
  errorMessage?: string;
  trackSha256?: string;
  durationSec?: number;
  fileSize?: number;
  format?: string;
  channels?: string;
  iconRef?: string;
  iconUrl?: string;
}

interface State {
  view: View;
  tab: Tab;
  deviceCode?: { userCode: string; verificationUriComplete: string };
  error?: string;
  summaries?: PlaylistSummary[];
  familySummaries?: PlaylistSummary[];
  details: Map<string, Playlist>;
  selectedCardId?: string;
  draft?: Draft;
  appending: Map<string, AppendingTrack[]>;
}

const state: State = { view: "loading", tab: "playlists", details: new Map(), appending: new Map() };

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
function cleanTitleFromFilename(name: string): string {
  let t = stripExt(name);
  t = t.replace(/^[0-9]+[\s._\-]*/, "").trim();
  return t || stripExt(name);
}

// --- "Clean titles" toolbar action --------------------------------------
// Strips leftover track numbers / extensions / underscores from a single title.
function basicCleanTitle(raw: string): string {
  let t = raw.trim();
  t = t.replace(/\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|alac|aiff|aif|wma|webm)$/i, "");
  t = t.replace(/^[\[(]?\d{1,3}[\])]?[\s._-]+/, "");
  t = t.replace(/_+/g, " ");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t || raw.trim();
}

// Strips a recurring " - <segment>" or " by <name>" tail when it shows up on at least
// half the titles in the batch (e.g. every track ending in " - Sprookjes Vertellen").
// Needs at least 3 titles so a single coincidental match doesn't get treated as "recurring".
function stripRecurringSegments(titles: string[]): string[] {
  if (titles.length < 3) return titles;
  const n = titles.length;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const dashCounts = new Map<string, number>();
  for (const t of titles) {
    const m = t.match(/ - (.+)$/);
    if (m) dashCounts.set(m[1], (dashCounts.get(m[1]) ?? 0) + 1);
  }
  let dashSuffix: string | null = null;
  for (const [seg, count] of dashCounts) {
    if (count / n >= 0.5) { dashSuffix = seg; break; }
  }

  const byCounts = new Map<string, number>();
  for (const t of titles) {
    const m = t.match(/ by (.+)$/i);
    if (m) byCounts.set(m[1], (byCounts.get(m[1]) ?? 0) + 1);
  }
  let bySuffix: string | null = null;
  for (const [seg, count] of byCounts) {
    if (count / n >= 0.5) { bySuffix = seg; break; }
  }

  return titles.map((t) => {
    let out = t;
    if (dashSuffix && out.endsWith(` - ${dashSuffix}`)) {
      out = out.slice(0, out.length - (` - ${dashSuffix}`).length);
    }
    if (bySuffix) {
      out = out.replace(new RegExp(` by ${escape(bySuffix)}$`, "i"), "");
    }
    return out.trim();
  });
}

function cleanPlaylistTitles(titles: string[]): string[] {
  const basicCleaned = titles.map(basicCleanTitle);
  if (basicCleaned.length < 3) return basicCleaned;
  return stripRecurringSegments(basicCleaned);
}

function stageLabel(stage: DraftTrack["status"]): string {
  switch (stage) {
    case "queued": return "Queued";
    case "transcoding-local": return "Converting…";
    case "hashing": return "Hashing…";
    case "uploading": return "Uploading…";
    case "transcoding-server": return "Processing on Yoto…";
    case "done": return "Ready";
    case "error": return "Failed";
    case "cancelled": return "Cancelled";
  }
}

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function lucideIcon(
  icon: Parameters<typeof createLucideIcon>[0],
  className: string,
  size = 16,
  strokeWidth = 2
): SVGElement {
  return createLucideIcon(icon, {
    class: className,
    width: size,
    height: size,
    "stroke-width": strokeWidth,
    "aria-hidden": "true",
  });
}

function gripIcon(): SVGElement {
  return lucideIcon(GripVertical, "drag-icon", 14);
}

function pencilIcon(): SVGElement {
  return lucideIcon(Pencil, "edit-icon", 15);
}

function trashIcon(): SVGElement {
  return lucideIcon(Trash2, "delete-icon", 14);
}

function toolbarIcon(icon: Parameters<typeof createLucideIcon>[0]): SVGElement {
  return lucideIcon(icon, "toolbar-icon", 16, 1.8);
}

function setToolbarButtonLabel(button: HTMLButtonElement, icon: Parameters<typeof createLucideIcon>[0], label: string): void {
  button.replaceChildren(toolbarIcon(icon), label);
}

function coverAddHint(): HTMLElement {
  return el("span", { class: "cover-add-hint" }, lucideIcon(Plus, "cover-add-icon", 14), "Cover");
}

function emptyTrackIcon(): SVGElement {
  return lucideIcon(Plus, "track-add-icon", 14);
}

function modalCloseButton(close: () => void): HTMLButtonElement {
  const button = el("button", { class: "modal-close", title: "Close" }, lucideIcon(X, "modal-close-icon", 18)) as HTMLButtonElement;
  button.addEventListener("click", close);
  return button;
}

function setTitleDisplay(titleEl: HTMLElement, text: string) {
  titleEl.replaceChildren(
    el("span", { class: "detail-title-text" }, text),
    pencilIcon()
  );
}

function formatDuration(sec?: number): string {
  if (!sec || !isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function formatTotalDuration(sec?: number): string {
  if (!sec || !isFinite(sec)) return "";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function render() {
  root.innerHTML = "";
  appMenu.replaceChildren();
  appMenu.hidden = state.view !== "main";
  if (state.view === "loading") return renderLoading();
  if (state.view === "welcome") return renderWelcome();
  if (state.view === "signing-in") return renderSigningIn();
  if (state.view === "main") return renderMain();
}

function renderLoading() {
  root.append(el("div", { class: "center" }, el("p", {}, el("span", { class: "spinner" }), "Loading…")));
}

function renderWelcome() {
  const button = el("button", {}, "Sign in to Yoto");
  button.addEventListener("click", startSignIn);
  root.append(
    el(
      "div",
      { class: "onboarding-screen" },
      el(
        "section",
        { class: "onboarding-card" },
        el(
          "header",
          { class: "onboarding-header" },
          el("img", { class: "onboarding-player-icon", src: "player.png", alt: "" }),
          el("h1", {}, "DESKTOP FOR YOTO")
        ),
        el(
          "p",
          { class: "onboarding-copy" },
          el("strong", { class: "onboarding-welcome" }, "Welcome!"),
          "To get started, connect your Yoto account. Your credentials will be encrypted and stored on this computer."
        ),
        button,
        state.error ? el("p", { class: "error onboarding-error" }, state.error) : null
      )
    )
  );
}

function renderSigningIn() {
  const dc = state.deviceCode;
  const cancel = el("button", { class: "secondary" }, "Cancel");
  cancel.addEventListener("click", async () => {
    await window.yoto.auth.cancel();
    state.view = "welcome";
    state.deviceCode = undefined;
    render();
  });
  root.append(
    el(
      "div",
      { class: "center" },
      el("h1", {}, "Approve in your browser"),
      el(
        "p",
        {},
        "We've opened the Yoto sign-in page. If the code below isn't already filled in, enter it there."
      ),
      dc ? el("div", { class: "code" }, dc.userCode) : null,
      el("p", {}, el("span", { class: "spinner" }), "Waiting for approval…"),
      cancel
    )
  );
}

function renderMain() {
  const playlistsTab = el(
    "button",
    { class: "app-menu-item" + (state.tab === "playlists" ? " active" : "") },
    "Playlists"
  );
  const settingsTab = el(
    "button",
    { class: "app-menu-item" + (state.tab === "settings" ? " active" : "") },
    "Settings"
  );
  const printCardCovers = el(
    "button",
    { class: "app-menu-item" + (state.tab === "print-card-covers" ? " active" : "") },
    "Print card covers"
  );
  const helpTab = el(
    "button",
    { class: "app-menu-item" + (state.tab === "help" ? " active" : "") },
    "Help"
  );
  playlistsTab.addEventListener("click", () => switchTab("playlists"));
  settingsTab.addEventListener("click", () => switchTab("settings"));
  printCardCovers.addEventListener("click", () => switchTab("print-card-covers"));
  helpTab.addEventListener("click", () => switchTab("help"));
  appMenu.append(playlistsTab, printCardCovers, helpTab, settingsTab);

  const body = el("div", { class: "tab-body", id: "tab-body" });

  root.append(el("div", { class: "shell" }, body));

  renderTabBody();
}

function switchTab(next: Tab) {
  if (state.tab === next) return;
  state.tab = next;
  render();
}

function renderTabBody() {
  const target = document.getElementById("tab-body");
  if (!target) return;
  target.innerHTML = "";
  if (state.tab === "playlists") renderPlaylistsTab(target);
  else if (state.tab === "print-card-covers") renderPrintCardCoversPage(target);
  else if (state.tab === "help") renderHelpTab(target);
  else renderSettingsTab(target);
}

function renderPlaylistsTab(target: HTMLElement) {
  const newBtn = el("button", { class: "new-playlist-btn", title: "Create a new playlist" }, "NEW");
  newBtn.addEventListener("click", () => startOrFocusDraft());

  const playlistsHeading = el(
    "div",
    { class: "sidebar-heading" },
    el("h2", {}, "Your playlists"),
    newBtn
  );

  const sidebar = el(
    "aside",
    { class: "sidebar" },
    playlistsHeading,
    el("div", { id: "playlists" }, el("div", { class: "empty" }, "Loading…")),
    el("h2", { class: "sidebar-section-family" }, "Family playlists"),
    el("div", { id: "family-playlists" }, el("div", { class: "empty" }, "Loading…"))
  );
  const detail = el("section", { class: "detail", id: "detail" });
  target.append(el("div", { class: "layout" }, sidebar, detail));
  renderDetailArea();
  if (!state.summaries) loadPlaylists();
  else renderSidebar();
  if (!state.familySummaries) loadFamilyPlaylists();
  else renderFamilySidebar();
}

function renderDetailArea() {
  if (state.draft && !state.selectedCardId) renderDraft();
  else renderDetail();
}

function startOrFocusDraft() {
  if (!state.draft) {
    state.draft = { title: "Untitled playlist", tracks: [] };
  }
  state.selectedCardId = undefined;
  state.tab = "playlists";
  render();
}

function renderSettingsTab(target: HTMLElement) {
  const signOut = el("button", { class: "secondary" }, "Sign out");
  signOut.addEventListener("click", async () => {
    await window.yoto.auth.signOut();
    state.view = "welcome";
    state.tab = "playlists";
    state.summaries = undefined;
    state.familySummaries = undefined;
    state.details.clear();
    state.selectedCardId = undefined;
    render();
  });

  target.append(
    el(
      "div",
      { class: "settings" },
      el(
        "section",
        { class: "settings-section" },
        el("h3", {}, "Account"),
        el(
          "div",
          { class: "settings-row" },
          el(
            "div",
            { class: "settings-row-text" },
            el("div", { class: "settings-row-title" }, "Signed in to Yoto"),
            el("div", { class: "settings-row-sub" }, "Your sign-in is stored securely on this computer.")
          ),
          signOut
        )
      ),
      el(
        "section",
        { class: "settings-section" },
        el("h3", {}, "About"),
        el(
          "div",
          { class: "settings-row" },
          el(
            "div",
            { class: "settings-row-text" },
            el("div", { class: "settings-row-title" }, "Desktop for Yoto"),
            el("div", { class: "settings-row-sub" }, appVersion ? `Version ${appVersion}` : "Version…")
          )
        )
      )
    )
  );
}

function renderHelpTab(target: HTMLElement) {
  target.append(
    el(
      "div",
      { class: "settings help" },
      el(
        "section",
        { class: "settings-section" },
        el("h3", {}, "Frequently asked questions"),
        el(
          "article",
          { class: "faq-entry" },
          el("h4", {}, "How can I make sure my changes appear on the device?"),
          el(
            "p",
            {},
            "The player needs to fetch changes from the Yoto servers. It does this when it is plugged in (charging), not playing anything, and no Yoto app is open on a phone."
          )
        )
      )
    )
  );
}

function renderSidebar() {
  const target = document.getElementById("playlists");
  if (!target) return;
  target.innerHTML = "";

  if (state.draft) {
    const draftRow = el(
      "div",
      {
        class: "playlist draft" + (!state.selectedCardId ? " selected" : ""),
      },
      el("div", { class: "playlist-cover playlist-cover-placeholder draft-cover" }, lucideIcon(Plus, "draft-add-icon", 20)),
      el(
        "div",
        { class: "playlist-title" },
        state.draft.title || "Untitled playlist",
        el("span", { class: "draft-tag" }, "Draft")
      )
    );
    draftRow.addEventListener("click", () => {
      state.selectedCardId = undefined;
      render();
    });
    target.append(draftRow);
  }

  if (!state.summaries) {
    target.append(el("div", { class: "empty" }, "Loading…"));
    return;
  }
  if (state.summaries.length === 0 && !state.draft) {
    target.append(el("div", { class: "empty" }, "No playlists yet."));
    return;
  }

  for (const p of state.summaries) {
    const src = bustedCoverUrl(p.coverUrl, p.updatedAt);
    const cover = src
      ? el("img", { class: "playlist-cover", src, alt: "" })
      : el("div", { class: "playlist-cover playlist-cover-placeholder" });
    const row = el(
      "div",
      {
        class: "playlist" + (p.cardId === state.selectedCardId ? " selected" : ""),
        "data-card": p.cardId,
      },
      cover,
      el("div", { class: "playlist-title" }, p.title)
    );
    row.addEventListener("click", () => selectPlaylist(p.cardId));
    wirePlaylistDropTarget(row, p);
    target.append(row);
  }
}

function renderFamilySidebar() {
  const target = document.getElementById("family-playlists");
  if (!target) return;
  target.innerHTML = "";

  if (!state.familySummaries) {
    target.append(el("div", { class: "empty" }, "Loading…"));
    return;
  }
  if (state.familySummaries.length === 0) {
    target.append(el("div", { class: "empty" }, "No shared family playlists."));
    return;
  }

  for (const p of state.familySummaries) {
    const src = bustedCoverUrl(p.coverUrl, p.updatedAt);
    const cover = src
      ? el("img", { class: "playlist-cover", src, alt: "" })
      : el("div", { class: "playlist-cover playlist-cover-placeholder" });
    const row = el(
      "div",
      {
        class: "playlist" + (p.cardId === state.selectedCardId ? " selected" : ""),
        "data-card": p.cardId,
      },
      cover,
      el("div", { class: "playlist-title" }, p.title)
    );
    row.addEventListener("click", () => selectPlaylist(p.cardId));
    target.append(row);
  }
}

function renderDetail() {
  const target = document.getElementById("detail");
  if (!target) return;
  target.innerHTML = "";

  if (!state.selectedCardId) {
    const startBtn = el("button", { class: "button-with-icon" }, lucideIcon(Plus, "button-icon", 16), "New playlist");
    startBtn.addEventListener("click", startOrFocusDraft);
    target.append(
      el(
        "div",
        { class: "detail-empty" },
        el("h1", {}, "Pick a playlist"),
        el("p", {}, "Choose a playlist on the left, or drop a folder of audio anywhere on this window to start a new one."),
        startBtn
      )
    );
    return;
  }

  const detail = state.details.get(state.selectedCardId);
  const summary = state.summaries?.find((p) => p.cardId === state.selectedCardId);

  if (!detail) {
    target.append(
      el("div", { class: "detail-empty" }, el("p", {}, el("span", { class: "spinner" }), "Loading playlist…"))
    );
    return;
  }

  const editable = detail.editable !== false;

  const detailCoverSrc = bustedCoverUrl(detail.coverUrl, detail.updatedAt);
  const cover = detailCoverSrc
    ? el("img", {
        class: "detail-cover" + (editable ? " detail-cover-clickable" : ""),
        src: detailCoverSrc,
        alt: "",
        title: editable ? "Click to change cover" : "",
      })
    : el(
        "div",
        { class: "detail-cover detail-cover-placeholder" + (editable ? " detail-cover-clickable" : "") },
        editable ? coverAddHint() : ""
      );
  if (editable) cover.addEventListener("click", () => pickAndUploadCoverForExisting(detail.cardId));

  let toolbar: HTMLElement;
  if (editable) {
    const repairBtn = el("button", { class: "secondary", title: "Re-saves this playlist with the full chapter shape the Yoto player needs. Use if a playlist you published from this app won't play (cloud icon on the player)." }, toolbarIcon(HardDriveDownload), "Fix on player");
    repairBtn.addEventListener("click", () => repairExistingCard(detail.cardId, repairBtn as HTMLButtonElement));
    const refreshIconsBtn = el("button", { class: "secondary", title: "AI-match every track's title against the Yoto public icon library, semantically (Wings → bird, Grow → plant). Replaces all current icons." }, toolbarIcon(Stars), "Auto-choose icons");
    refreshIconsBtn.addEventListener("click", () => autoChooseIconsForPlaylist(detail.cardId, refreshIconsBtn as HTMLButtonElement));
    const deleteBtn = el("button", { class: "secondary danger", title: "Permanently delete this playlist from your Yoto account." }, toolbarIcon(Trash2), "Delete");
    deleteBtn.addEventListener("click", () => deleteExistingPlaylist(detail.cardId, detail.title));
    const cleanTitlesBtn = el("button", { class: "secondary", title: "Strip track numbers and recurring album/artist chunks from every track title." }, toolbarIcon(BroomSparkles), "Clean titles");
    cleanTitlesBtn.addEventListener("click", () => cleanTitlesForPlaylist(detail.cardId, cleanTitlesBtn as HTMLButtonElement));
    const readId3TitlesBtn = el("button", { class: "secondary", title: "Choose the original audio files to read their ID3 title tags and preview the proposed changes." }, toolbarIcon(Tags), "Read titles from ID3 tag");
    readId3TitlesBtn.addEventListener("click", () => openExistingId3ImportModal(detail));
    const cardArtBtn = el(
      "button",
      { class: "secondary", title: "Search for official cover art and add the title to it. The result becomes the card cover immediately." },
      toolbarIcon(FileImage),
      "Create card cover"
    );
    cardArtBtn.addEventListener("click", () => openCardArtModal(detail));
    toolbar = el("div", { class: "detail-toolbar" }, refreshIconsBtn, cleanTitlesBtn, readId3TitlesBtn, cardArtBtn, repairBtn, deleteBtn);
  } else {
    toolbar = el(
      "div",
      { class: "detail-toolbar" },
      el(
        "p",
        { class: "detail-readonly-note" },
        "This is a shared family playlist — only its owner can edit it."
      )
    );
  }

  const title = editable
    ? el("h1", { class: "detail-title", tabindex: "0", role: "textbox", title: "Click to rename" })
    : el("h1", { class: "detail-title" });
  setTitleDisplay(title, detail.title);
  if (editable) {
    title.addEventListener("click", () => beginRename(title, detail));
    title.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") beginRename(title, detail);
    });
  }

  const meta = el(
    "div",
    { class: "detail-meta" },
    `${detail.trackCount} track${detail.trackCount === 1 ? "" : "s"}`,
    detail.totalDurationSec ? ` · ${formatTotalDuration(detail.totalDurationSec)}` : ""
  );

  const header = el(
    "header",
    { class: "detail-header" },
    cover,
    el("div", { class: "detail-header-text" }, title, meta)
  );

  target.append(toolbar);

  const tracks = el("div", { class: "tracks" });
  if (detail.chapters.length === 0) {
    tracks.append(el("div", { class: "empty" }, "No tracks on this playlist."));
  } else {
    const reorderable = editable && detail.chapters.every((ch) => !!ch.key);
    if (reorderable) wireDropContainer(tracks, detail);
    detail.chapters.forEach((chapter, i) => {
      const isMulti = chapter.tracks.length > 1;
      const rowTitle = !isMulti && chapter.tracks[0] ? chapter.tracks[0].title || chapter.title : chapter.title;
      const rowDuration = chapter.durationSec ?? chapter.tracks.reduce((n, t) => n + (t.durationSec ?? 0), 0);
      const handle = el("span", { class: "drag-handle", title: "Drag to reorder, or drop on another playlist to move" }, gripIcon());
      const iconSlot = editable
        ? makeIconSlot(chapter.iconUrl, () => openIconPickerForChapter(detail.cardId, i))
        : makeIconSlot(chapter.iconUrl, () => {});
      const rowChildren: (Node | string)[] = [
        handle,
        iconSlot,
        el("span", { class: "track-num" }, String(i + 1).padStart(2, "0")),
        el("span", { class: "track-title" }, rowTitle),
        el("span", { class: "track-duration" }, formatDuration(rowDuration)),
      ];
      if (editable) {
        const deleteBtnEl = el("button", { class: "track-delete", title: "Remove this track from the playlist" }, trashIcon()) as HTMLButtonElement;
        deleteBtnEl.addEventListener("click", (ev) => {
          ev.stopPropagation();
          deleteChapterFromPlaylist(detail, i);
        });
        rowChildren.push(deleteBtnEl);
      }
      const row = el(
        "div",
        { class: "track has-handle has-icon" + (editable ? " has-delete" : ""), "data-idx": String(i) },
        ...rowChildren
      );
      if (reorderable) wireDragRow(row, handle, detail);
      else handle.classList.add("hidden");
      tracks.append(row);
      if (isMulti) {
        const sub = el("div", { class: "track-subs" });
        chapter.tracks.forEach((t, j) => {
          sub.append(
            el(
              "div",
              { class: "track track-sub has-handle has-icon" },
              el("span", { class: "drag-handle drag-handle-spacer" }),
              el("span", { class: "track-icon track-icon-empty" }, emptyTrackIcon()),
              el("span", { class: "track-num" }, `${i + 1}.${j + 1}`),
              el("span", { class: "track-title" }, t.title),
              el("span", { class: "track-duration" }, formatDuration(t.durationSec))
            )
          );
        });
        tracks.append(sub);
      }
    });
  }

  // Append-in-progress tracks
  const appending = state.appending.get(detail.cardId) ?? [];
  if (appending.length > 0) {
    const stillBusy = appending.some((t) => t.status === "queued" || isInFlight(t.status));
    const appendingList = el("div", { class: "tracks tracks-appending" });
    appendingList.append(
      el(
        "div",
        { class: "appending-header" + (stillBusy ? "" : " appending-header-done") },
        stillBusy ? "Uploading new tracks…" : "New tracks — ready to add"
      )
    );
    appending.forEach((t, j) => {
      const isDone = t.status === "done";
      const isErr = t.status === "error";
      const isCancelled = t.status === "cancelled";
      const inFlight = isInFlight(t.status);
      let right: HTMLElement;
      if (isDone) right = el("span", { class: "track-status" }, "Ready");
      else if (isErr || isCancelled) {
        right = el("span", { class: "track-status " + (isCancelled ? "cancelled" : "error") }, stageLabel(t.status));
      } else if (inFlight) {
        right = el("span", { class: "track-status" }, el("span", { class: "spinner small" }), stageLabel(t.status));
      } else right = el("span", { class: "track-status" }, stageLabel(t.status));
      appendingList.append(
        el(
          "div",
          { class: "track has-icon" + (isErr ? " row-error" : isCancelled ? " row-cancelled" : "") },
          el("span", { class: "track-icon track-icon-empty" }, emptyTrackIcon()),
          el("span", { class: "track-num" }, String(detail.chapters.length + j + 1).padStart(2, "0")),
          el("span", { class: "track-title" }, t.title),
          right
        )
      );
      if (isErr && t.errorMessage) {
        appendingList.append(
          el(
            "div",
            { class: "track-error-detail" },
            el("span", { class: "track-error-prefix" }, "Error:"),
            " " + t.errorMessage
          )
        );
      }
    });
    tracks.append(appendingList);
  }

  const allDone = appending.length > 0 && appending.every((t) => t.status === "done" || t.status === "error" || t.status === "cancelled");
  const anyDone = appending.some((t) => t.status === "done");
  let dropZone: HTMLElement;
  if (appending.length === 0) {
    dropZone = el(
      "div",
      { class: "dropzone draft-dropzone" },
      el("span", {}, "Drop audio files or a folder here to add to this playlist")
    );
  } else if (!allDone) {
    dropZone = el(
      "div",
      { class: "dropzone dropzone-disabled" },
      el("span", {}, `Uploading… (${appending.filter((t) => t.status === "done").length}/${appending.length} ready)`)
    );
  } else {
    const saveBtn = el("button", {}, "Save to playlist");
    if (!anyDone) saveBtn.setAttribute("disabled", "true");
    saveBtn.addEventListener("click", () => commitAppend(detail.cardId));
    const cancelBtn = el("button", { class: "secondary" }, "Cancel");
    cancelBtn.addEventListener("click", () => {
      state.appending.delete(detail.cardId);
      renderDetail();
    });
    dropZone = el(
      "div",
      { class: "dropzone draft-dropzone append-actions" },
      el("div", { class: "append-summary muted" }, `${appending.filter((t) => t.status === "done").length} ready, ${appending.filter((t) => t.status === "error").length} failed.`),
      el("div", { class: "append-buttons" }, cancelBtn, saveBtn)
    );
  }

  target.append(header, tracks, dropZone);

  if (summary && summary.title !== detail.title) {
    summary.title = detail.title;
    summary.coverUrl = detail.coverUrl ?? summary.coverUrl;
    renderSidebar();
  }
}

interface DragState {
  sourceCardId: string;
  sourceIndex: number;
  targetIndex: number | null;
  targetSide: "above" | "below" | null;
}
let drag: DragState | null = null;
let movingChapter = false;

function clearDropIndicators(container: HTMLElement) {
  for (const node of container.querySelectorAll(".drop-above, .drop-below")) {
    node.classList.remove("drop-above", "drop-below");
  }
}

function clearPlaylistDropTargets() {
  for (const node of document.querySelectorAll(".playlist.drop-target")) {
    node.classList.remove("drop-target");
  }
}

function wireDragRow(row: HTMLElement, handle: HTMLElement, detail: Playlist) {
  handle.addEventListener("mousedown", () => row.setAttribute("draggable", "true"));
  handle.addEventListener("mouseup", () => row.removeAttribute("draggable"));

  row.addEventListener("dragstart", (ev) => {
    const idx = Number(row.dataset.idx);
    drag = { sourceCardId: detail.cardId, sourceIndex: idx, targetIndex: null, targetSide: null };
    row.classList.add("dragging");
    ev.dataTransfer?.setData("text/plain", `${detail.cardId}:${idx}`);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
  });

  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    row.removeAttribute("draggable");
    const container = row.parentElement;
    if (container) clearDropIndicators(container);
    clearPlaylistDropTargets();
    drag = null;
  });
}

function wirePlaylistDropTarget(row: HTMLElement, target: PlaylistSummary) {
  row.addEventListener("dragover", (ev) => {
    if (!drag || drag.sourceCardId === target.cardId || movingChapter) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    row.classList.add("drop-target");
  });

  row.addEventListener("dragleave", (ev) => {
    if (!row.contains(ev.relatedTarget as Node | null)) row.classList.remove("drop-target");
  });

  row.addEventListener("drop", (ev) => {
    ev.preventDefault();
    if (!drag || drag.sourceCardId === target.cardId || movingChapter) return;
    const sourceCardId = drag.sourceCardId;
    const sourceIndex = drag.sourceIndex;
    clearPlaylistDropTargets();
    drag = null;
    void moveChapterToPlaylist(sourceCardId, sourceIndex, target);
  });
}

function wireDropContainer(container: HTMLElement, detail: Playlist) {
  container.addEventListener("dragover", (ev) => {
    if (!drag) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";

    const rows = Array.from(container.querySelectorAll<HTMLElement>(".track:not(.track-sub)"));
    if (rows.length === 0) return;

    let bestRow: HTMLElement | null = null;
    let bestDist = Infinity;
    let bestSide: "above" | "below" = "above";
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const dist = Math.abs(ev.clientY - center);
      if (dist < bestDist) {
        bestDist = dist;
        bestRow = r;
        bestSide = ev.clientY < center ? "above" : "below";
      }
    }
    if (!bestRow) return;

    const idx = Number(bestRow.dataset.idx);
    if (drag.targetIndex === idx && drag.targetSide === bestSide) return;

    clearDropIndicators(container);
    const sourceIdx = drag.sourceIndex;
    const isAdjacentNoOp =
      (bestSide === "above" && idx === sourceIdx + 1) ||
      (bestSide === "below" && idx === sourceIdx - 1) ||
      idx === sourceIdx;
    if (!isAdjacentNoOp) {
      bestRow.classList.add(bestSide === "above" ? "drop-above" : "drop-below");
    }
    drag.targetIndex = idx;
    drag.targetSide = bestSide;
  });

  container.addEventListener("drop", (ev) => {
    ev.preventDefault();
    if (!drag) return;
    clearDropIndicators(container);
    finalizeReorder(detail);
  });
}

async function moveChapterToPlaylist(sourceCardId: string, sourceIndex: number, target: PlaylistSummary) {
  if (movingChapter) return;
  const source = state.details.get(sourceCardId);
  const chapter = source?.chapters[sourceIndex];
  if (!source || !chapter) return;
  if (source.chapters.length <= 1) {
    showDetailError("You cannot move the only track from a playlist.");
    return;
  }
  if (!chapter.key) {
    showDetailError("Cannot move this track: its chapter key is unknown. Try refreshing the playlist.");
    return;
  }

  movingChapter = true;
  try {
    const targetDetail = await window.yoto.playlists.get(target.cardId);
    if (targetDetail.editable === false) {
      showDetailError(`Cannot move a track to "${target.title}" because you do not own that playlist.`);
      return;
    }
    await window.yoto.playlists.moveChapter(sourceCardId, chapter.key, target.cardId);
    state.details.delete(sourceCardId);
    state.details.delete(target.cardId);
    await selectPlaylist(sourceCardId);
  } catch (err) {
    showDetailError(`Couldn't move track to "${target.title}": ${(err as Error).message}`);
  } finally {
    movingChapter = false;
  }
}

async function finalizeReorder(detail: Playlist) {
  if (!drag || drag.targetIndex == null || drag.targetSide == null) {
    drag = null;
    return;
  }
  const { sourceIndex, targetIndex, targetSide } = drag;
  drag = null;
  if (sourceIndex === targetIndex) return;

  let dest = targetSide === "below" ? targetIndex + 1 : targetIndex;
  if (sourceIndex < dest) dest -= 1;
  if (dest === sourceIndex) return;

  const previous = detail.chapters.slice();
  const next = previous.slice();
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(dest, 0, moved);
  detail.chapters = next;
  renderDetail();

  const keys = next.map((c) => c.key!).filter(Boolean);
  if (keys.length !== next.length) {
    detail.chapters = previous;
    renderDetail();
    showDetailError("Couldn't reorder — chapters missing keys.");
    return;
  }

  try {
    await window.yoto.playlists.reorder(detail.cardId, keys);
  } catch (err) {
    detail.chapters = previous;
    renderDetail();
    showDetailError(`Reorder failed: ${(err as Error).message}`);
  }
}

function showDetailError(message: string) {
  const target = document.getElementById("detail");
  if (!target) return;
  const banner = el("div", { class: "error banner" }, message);
  target.prepend(banner);
  setTimeout(() => banner.remove(), 5000);
}

function renderDraft() {
  const target = document.getElementById("detail");
  if (!target || !state.draft) return;
  const draft = state.draft;
  target.innerHTML = "";

  const cover = draft.coverMediaUrl
    ? (el("img", { class: "detail-cover detail-cover-clickable", src: draft.coverMediaUrl, alt: "", title: "Click to change cover" }))
    : el(
        "div",
        { class: "detail-cover detail-cover-placeholder detail-cover-clickable", title: "Click to add cover art" },
        draft.coverUploading ? el("span", { class: "spinner" }) : coverAddHint()
      );
  cover.addEventListener("click", () => pickAndUploadCoverForDraft());

  const title = el("h1", { class: "detail-title", tabindex: "0", role: "textbox", title: "Click to rename" });
  setDraftTitleDisplay(title, draft.title);
  title.addEventListener("click", () => beginDraftRename(title));
  title.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Enter") beginDraftRename(title);
  });

  const readyTracks = draft.tracks.filter((t) => t.status === "done").length;
  const totalTracks = draft.tracks.length;
  const meta = el(
    "div",
    { class: "detail-meta" },
    totalTracks === 0
      ? "Drop audio files below to add tracks"
      : `${readyTracks} of ${totalTracks} ready`
  );

  const inFlightCount = draft.tracks.filter((t) => isInFlight(t.status) || t.status === "queued").length;

  const cancelAllBtn = el("button", { class: "secondary" }, `Cancel all (${inFlightCount})`);
  cancelAllBtn.addEventListener("click", () => cancelAllInDraft());

  const discardBtn = el("button", { class: "secondary" }, "Discard");
  discardBtn.addEventListener("click", () => {
    if (draft.tracks.length > 0) {
      if (!confirm("Discard this draft? Uploaded audio stays on Yoto's servers but the playlist won't be created.")) return;
    }
    cancelAllInDraft();
    state.draft = undefined;
    render();
  });

  const publishable = readyTracks > 0 && !draft.publishing && inFlightCount === 0;
  const publishBtn = el("button", {}, draft.publishing ? "Publishing…" : "Publish to Yoto");
  if (!publishable) publishBtn.setAttribute("disabled", "true");
  publishBtn.addEventListener("click", publishDraft);

  const autoIconsBtn = el("button", { class: "secondary", title: "Match each track's title against the Yoto public icon library and auto-assign best matches. Existing icons are kept; tracks with no good match stay blank." }, toolbarIcon(Stars), "Auto-pick icons");
  autoIconsBtn.addEventListener("click", () => runAutoIconsClick(autoIconsBtn as HTMLButtonElement));

  const readId3TitlesBtn = el("button", { class: "secondary", title: "Read each local audio file's ID3 title tag and preview the proposed changes." }, toolbarIcon(Tags), "Read titles from ID3 tag");
  readId3TitlesBtn.addEventListener("click", () => readTitlesFromId3Tags(readId3TitlesBtn as HTMLButtonElement));

  const toolbar = el(
    "div",
    { class: "detail-toolbar" },
    inFlightCount > 0 ? cancelAllBtn : null,
    draft.tracks.length > 0 ? readId3TitlesBtn : null,
    draft.tracks.some((t) => t.status === "done") ? autoIconsBtn : null,
    discardBtn,
    publishBtn
  );

  const header = el(
    "header",
    { class: "detail-header" },
    cover,
    el("div", { class: "detail-header-text" }, title, meta)
  );

  const tracks = el("div", { class: "tracks" });
  if (draft.tracks.length === 0) {
    tracks.append(el("div", { class: "empty" }, "No tracks yet."));
  } else {
    draft.tracks.forEach((t, i) => {
      const isDone = t.status === "done";
      const isErr = t.status === "error";
      const isCancelled = t.status === "cancelled";
      const inFlight = isInFlight(t.status);

      let right: HTMLElement;
      if (isDone) {
        right = el("span", { class: "track-duration" }, formatDuration(t.durationSec));
      } else if (isErr || isCancelled) {
        const retryBtn = el("button", { class: "retry-btn" }, "Retry");
        retryBtn.addEventListener("click", () => retryDraftTrack(t.localId));
        right = el(
          "span",
          { class: "track-status-area" },
          el("span", { class: "track-status " + (isCancelled ? "cancelled" : "error") }, stageLabel(t.status)),
          retryBtn
        );
      } else if (inFlight) {
        const cancelBtn = el("button", { class: "cancel-btn", title: "Cancel" }, "Cancel");
        cancelBtn.addEventListener("click", () => cancelDraftTrack(t.localId));
        right = el(
          "span",
          { class: "track-status-area" },
          el("span", { class: "track-status" }, el("span", { class: "spinner small" }), stageLabel(t.status)),
          cancelBtn
        );
      } else {
        right = el("span", { class: "track-status" }, stageLabel(t.status));
      }

      const removeBtn = el("button", { class: "row-remove", title: "Remove" }, lucideIcon(X, "remove-icon", 16));
      removeBtn.addEventListener("click", () => removeDraftTrack(t.localId));

      const iconSlot = makeIconSlot(t.iconUrl, () => openIconPickerForDraftTrack(t.localId));

      const row = el(
        "div",
        { class: "track draft-track has-icon" + (isErr ? " row-error" : isCancelled ? " row-cancelled" : "") },
        iconSlot,
        el("span", { class: "track-num" }, String(i + 1).padStart(2, "0")),
        el("span", { class: "track-title" }, t.title),
        right,
        removeBtn
      );
      tracks.append(row);

      if (isErr && t.errorMessage) {
        tracks.append(
          el(
            "div",
            { class: "track-error-detail" },
            el("span", { class: "track-error-prefix" }, "Error:"),
            " " + t.errorMessage
          )
        );
      }
    });
  }

  const dropzone = el(
    "div",
    { class: "dropzone draft-dropzone" },
    el("span", {}, "Drop audio files or a folder here")
  );

  if (draft.publishError) {
    target.append(el("div", { class: "error banner" }, `Publish failed: ${draft.publishError}`));
  }
  target.append(toolbar, header, tracks, dropzone);
}

function setDraftTitleDisplay(titleEl: HTMLElement, text: string) {
  titleEl.replaceChildren(
    el("span", { class: "detail-title-text" }, text),
    pencilIcon()
  );
}

function beginDraftRename(titleEl: HTMLElement) {
  if (!state.draft) return;
  const draft = state.draft;
  if (titleEl.querySelector("input")) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "detail-title-input";
  input.value = draft.title;
  titleEl.replaceChildren(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const next = input.value.trim();
    if (next) draft.title = next;
    setDraftTitleDisplay(titleEl, draft.title);
    renderSidebar();
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      input.blur();
    } else if (ev.key === "Escape") {
      committed = true;
      setDraftTitleDisplay(titleEl, draft.title);
    }
  });
}

function removeDraftTrack(localId: string) {
  if (!state.draft) return;
  state.draft.tracks = state.draft.tracks.filter((t) => t.localId !== localId);
  renderDetailArea();
}

async function retryDraftTrack(localId: string) {
  if (!state.draft) return;
  const t = state.draft.tracks.find((x) => x.localId === localId);
  if (!t) return;
  t.status = "queued";
  t.errorMessage = undefined;
  renderDetailArea();
  await uploadDraftTrack(t);
}

async function cancelDraftTrack(localId: string) {
  await window.yoto.audio.cancel(localId);
}

async function cancelAllInDraft() {
  if (!state.draft) return;
  const live = state.draft.tracks.filter((t) => isInFlight(t.status) || t.status === "queued");
  for (const t of live) {
    if (t.status === "queued") {
      t.status = "cancelled";
    } else {
      window.yoto.audio.cancel(t.localId);
    }
  }
  renderDetailArea();
}

async function uploadDraftTrack(t: DraftTrack) {
  if (!state.draft) return;
  if (t.status !== "queued") return;
  try {
    const result = await window.yoto.audio.upload(t.localId, t.filePath, (stage) => {
      t.status = stage;
      if (state.draft) renderDetailArea();
    });
    t.status = "done";
    t.trackSha256 = result.trackSha256;
    t.durationSec = result.durationSec;
    t.fileSize = result.serverFileSize;
    t.format = result.format;
    t.channels = result.channels;
    // Auto-suggest an icon based on title (only if user hasn't picked one)
    if (!t.iconRef) {
      ensureIconsLoaded().then(() => {
        if (!iconCache.public || !state.draft) return;
        const found = state.draft.tracks.find((x) => x.localId === t.localId);
        if (!found || found.iconRef) return;
        const icon = pickIconForTitle(found.title, iconCache.public);
        if (icon) {
          found.iconRef = `yoto:#${icon.mediaId}`;
          found.iconUrl = icon.url;
          renderDetailArea();
        }
      });
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "aborted" || msg.toLowerCase().includes("abort")) {
      t.status = "cancelled";
      t.errorMessage = undefined;
    } else {
      t.status = "error";
      t.errorMessage = msg;
    }
  }
  if (state.draft) renderDetailArea();
}

const UPLOAD_CONCURRENCY = 3;

async function appendFilesToDraft(filePaths: string[]) {
  if (!state.draft) return;
  const newTracks: DraftTrack[] = filePaths.map((p) => {
    const fname = basename(p);
    return {
      localId: uid(),
      filename: fname,
      filePath: p,
      title: cleanTitleFromFilename(fname),
      status: "queued",
    };
  });
  state.draft.tracks.push(...newTracks);
  renderDetailArea();
  renderSidebar();

  const queue = [...newTracks];
  await Promise.all(
    Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const t = queue.shift();
        if (!t) return;
        await uploadDraftTrack(t);
      }
    })
  );
}

async function publishDraft() {
  if (!state.draft) return;
  const draft = state.draft;
  const ready = draft.tracks.filter((t) => t.status === "done" && t.trackSha256);
  if (ready.length === 0) return;

  draft.publishing = true;
  draft.publishError = undefined;
  renderDetailArea();

  try {
    const { cardId } = await window.yoto.playlists.create({
      title: draft.title,
      coverMediaUrl: draft.coverMediaUrl,
      tracks: ready.map((t) => ({
        title: t.title,
        trackSha256: t.trackSha256!,
        durationSec: t.durationSec,
        fileSize: t.fileSize,
        iconRef: t.iconRef,
        format: t.format,
        channels: t.channels,
      })),
    });
    state.draft = undefined;
    state.selectedCardId = cardId;
    state.details.delete(cardId);
    await loadPlaylists();
    await selectPlaylist(cardId);
  } catch (err) {
    draft.publishing = false;
    draft.publishError = (err as Error).message;
    renderDetailArea();
  }
}

async function runAutoIconsClick(btn: HTMLButtonElement) {
  btn.setAttribute("disabled", "true");
  setToolbarButtonLabel(btn, Stars, "Picking…");
  const { assigned, skipped } = await autoAssignDraftIcons({ overwrite: false });
  setToolbarButtonLabel(btn, Stars, `Picked ${assigned}${skipped ? `, ${skipped} no match` : ""}`);
  setTimeout(() => {
    setToolbarButtonLabel(btn, Stars, "Auto-pick icons");
    btn.removeAttribute("disabled");
  }, 2200);
}

async function readTitlesFromId3Tags(btn: HTMLButtonElement) {
  const draft = state.draft;
  if (!draft || draft.tracks.length === 0) return;

  btn.setAttribute("disabled", "true");
  setToolbarButtonLabel(btn, Tags, "Reading ID3 tags…");
  let id3Titles: Array<string | null>;
  try {
    id3Titles = await window.yoto.files.readId3Titles(draft.tracks.map((track) => track.filePath));
  } catch (err) {
    setToolbarButtonLabel(btn, Tags, "Read titles from ID3 tag");
    btn.removeAttribute("disabled");
    showDetailError(`Couldn't read ID3 titles: ${(err as Error).message}`);
    return;
  }

  if (state.draft !== draft) return;
  const changes = draft.tracks
    .map((track, index) => ({ track, from: track.title, to: id3Titles[index]?.trim() }))
    .filter((change): change is { track: DraftTrack; from: string; to: string } => Boolean(change.to && change.to !== change.from));

  if (changes.length === 0) {
    setToolbarButtonLabel(btn, Tags, "No ID3 title changes");
    setTimeout(() => {
      setToolbarButtonLabel(btn, Tags, "Read titles from ID3 tag");
      btn.removeAttribute("disabled");
    }, 1800);
    return;
  }

  const preview = changes.slice(0, 8).map(({ from, to }) => `“${from}” → “${to}”`).join("\n");
  const more = changes.length > 8 ? `\n… and ${changes.length - 8} more` : "";
  const ok = confirm(
    `Read titles from ID3 tags?\n\nThe following ${changes.length} track${changes.length === 1 ? "" : "s"} will change:\n\n${preview}${more}\n\nClick OK to apply these changes, or Cancel to keep the current titles.`
  );
  if (!ok) {
    setToolbarButtonLabel(btn, Tags, "Read titles from ID3 tag");
    btn.removeAttribute("disabled");
    return;
  }

  for (const { track, to } of changes) track.title = to;
  renderDetailArea();
}

async function pickAndUploadCoverForDraft() {
  if (!state.draft) return;
  const filePath = await window.yoto.files.pickImage();
  if (!filePath) return;
  state.draft.coverUploading = true;
  renderDetailArea();
  try {
    const result = await window.yoto.cover.upload(filePath);
    if (state.draft) {
      state.draft.coverMediaUrl = result.mediaUrl;
      state.draft.coverUploading = false;
      renderDetailArea();
    }
  } catch (err) {
    if (state.draft) {
      state.draft.coverUploading = false;
      state.draft.publishError = `Cover upload failed: ${(err as Error).message}`;
      renderDetailArea();
    }
  }
}

async function pickAndUploadCoverForExisting(cardId: string) {
  const filePath = await window.yoto.files.pickImage();
  if (!filePath) return;
  try {
    const result = await window.yoto.cover.upload(filePath);
    await window.yoto.playlists.setCover(cardId, result.mediaUrl);
    const detail = state.details.get(cardId);
    if (detail) {
      detail.coverUrl = result.mediaUrl;
      detail.updatedAt = new Date().toISOString();
    }
    const summary = state.summaries?.find((p) => p.cardId === cardId);
    if (summary) {
      summary.coverUrl = result.mediaUrl;
      summary.updatedAt = new Date().toISOString();
    }
    state.details.delete(cardId);
    renderSidebar();
    if (state.selectedCardId === cardId) {
      await selectPlaylist(cardId);
    }
  } catch (err) {
    showDetailError(`Cover upload failed: ${(err as Error).message}`);
  }
}

function makeIconSlot(iconUrl: string | undefined, onClick: () => void): HTMLElement {
  const slot = iconUrl
    ? el("img", { class: "track-icon", src: iconUrl, alt: "", title: "Click to change icon" })
    : el("div", { class: "track-icon track-icon-empty", title: "Click to add icon" }, emptyTrackIcon());
  slot.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return slot;
}

async function openIconPickerForDraftTrack(localId: string) {
  if (!state.draft) return;
  const t = state.draft.tracks.find((x) => x.localId === localId);
  if (!t) return;
  await openIconPicker((picked) => {
    t.iconRef = `yoto:#${picked.mediaId}`;
    t.iconUrl = picked.url;
    renderDetailArea();
  });
}

interface StickerCandidate { cardId: string; title: string; coverUrl?: string }
interface StickerImageSearchResult { url: string; thumbUrl: string; title: string; source: string }

function collectStickerCandidates(): StickerCandidate[] {
  const list: StickerCandidate[] = [];
  const seen = new Set<string>();
  for (const s of state.summaries ?? []) {
    if (seen.has(s.cardId)) continue;
    seen.add(s.cardId);
    list.push({ cardId: s.cardId, title: s.title, coverUrl: s.coverUrl });
  }
  // If a "family playlists" list exists on state, include those too.
  for (const s of (state as unknown as { familySummaries?: StickerCandidate[] }).familySummaries ?? []) {
    if (seen.has(s.cardId)) continue;
    seen.add(s.cardId);
    list.push({ cardId: s.cardId, title: s.title, coverUrl: s.coverUrl });
  }
  return list;
}

function renderPrintCardCoversPage(target: HTMLElement) {
  if (!state.summaries) {
    target.append(
      el(
        "section",
        { class: "print-covers-page" },
        el(
          "header",
          { class: "print-covers-header" },
          el("h1", {}, "Print card covers"),
          el("p", {}, "Preparing your playlists…")
        )
      )
    );
    void loadPlaylists().then(() => {
      if (state.tab === "print-card-covers") render();
    });
    return;
  }

  if (!state.familySummaries) {
    void loadFamilyPlaylists().then(() => {
      if (state.tab === "print-card-covers") render();
    });
  }

  const candidates = collectStickerCandidates();
  if (candidates.length === 0) {
    target.append(
      el(
        "section",
        { class: "print-covers-page" },
        el(
          "header",
          { class: "print-covers-header" },
          el("h1", {}, "Print card covers"),
          el("p", {}, "Choose playlists to create a printable A4 card-cover sheet.")
        ),
        el("div", { class: "empty print-covers-empty" }, "No playlists are available to print yet.")
      )
    );
    return;
  }

  const selected = new Set<string>(candidates.map((c) => c.cardId));
  // Cover picked from the online search, per cardId — overrides c.coverUrl when generating.
  const imageOverrides = new Map<string, { url: string; thumbUrl: string }>();
  // Which row currently has its image picker open (only one at a time).
  let searchOpenFor: string | null = null;
  let searchResults: StickerImageSearchResult[] = [];
  let searchLoading = false;
  let searchError: string | null = null;

  const header = el(
    "header",
    { class: "print-covers-header" },
    el("h1", {}, "Print card covers"),
    el(
      "p",
      {},
      "Choose the playlists to include on an A4 card-cover sheet. Each cover is credit-card size (53.98 × 85.6 mm), portrait, with rounded corners and sized for the NFC card."
    )
  );

  const list = el("div", { class: "sticker-list" });
  const genBtn = el("button", {}, "Generate PDF") as HTMLButtonElement;
  const status = el("div", { class: "sticker-status" });

  const selectAllCb = el("input", { type: "checkbox" }) as HTMLInputElement;
  selectAllCb.checked = true;
  const selectAll = el("label", { class: "sticker-selectall" }, selectAllCb, " Select all");
  selectAllCb.addEventListener("change", () => {
    selected.clear();
    if (selectAllCb.checked) candidates.forEach((c) => selected.add(c.cardId));
    renderRows();
  });

  function updateGenLabel() {
    genBtn.textContent = `Generate PDF (${selected.size})`;
  }

  async function openImageSearch(c: StickerCandidate) {
    searchOpenFor = c.cardId;
    searchResults = [];
    searchError = null;
    searchLoading = true;
    renderRows();
    try {
      searchResults = await window.yoto.stickers.searchImages(c.title);
      if (searchResults.length === 0) searchError = "No results found.";
    } catch (err) {
      searchError = (err as Error).message;
    } finally {
      searchLoading = false;
      renderRows();
    }
  }

  function renderRows() {
    list.innerHTML = "";
    for (const c of candidates) {
      const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
      cb.checked = selected.has(c.cardId);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(c.cardId); else selected.delete(c.cardId);
        selectAllCb.checked = selected.size === candidates.length;
        updateGenLabel();
      });

      const override = imageOverrides.get(c.cardId);
      const effectiveCover = override?.thumbUrl ?? c.coverUrl;
      const cover = effectiveCover
        ? el("img", { class: "sticker-thumb", src: effectiveCover })
        : el("div", { class: "sticker-thumb sticker-thumb-placeholder" });

      const rowChildren: (Node | string)[] = [cb, cover, el("span", { class: "sticker-row-title" }, c.title)];

      // Always offer the search option, not just when there's no cover at all — a
      // playlist can have a coverUrl that Yoto set, but that image can still fail to
      // embed in the PDF (unsupported format, broken link, ...), so you need a way to
      // pick a replacement either way.
      const searchBtn = el(
        "button",
        { class: "secondary sticker-search-btn" },
        override || c.coverUrl ? "Choose another image…" : "Search for an image…"
      ) as HTMLButtonElement;
      searchBtn.type = "button";
      searchBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (searchOpenFor === c.cardId) {
          searchOpenFor = null;
          renderRows();
        } else {
          openImageSearch(c);
        }
      });
      rowChildren.push(searchBtn);

      list.append(el("label", { class: "sticker-row" }, ...rowChildren));

      if (searchOpenFor === c.cardId) {
        const panel = el("div", { class: "sticker-search-panel" });
        if (searchLoading) {
          panel.append(el("div", { class: "sticker-status" }, "Searching…"));
        } else if (searchError) {
          panel.append(el("div", { class: "sticker-status" }, searchError));
        } else {
          for (const r of searchResults) {
            const thumb = el("img", { class: "sticker-search-thumb", src: r.thumbUrl, title: `${r.title} (${r.source})` }) as HTMLImageElement;
            thumb.addEventListener("click", () => {
              imageOverrides.set(c.cardId, { url: r.url, thumbUrl: r.thumbUrl });
              searchOpenFor = null;
              renderRows();
            });
            panel.append(thumb);
          }
        }
        list.append(panel);
      }
    }
  }
  renderRows();
  updateGenLabel();

  genBtn.addEventListener("click", async () => {
    if (selected.size === 0) {
      status.textContent = "Select at least one playlist.";
      return;
    }
    genBtn.setAttribute("disabled", "true");
    status.textContent = "Creating PDF…";
    try {
      const items = candidates
        .filter((c) => selected.has(c.cardId))
        .map((c) => {
          const override = imageOverrides.get(c.cardId);
          return {
            title: c.title,
            coverUrl: override?.url ?? c.coverUrl,
            // Search results are usually arbitrary photos, not Yoto's own near-square
            // icon artwork — fill the whole card instead of leaving letterboxing.
            fit: override ? ("cover" as const) : ("contain" as const),
          };
        });
      const result = await window.yoto.stickers.generate(items);
      if (result.canceled) {
        status.textContent = "";
      } else if (result.ok) {
        const skippedNote = result.skipped?.length
          ? ` (${result.skipped.length} without an image: ${result.skipped.join(", ")})`
          : "";
        status.textContent = `Done! Saved ${result.count} card cover(s)${skippedNote}.`;
      } else {
        status.textContent = "Something went wrong while creating the PDF.";
      }
    } catch (err) {
      status.textContent = `Error: ${(err as Error).message}`;
    } finally {
      genBtn.removeAttribute("disabled");
    }
  });

  target.append(
    el(
      "section",
      { class: "print-covers-page" },
      header,
      el(
      "div",
      { class: "print-covers-content" },
      selectAll,
      list,
      el("div", { class: "print-covers-actions" }, status, genBtn)
      )
    )
  );
}

// Generates real card-size (53,98 × 85,6 mm) cover art for a single playlist — searches for
// official cover art (Apple Music) or lets you pick a file, bakes the title/artist onto it
// (blurred-and-scrimmed band behind the text, so it stays readable over any art), and sets
// the result as the playlist's actual Yoto cover. This is the in-app version of the "find
// art + bake title" routine; the print/sticker sheet then just lays out whatever cover is
// already on the playlist, baked or not.
function openCardArtModal(detail: Playlist) {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal card-art-modal" });
  overlay.append(modal);
  document.body.append(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const header = el(
    "div",
    { class: "modal-header" },
    el("h2", {}, "Create card cover"),
    modalCloseButton(close)
  );

  const titleInput = el("input", { class: "modal-search", type: "text", value: detail.title, placeholder: "Title" }) as HTMLInputElement;
  const artistInput = el("input", { class: "modal-search", type: "text", placeholder: "Artist / narrator (optional)" }) as HTMLInputElement;

  let mode: "photo" | "illustrated" = "photo";
  let chosenSource: { imageUrl?: string; imagePath?: string } | null = null;
  let variant = 0;
  // Manual crop adjustment for "photo" style — zoom 1 = default "cover" fit, panX/panY -1..1
  // (0 = centered) slide the visible window once zoomed in. panY starts at -0.6 (a slight
  // top bias) to match the old fixed automatic crop, so an untouched card looks the same as
  // before; these only move once someone actually drags a slider.
  const ZOOM_DEFAULT = 1;
  const PAN_X_DEFAULT = 0;
  const PAN_Y_DEFAULT = -0.6;
  let zoom = ZOOM_DEFAULT;
  let panX = PAN_X_DEFAULT;
  let panY = PAN_Y_DEFAULT;
  // "photo" style only. When the cover art is clear/legible enough by itself, this skips
  // baking the title/artist on top entirely — and with it the blur band and scrim that only
  // exist to make that text readable — leaving the cropped cover art untouched.
  let showTitle = true;
  let composedDataUrl: string | null = null;
  let composing = false;

  const preview = el("div", { class: "card-art-preview" });
  const status = el("div", { class: "sticker-status" });
  const setBtn = el("button", {}, "Set as card cover") as HTMLButtonElement;
  setBtn.setAttribute("disabled", "true");
  const saveBtn = el("button", { class: "secondary" }, "Save as file…") as HTMLButtonElement;
  saveBtn.setAttribute("disabled", "true");
  const refreshBtn = el("button", { class: "secondary" }, "Refresh preview") as HTMLButtonElement;
  refreshBtn.type = "button";
  refreshBtn.setAttribute("disabled", "true");

  const zoomInput = el("input", { type: "range", min: "1", max: "2.2", step: "0.05", value: String(ZOOM_DEFAULT) }) as HTMLInputElement;
  const panXInput = el("input", { type: "range", min: "-1", max: "1", step: "0.05", value: String(PAN_X_DEFAULT) }) as HTMLInputElement;
  const panYInput = el("input", { type: "range", min: "-1", max: "1", step: "0.05", value: String(PAN_Y_DEFAULT) }) as HTMLInputElement;
  const resetAdjustBtn = el("button", { class: "secondary" }, "Center") as HTMLButtonElement;
  resetAdjustBtn.type = "button";
  // The checkbox reads as a negative ("geen titel toevoegen"), so it has to be bound to
  // "no title" directly rather than to `showTitle` itself — otherwise checked/unchecked
  // ends up meaning the opposite of what the label says.
  const noTitleCb = el("input", { type: "checkbox" }) as HTMLInputElement;
  noTitleCb.checked = false; // default: title IS added
  noTitleCb.addEventListener("change", () => {
    showTitle = !noTitleCb.checked;
    recompose();
  });
  const showTitleRow = el(
    "label",
    { class: "card-art-title-toggle" },
    noTitleCb,
    el("span", {}, "Do not add a title (the cover is already clear enough)")
  );
  const adjustPanel = el(
    "div",
    { class: "card-art-adjust" },
    showTitleRow,
    el("label", { class: "card-art-adjust-row" }, el("span", {}, "Zoom"), zoomInput),
    el("label", { class: "card-art-adjust-row" }, el("span", { class: "adjust-label" }, "Pan", lucideIcon(ArrowLeftRight, "adjust-icon", 14)), panXInput),
    el("label", { class: "card-art-adjust-row" }, el("span", { class: "adjust-label" }, "Pan", lucideIcon(ArrowUpDown, "adjust-icon", 14)), panYInput),
    resetAdjustBtn
  );

  function resetAdjust() {
    zoom = ZOOM_DEFAULT;
    panX = PAN_X_DEFAULT;
    panY = PAN_Y_DEFAULT;
    zoomInput.value = String(ZOOM_DEFAULT);
    panXInput.value = String(PAN_X_DEFAULT);
    panYInput.value = String(PAN_Y_DEFAULT);
  }

  // Whether the cover is "clear enough on its own" is a judgment per image, so a freshly
  // picked source starts back at the default (title baked on) rather than carrying over the
  // previous image's choice. Called only when the SOURCE changes, not by "Centreren" (which
  // just re-centers the crop on the same image).
  function resetShowTitle() {
    showTitle = true;
    noTitleCb.checked = false;
  }

  // Recompose spins up a whole hidden BrowserWindow per call, so debounce slider drags
  // rather than recomposing on every intermediate tick — this collapses a drag into one call
  // shortly after the user stops moving the slider, instead of dozens mid-drag.
  let recomposeTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRecompose(delay = 220) {
    if (recomposeTimer) clearTimeout(recomposeTimer);
    recomposeTimer = setTimeout(() => {
      recomposeTimer = null;
      recompose();
    }, delay);
  }
  resetAdjustBtn.addEventListener("click", () => {
    resetAdjust();
    recompose();
  });
  zoomInput.addEventListener("input", () => { zoom = parseFloat(zoomInput.value); scheduleRecompose(); });
  panXInput.addEventListener("input", () => { panX = parseFloat(panXInput.value); scheduleRecompose(); });
  panYInput.addEventListener("input", () => { panY = parseFloat(panYInput.value); scheduleRecompose(); });

  function renderPreview() {
    preview.innerHTML = "";
    if (composing) {
      preview.append(el("div", { class: "card-art-preview-placeholder" }, el("span", { class: "spinner" }), " Composing…"));
    } else if (composedDataUrl) {
      preview.append(el("img", { class: "card-art-preview-img", src: composedDataUrl, alt: "" }));
    } else {
      preview.append(el("div", { class: "card-art-preview-placeholder" }, "Choose an image below or create an illustration."));
    }
    const hasSource = mode === "illustrated" || !!chosenSource;
    setBtn.toggleAttribute("disabled", !composedDataUrl || composing);
    saveBtn.toggleAttribute("disabled", !composedDataUrl || composing);
    refreshBtn.toggleAttribute("disabled", !hasSource || composing);
    adjustPanel.classList.toggle("card-art-adjust-hidden", !(mode === "photo" && !!chosenSource));
  }

  async function recompose() {
    if (mode === "photo" && !chosenSource) return;
    composing = true;
    composedDataUrl = null;
    status.textContent = "";
    renderPreview();
    try {
      const result = await window.yoto.cardArt.compose({
        title: titleInput.value.trim() || detail.title,
        artist: artistInput.value.trim() || undefined,
        style: mode,
        imageUrl: mode === "photo" ? chosenSource?.imageUrl : undefined,
        imagePath: mode === "photo" ? chosenSource?.imagePath : undefined,
        tracks: mode === "illustrated" ? detail.chapters.map((ch) => ch.title) : undefined,
        variant: mode === "illustrated" ? variant : undefined,
        zoom: mode === "photo" ? zoom : undefined,
        panX: mode === "photo" ? panX : undefined,
        panY: mode === "photo" ? panY : undefined,
        showTitle: mode === "photo" ? showTitle : undefined,
      });
      if (result.ok && result.dataUrl) {
        composedDataUrl = result.dataUrl;
      } else {
        status.textContent = result.error || "Could not compose the image.";
      }
    } catch (err) {
      status.textContent = (err as Error).message;
    } finally {
      composing = false;
      renderPreview();
    }
  }

  const searchResults = el("div", { class: "sticker-search-panel card-art-search-panel" });

  // Three search sources: "official" (Apple Music/Podcasts/Audiobooks/TV, for an actual
  // release), "book" (Google Books — where most Dutch/Flemish picture-book and luisterboek
  // covers actually live, since a lot of that content isn't in Apple's catalog at all), and
  // "generic" (Openverse stock/CC photos — the same search the print sheet already uses) for
  // playlists that aren't a real release at all, like a homemade mixtape or a compilation.
  async function runSearch(kind: "official" | "book" | "generic") {
    const q = `${titleInput.value.trim()} ${artistInput.value.trim()}`.trim() || detail.title;
    searchResults.innerHTML = "";
    searchResults.append(el("div", { class: "sticker-status" }, "Searching…"));
    try {
      const results =
        kind === "official" ? await window.yoto.cardArt.searchOfficial(q) :
        kind === "book" ? await window.yoto.cardArt.searchBooks(q) :
        await window.yoto.stickers.searchImages(q);
      searchResults.innerHTML = "";
      if (results.length === 0) {
        searchResults.append(
          el(
            "div",
            { class: "sticker-status" },
            kind === "official"
              ? "No results found — not an official release? Try 'Search books/audiobooks', 'Search generic images', or choose a file."
              : "No results found — try different search terms or choose a file."
          )
        );
      }
      for (const r of results) {
        const thumb = el("img", {
          class: "sticker-search-thumb",
          src: r.thumbUrl,
          title: `${r.title} (${r.source})`,
        }) as HTMLImageElement;
        thumb.addEventListener("click", () => {
          mode = "photo";
          chosenSource = { imageUrl: r.url };
          resetAdjust();
          resetShowTitle();
          recompose();
        });
        searchResults.append(thumb);
      }
    } catch (err) {
      searchResults.innerHTML = "";
      searchResults.append(el("div", { class: "sticker-status" }, (err as Error).message));
    }
  }

  const searchBtn = el("button", { class: "secondary" }, "Search official cover art") as HTMLButtonElement;
  searchBtn.type = "button";
  searchBtn.addEventListener("click", () => runSearch("official"));

  const bookSearchBtn = el(
    "button",
    { class: "secondary", title: "For audiobooks and picture books: search Google Books for a cover, including content that is not in Apple's music catalogue." },
    "Search books/audiobooks"
  ) as HTMLButtonElement;
  bookSearchBtn.type = "button";
  bookSearchBtn.addEventListener("click", () => runSearch("book"));

  const genericSearchBtn = el(
    "button",
    { class: "secondary", title: "For mixtapes and homemade playlists without an official release: search for a generic royalty-free image instead." },
    "Search generic images"
  ) as HTMLButtonElement;
  genericSearchBtn.type = "button";
  genericSearchBtn.addEventListener("click", () => runSearch("generic"));

  const illustratedBtn = el(
    "button",
    {
      class: "secondary",
      title: "Create a mixtape-style illustration (gradient and cassette tape with the real tracklist). No photo is needed.",
    },
    "Create illustration (mixtape style)"
  ) as HTMLButtonElement;
  illustratedBtn.type = "button";
  illustratedBtn.addEventListener("click", () => {
    mode = "illustrated";
    chosenSource = null;
    variant = 0;
    recompose();
  });

  const pickFileBtn = el("button", { class: "secondary" }, "Choose a file…") as HTMLButtonElement;
  pickFileBtn.type = "button";
  pickFileBtn.addEventListener("click", async () => {
    const filePath = await window.yoto.files.pickImage();
    if (!filePath) return;
    mode = "photo";
    chosenSource = { imagePath: filePath };
    resetAdjust();
    resetShowTitle();
    recompose();
  });

  // Free/keyless sources (Apple's catalog, Google Books, Openverse) simply don't index
  // everything — a niche or older Dutch/Flemish title can come up empty on all three even
  // though it's easy to find yourself with a normal web search. Rather than chase more APIs
  // for more content types, this is the general fallback: find it however you like (Google
  // Images, bol.com, a publisher's site, ...), right-click → copy image address, paste here.
  const urlInput = el("input", {
    class: "modal-search card-art-url-input",
    type: "text",
    placeholder: "…or paste the URL of an image you found here",
  }) as HTMLInputElement;
  const useUrlBtn = el("button", { class: "secondary" }, "Use") as HTMLButtonElement;
  useUrlBtn.type = "button";
  const useUrl = () => {
    const url = urlInput.value.trim();
    if (!url) return;
    mode = "photo";
    chosenSource = { imageUrl: url };
    resetAdjust();
    resetShowTitle();
    recompose();
  };
  useUrlBtn.addEventListener("click", useUrl);
  urlInput.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Enter") useUrl();
  });

  // For the illustrated style, "refresh" reshuffles the gradient/decoration pick (bump the
  // variant) rather than just recomputing the same deterministic result.
  refreshBtn.addEventListener("click", () => {
    if (mode === "illustrated") variant += 1;
    recompose();
  });

  setBtn.addEventListener("click", async () => {
    if (!composedDataUrl) return;
    setBtn.setAttribute("disabled", "true");
    status.textContent = "Setting card cover…";
    try {
      const tempPath = await window.yoto.cardArt.writeTemp(composedDataUrl);
      const uploadResult = await window.yoto.cover.upload(tempPath);
      await window.yoto.playlists.setCover(detail.cardId, uploadResult.mediaUrl);
      detail.coverUrl = uploadResult.mediaUrl;
      detail.updatedAt = new Date().toISOString();
      const summary = state.summaries?.find((p) => p.cardId === detail.cardId);
      if (summary) {
        summary.coverUrl = uploadResult.mediaUrl;
        summary.updatedAt = detail.updatedAt;
      }
      state.details.delete(detail.cardId);
      renderSidebar();
      status.textContent = "Card cover set!";
      if (state.selectedCardId === detail.cardId) await selectPlaylist(detail.cardId);
      setTimeout(close, 700);
    } catch (err) {
      status.textContent = `Error: ${(err as Error).message}`;
      setBtn.removeAttribute("disabled");
    }
  });

  saveBtn.addEventListener("click", async () => {
    if (!composedDataUrl) return;
    try {
      const result = await window.yoto.cardArt.saveAs(composedDataUrl, `${detail.title || "card-cover"}.png`);
      if (result.ok && result.path) status.textContent = `Saved: ${result.path}`;
    } catch (err) {
      status.textContent = `Error: ${(err as Error).message}`;
    }
  });

  renderPreview();

  modal.append(
    header,
    el(
      "div",
      { class: "modal-body card-art-modal-body" },
      el(
        "p",
        { class: "sticker-intro" },
        "Search official cover art (Apple Music/Podcasts/Audiobooks/TV), a book cover for an audiobook, or a generic image; or create a mixtape-style illustration with the tracklist. Found something through Google, bol.com, or elsewhere that our searches miss? Choose a file or paste its image URL. The title and optional artist are added to the image at credit-card size (53.98 × 85.6 mm), ready to set as the card cover."
      ),
      el("label", { class: "card-art-field" }, "Title", titleInput),
      el("label", { class: "card-art-field" }, "Artist / narrator (optional)", artistInput),
      el("div", { class: "card-art-source-buttons" }, searchBtn, bookSearchBtn, genericSearchBtn, illustratedBtn, pickFileBtn),
      el("div", { class: "card-art-url-row" }, urlInput, useUrlBtn),
      searchResults,
      preview,
      adjustPanel,
      el("div", { class: "card-art-actions" }, refreshBtn, saveBtn, setBtn),
      status
    )
  );
}

async function openIconPickerForChapter(cardId: string, chapterIndex: number) {
  await openIconPicker(async (picked) => {
    try {
      await window.yoto.playlists.setChapterIcon(cardId, chapterIndex, `yoto:#${picked.mediaId}`);
      const detail = state.details.get(cardId);
      if (detail && detail.chapters[chapterIndex]) {
        detail.chapters[chapterIndex].iconUrl = picked.url;
      }
      state.details.delete(cardId);
      if (state.selectedCardId === cardId) {
        await selectPlaylist(cardId);
      }
    } catch (err) {
      showDetailError(`Couldn't set icon: ${(err as Error).message}`);
    }
  });
}

interface PickedIcon { mediaId: string; url: string }

async function openIconPicker(onPick: (icon: PickedIcon) => void | Promise<void>) {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal" });
  overlay.append(modal);
  document.body.append(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  let activeTab: "public" | "user" | "upload" = "public";
  let publicFilter = "";

  const render = () => {
    modal.innerHTML = "";
    const header = el(
      "div",
      { class: "modal-header" },
      el("h2", {}, "Pick an icon"),
      modalCloseButton(close)
    );

    const tabs = el("div", { class: "modal-tabs" });
    for (const t of ["public", "user", "upload"] as const) {
      const tabEl = el("button", { class: "modal-tab" + (activeTab === t ? " active" : "") }, t === "public" ? "Public library" : t === "user" ? "Your icons" : "Upload");
      tabEl.addEventListener("click", () => { activeTab = t; render(); });
      tabs.append(tabEl);
    }

    const body = el("div", { class: "modal-body" });

    if (activeTab === "public") {
      // Plain "text", not "search" — this was the only type="search" input anywhere in the
      // app (every other field, including the sidebar/playlist search boxes, uses "text" and
      // works fine). Some Chromium/Windows builds render type="search" fields oddly or let the
      // OS try to hook into them, which lines up with it looking disabled/unresponsive.
      const search = el("input", { type: "text", placeholder: "Filter by tag (e.g. cat, music, story)…", class: "modal-search" }) as HTMLInputElement;
      search.value = publicFilter;
      search.addEventListener("input", () => { publicFilter = search.value.trim().toLowerCase(); renderGrid(); });
      body.append(search);
      const grid = el("div", { class: "icon-grid", id: "icon-grid" });
      body.append(grid);

      const renderGrid = () => {
        grid.innerHTML = "";
        if (!iconCache.public) {
          grid.append(el("div", { class: "empty" }, "Loading public icons…"));
          return;
        }
        const filtered = publicFilter
          ? iconCache.public.filter((i) =>
              i.title.toLowerCase().includes(publicFilter) ||
              i.tags.some((tag) => tag.toLowerCase().includes(publicFilter))
            )
          : iconCache.public;
        if (filtered.length === 0) {
          grid.append(el("div", { class: "empty" }, "No icons match."));
          return;
        }
        for (const icon of filtered.slice(0, 500)) {
          const tile = el("button", { class: "icon-tile", title: icon.title || "" });
          if (icon.url) tile.append(el("img", { src: icon.url, alt: icon.title || "" }));
          tile.addEventListener("click", async () => {
            await onPick({ mediaId: icon.mediaId, url: icon.url });
            close();
          });
          grid.append(tile);
        }
      };
      ensureIconsLoaded().then(renderGrid);
      renderGrid();
    } else if (activeTab === "user") {
      const grid = el("div", { class: "icon-grid" });
      body.append(grid);
      const renderGrid = () => {
        grid.innerHTML = "";
        if (!iconCache.user) {
          grid.append(el("div", { class: "empty" }, "Loading your icons…"));
          return;
        }
        if (iconCache.user.length === 0) {
          grid.append(el("div", { class: "empty" }, "You haven't uploaded any icons yet. Use the Upload tab."));
          return;
        }
        for (const icon of iconCache.user) {
          const tile = el("button", { class: "icon-tile" });
          if (icon.url) tile.append(el("img", { src: icon.url, alt: "" }));
          tile.addEventListener("click", async () => {
            await onPick({ mediaId: icon.mediaId, url: icon.url });
            close();
          });
          grid.append(tile);
        }
      };
      ensureIconsLoaded().then(renderGrid);
      renderGrid();
    } else {
      const status = el("div", { class: "upload-status muted" }, "Drop any image (Yoto will auto-resize to 16×16) or pick a file.");
      const pickBtn = el("button", {}, "Choose image…");
      pickBtn.addEventListener("click", async () => {
        const filePath = await window.yoto.files.pickImage();
        if (!filePath) return;
        status.textContent = "Uploading…";
        try {
          const uploaded = await window.yoto.icons.upload(filePath);
          if (iconCache.user) iconCache.user.unshift(uploaded);
          await onPick({ mediaId: uploaded.mediaId, url: uploaded.url });
          close();
        } catch (err) {
          status.textContent = `Upload failed: ${(err as Error).message}`;
        }
      });
      body.append(status, pickBtn);
    }

    modal.append(header, tabs, body);
  };

  render();
}

function setupGlobalDrop() {
  document.addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer) return;
    if (!Array.from(ev.dataTransfer.types).includes("Files")) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    document.body.classList.add("drag-active");
  });
  document.addEventListener("dragleave", (ev) => {
    if (!ev.relatedTarget) document.body.classList.remove("drag-active");
  });
  document.addEventListener("drop", async (ev) => {
    if (!ev.dataTransfer) return;
    const files = Array.from(ev.dataTransfer.files);
    if (files.length === 0) return;
    ev.preventDefault();
    document.body.classList.remove("drag-active");
    if (state.view !== "main") return;

    const paths = files.map((f) => window.yoto.files.pathForDroppedFile(f));
    const resolved = await window.yoto.files.resolveDropPaths(paths);
    if (resolved.audioFiles.length === 0) return;

    // Route: if viewing an existing playlist, append to it. Otherwise, start/extend a draft.
    if (state.selectedCardId && !state.draft) {
      await beginAppendToExisting(state.selectedCardId, resolved.audioFiles);
      return;
    }

    if (!state.draft) {
      state.draft = { title: resolved.folderName || "Untitled playlist", tracks: [] };
    } else if (state.draft.title === "Untitled playlist" && resolved.folderName) {
      state.draft.title = resolved.folderName;
    }
    state.selectedCardId = undefined;
    state.tab = "playlists";
    render();
    await appendFilesToDraft(resolved.audioFiles);
  });
}

async function beginAppendToExisting(cardId: string, filePaths: string[]) {
  const newTracks: AppendingTrack[] = filePaths.map((p) => {
    const fname = basename(p);
    return {
      localId: uid(),
      filename: fname,
      filePath: p,
      title: cleanTitleFromFilename(fname),
      status: "queued",
    };
  });
  const existing = state.appending.get(cardId) ?? [];
  state.appending.set(cardId, [...existing, ...newTracks]);
  renderDetail();

  const queue = [...newTracks];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (queue.length > 0) {
        const t = queue.shift();
        if (!t) return;
        await uploadAppendingTrack(cardId, t);
      }
    })
  );
}

async function uploadAppendingTrack(cardId: string, t: AppendingTrack) {
  if (t.status !== "queued") return;
  try {
    const result = await window.yoto.audio.upload(t.localId, t.filePath, (stage) => {
      t.status = stage;
      if (state.selectedCardId === cardId) renderDetail();
    });
    t.status = "done";
    t.trackSha256 = result.trackSha256;
    t.durationSec = result.durationSec;
    t.fileSize = result.serverFileSize;
    t.format = result.format;
    t.channels = result.channels;
    // Auto-icon for appended track
    ensureIconsLoaded().then(() => {
      if (!iconCache.public) return;
      const list = state.appending.get(cardId);
      const found = list?.find((x) => x.localId === t.localId);
      if (!found || found.iconRef) return;
      const icon = pickIconForTitle(found.title, iconCache.public);
      if (icon) {
        found.iconRef = `yoto:#${icon.mediaId}`;
        found.iconUrl = icon.url;
        if (state.selectedCardId === cardId) renderDetail();
      }
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "aborted" || msg.toLowerCase().includes("abort")) {
      t.status = "cancelled";
    } else {
      t.status = "error";
      t.errorMessage = msg;
    }
  }
  if (state.selectedCardId === cardId) renderDetail();
}

async function commitAppend(cardId: string) {
  const list = state.appending.get(cardId) ?? [];
  const ready = list.filter((t) => t.status === "done" && t.trackSha256);
  if (ready.length === 0) return;
  try {
    await window.yoto.playlists.appendTracks(
      cardId,
      ready.map((t) => ({
        title: t.title,
        trackSha256: t.trackSha256!,
        durationSec: t.durationSec,
        fileSize: t.fileSize,
        iconRef: t.iconRef,
        format: t.format,
        channels: t.channels,
      }))
    );
    state.appending.delete(cardId);
    state.details.delete(cardId);
    await selectPlaylist(cardId);
  } catch (err) {
    showDetailError(`Couldn't append: ${(err as Error).message}`);
  }
}

async function deleteExistingPlaylist(cardId: string, title: string) {
  if (!confirm(`Permanently delete "${title}"? Linked physical cards will stop working until you re-link them to another playlist.`)) return;
  try {
    await window.yoto.playlists.delete(cardId);
    state.details.delete(cardId);
    state.summaries = state.summaries?.filter((p) => p.cardId !== cardId);
    state.selectedCardId = undefined;
    render();
  } catch (err) {
    showDetailError(`Delete failed: ${(err as Error).message}`);
  }
}

async function deleteChapterFromPlaylist(detail: Playlist, index: number) {
  const chapter = detail.chapters[index];
  if (!chapter) return;
  if (detail.chapters.length <= 1) {
    alert("You cannot remove the last track from a playlist.");
    return;
  }
  if (!chapter.key) {
    showDetailError("Cannot remove this track: its chapter key is unknown. Try refreshing the playlist.");
    return;
  }
  const label = chapter.tracks[0]?.title || chapter.title || `Track ${index + 1}`;
  if (!confirm(`Remove "${label}" from this playlist? This cannot be undone.`)) return;

  const removed = detail.chapters.splice(index, 1)[0];
  renderDetail();
  try {
    await window.yoto.playlists.deleteChapter(detail.cardId, chapter.key);
    state.details.delete(detail.cardId);
    if (state.selectedCardId === detail.cardId) await selectPlaylist(detail.cardId);
  } catch (err) {
    detail.chapters.splice(index, 0, removed);
    renderDetail();
    showDetailError(`Remove failed: ${(err as Error).message}`);
  }
}

function openExistingId3ImportModal(detail: Playlist) {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal id3-import-modal" });
  overlay.append(modal);
  document.body.append(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });

  type TitleChange = { index: number; from: string; to: string };
  let changes: TitleChange[] = [];
  let fileCount = 0;
  let matchedFileCount = 0;
  let unmatchedFileCount = 0;
  let loading = false;

  const chapterTitle = (chapter: Chapter) =>
    chapter.tracks.length === 1 ? chapter.tracks[0]?.title || chapter.title : chapter.title;
  const filenameKey = (filePath: string) => {
    const filename = filePath.split(/[\\/]/).pop() ?? filePath;
    return filename
      .replace(/\.[^.]+$/, "")
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  };

  const selectBtn = el("button", { class: "secondary id3-import-select" }, "Select original audio files…") as HTMLButtonElement;
  const cancelBtn = el("button", { class: "secondary" }, "Cancel") as HTMLButtonElement;
  const saveBtn = el("button", {}, "Save changes") as HTMLButtonElement;
  saveBtn.disabled = true;
  const status = el("p", { class: "id3-import-status" }, "Select the original audio files to preview their ID3 title tags.");
  const preview = el("div", { class: "id3-import-preview" });

  function renderPreview() {
    preview.innerHTML = "";
    saveBtn.disabled = loading || changes.length === 0;
    if (loading) {
      status.textContent = "Reading ID3 title tags…";
      return;
    }
    if (fileCount === 0) return;
    if (changes.length === 0) {
      status.textContent = `Matched ${matchedFileCount} of ${fileCount} selected file${fileCount === 1 ? "" : "s"} to playlist tracks. No ID3 title changes were found.${unmatchedFileCount ? ` ${unmatchedFileCount} file${unmatchedFileCount === 1 ? " was" : "s were"} not matched.` : ""}`;
      return;
    }
    status.textContent = `${changes.length} title change${changes.length === 1 ? "" : "s"} ready to save. Matched ${matchedFileCount} of ${fileCount} selected file${fileCount === 1 ? "" : "s"} by filename.${unmatchedFileCount ? ` ${unmatchedFileCount} file${unmatchedFileCount === 1 ? " was" : "s were"} not matched.` : ""}`;
    for (const { from, to } of changes) {
      preview.append(
        el(
          "div",
          { class: "id3-import-change" },
          el("span", { class: "id3-import-from" }, from),
          lucideIcon(ArrowRight, "id3-import-arrow", 16),
          el("span", { class: "id3-import-to" }, to)
        )
      );
    }
  }

  selectBtn.addEventListener("click", async () => {
    const filePaths = await window.yoto.files.pickAudioFiles();
    if (!filePaths) return;
    fileCount = filePaths.length;
    changes = [];
    matchedFileCount = 0;
    unmatchedFileCount = 0;
    loading = true;
    selectBtn.disabled = loading;
    renderPreview();

    try {
      const id3Titles = await window.yoto.files.readId3Titles(filePaths);
      const chapterIndicesByTitle = new Map<string, number[]>();
      detail.chapters.forEach((chapter, index) => {
        const key = filenameKey(chapterTitle(chapter));
        if (!key) return;
        const indices = chapterIndicesByTitle.get(key) ?? [];
        indices.push(index);
        chapterIndicesByTitle.set(key, indices);
      });

      const usedChapterIndices = new Set<number>();
      filePaths.forEach((filePath, fileIndex) => {
        const matches = chapterIndicesByTitle.get(filenameKey(filePath))?.filter((index) => !usedChapterIndices.has(index)) ?? [];
        if (matches.length !== 1) {
          unmatchedFileCount += 1;
          return;
        }
        const index = matches[0];
        const from = chapterTitle(detail.chapters[index]);
        const to = id3Titles[fileIndex]?.trim();
        usedChapterIndices.add(index);
        matchedFileCount += 1;
        if (to && to !== from) changes.push({ index, from, to });
      });
    } catch (err) {
      fileCount = 0;
      status.textContent = `Couldn't read ID3 titles: ${(err as Error).message}`;
    } finally {
      loading = false;
      selectBtn.disabled = false;
      renderPreview();
    }
  });

  saveBtn.addEventListener("click", async () => {
    if (changes.length === 0) return;
    saveBtn.disabled = true;
    selectBtn.disabled = true;
    status.textContent = "Saving title changes…";
    try {
      await window.yoto.playlists.setTitles(detail.cardId, changes.map(({ index, to }) => ({ chapterIndex: index, title: to })));
      state.details.delete(detail.cardId);
      close();
      if (state.selectedCardId === detail.cardId) await selectPlaylist(detail.cardId);
    } catch (err) {
      selectBtn.disabled = false;
      saveBtn.disabled = false;
      status.textContent = `Couldn't update titles: ${(err as Error).message}`;
    }
  });
  cancelBtn.addEventListener("click", close);

  modal.append(
    el("div", { class: "modal-header" }, el("h2", {}, "Read titles from ID3 tag"), modalCloseButton(close)),
    el(
      "div",
      { class: "modal-body id3-import-modal-body" },
      el("p", { class: "sticker-intro" }, "Choose the original audio files. Each filename is matched to the current playlist title, so additional files are safely ignored."),
      selectBtn,
      status,
      preview,
      el("div", { class: "id3-import-actions" }, cancelBtn, saveBtn)
    )
  );
}

async function cleanTitlesForPlaylist(cardId: string, btn: HTMLButtonElement) {
  const detail = state.details.get(cardId);
  if (!detail || detail.chapters.length === 0) return;

  const originalTitles = detail.chapters.map((ch, i) => ch.tracks[0]?.title || ch.title || `Track ${i + 1}`);
  const cleaned = cleanPlaylistTitles(originalTitles);

  const changes = cleaned
    .map((title, i) => ({ chapterIndex: i, title, original: originalTitles[i] }))
    .filter((c) => c.title && c.title !== c.original);

  if (changes.length === 0) {
    setToolbarButtonLabel(btn, BroomSparkles, "Nothing to clean");
    setTimeout(() => setToolbarButtonLabel(btn, BroomSparkles, "Clean titles"), 1800);
    return;
  }

  const preview = changes.slice(0, 8).map((c) => `"${c.original}" → "${c.title}"`).join("\n");
  const more = changes.length > 8 ? `\n… and ${changes.length - 8} more` : "";
  const ok = confirm(`Update ${changes.length} title(s)?\n\n${preview}${more}`);
  if (!ok) return;

  btn.setAttribute("disabled", "true");
  setToolbarButtonLabel(btn, BroomSparkles, "Saving…");
  try {
    await window.yoto.playlists.setTitles(cardId, changes.map(({ chapterIndex, title }) => ({ chapterIndex, title })));
    state.details.delete(cardId);
    if (state.selectedCardId === cardId) await selectPlaylist(cardId);
    setToolbarButtonLabel(btn, Check, `Updated ${changes.length} title(s)`);
    setTimeout(() => { setToolbarButtonLabel(btn, BroomSparkles, "Clean titles"); btn.removeAttribute("disabled"); }, 2400);
  } catch (err) {
    setToolbarButtonLabel(btn, BroomSparkles, "Clean titles");
    btn.removeAttribute("disabled");
    showDetailError(`Cleaning titles failed: ${(err as Error).message}`);
  }
}

async function autoChooseIconsForPlaylist(cardId: string, btn: HTMLButtonElement) {
  const detail = state.details.get(cardId);
  if (!detail || detail.chapters.length === 0) return;

  const ok = confirm(
    `Auto-choose icons for all ${detail.chapters.length} track${detail.chapters.length === 1 ? "" : "s"} in this playlist?\n\n` +
    `This will REPLACE every existing icon (including ones you've manually picked) with the AI's best semantic match. ` +
    `Tracks with no decent match are left unchanged.\n\nThis cannot be undone (other than re-picking icons by hand).`
  );
  if (!ok) return;

  btn.setAttribute("disabled", "true");
  setToolbarButtonLabel(btn, Stars, "Loading icons…");
  await ensureIconsLoaded();
  if (!iconCache.public || iconCache.public.length === 0) {
    setToolbarButtonLabel(btn, Stars, "No icon library");
    setTimeout(() => { setToolbarButtonLabel(btn, Stars, "Auto-choose icons"); btn.removeAttribute("disabled"); }, 1800);
    return;
  }

  setToolbarButtonLabel(btn, Stars, "AI matching…");
  let results;
  try {
    results = await window.yoto.icons.semanticMatch(
      detail.chapters.map((ch) => ch.title || ch.tracks[0]?.title || ""),
      iconCache.public.map((i) => ({ mediaId: i.mediaId, title: i.title, url: i.url, tags: i.tags })),
      0.32
    );
  } catch (err) {
    setToolbarButtonLabel(btn, Stars, "Auto-choose icons");
    btn.removeAttribute("disabled");
    showDetailError(`Auto-choose failed: ${(err as Error).message}`);
    return;
  }

  const updates = results
    .map((r, i) => (r.mediaId ? { chapterIndex: i, iconRef: `yoto:#${r.mediaId}` } : null))
    .filter((x): x is { chapterIndex: number; iconRef: string } => x !== null);

  if (updates.length === 0) {
    setToolbarButtonLabel(btn, Stars, "No good matches");
    setTimeout(() => { setToolbarButtonLabel(btn, Stars, "Auto-choose icons"); btn.removeAttribute("disabled"); }, 1800);
    return;
  }

  setToolbarButtonLabel(btn, Stars, "Saving…");
  try {
    await window.yoto.playlists.setIcons(cardId, updates);
    state.details.delete(cardId);
    const skipped = detail.chapters.length - updates.length;
    setToolbarButtonLabel(btn, Check, skipped > 0 ? `Updated ${updates.length}, ${skipped} blank` : `Updated all ${updates.length}`);
    if (state.selectedCardId === cardId) await selectPlaylist(cardId);
    setTimeout(() => { setToolbarButtonLabel(btn, Stars, "Auto-choose icons"); btn.removeAttribute("disabled"); }, 2400);
  } catch (err) {
    setToolbarButtonLabel(btn, Stars, "Auto-choose icons");
    btn.removeAttribute("disabled");
    showDetailError(`Auto-choose failed: ${(err as Error).message}`);
  }
}

async function repairExistingCard(cardId: string, btn: HTMLButtonElement) {
  btn.setAttribute("disabled", "true");
  setToolbarButtonLabel(btn, HardDriveDownload, "Fixing…");
  try {
    await window.yoto.playlists.repair(cardId);
    setToolbarButtonLabel(btn, Check, "Fixed");
    state.details.delete(cardId);
    setTimeout(() => {
      btn.removeAttribute("disabled");
      setToolbarButtonLabel(btn, HardDriveDownload, "Fix on player");
    }, 2000);
  } catch (err) {
    btn.removeAttribute("disabled");
    setToolbarButtonLabel(btn, HardDriveDownload, "Fix on player");
    showDetailError(`Repair failed: ${(err as Error).message}`);
  }
}

function beginRename(titleEl: HTMLElement, detail: Playlist) {
  if (titleEl.querySelector("input")) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "detail-title-input";
  input.value = detail.title;
  titleEl.replaceChildren(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const next = input.value.trim();
    if (!next || next === detail.title) {
      setTitleDisplay(titleEl, detail.title);
      return;
    }
    titleEl.replaceChildren(el("span", { class: "saving" }, next, " …saving"));
    try {
      await window.yoto.playlists.rename(detail.cardId, next);
      detail.title = next;
      const summary = state.summaries?.find((p) => p.cardId === detail.cardId);
      if (summary) summary.title = next;
      setTitleDisplay(titleEl, next);
      renderSidebar();
    } catch (err) {
      setTitleDisplay(titleEl, detail.title);
      titleEl.append(el("span", { class: "error inline" }, ` rename failed: ${(err as Error).message}`));
    }
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      input.blur();
    } else if (ev.key === "Escape") {
      committed = true;
      setTitleDisplay(titleEl, detail.title);
    }
  });
}

async function loadPlaylists() {
  try {
    const summaries = await window.yoto.playlists.list();
    state.summaries = summaries;
    renderSidebar();
    refreshAllCoversFromDetail();
  } catch (err) {
    const target = document.getElementById("playlists");
    if (target) {
      target.innerHTML = "";
      target.append(el("div", { class: "empty" }, `Couldn't load playlists: ${(err as Error).message}`));
    }
  }
}

async function loadFamilyPlaylists() {
  try {
    const summaries = await window.yoto.playlists.listFamily();
    state.familySummaries = summaries;
    renderFamilySidebar();
  } catch (err) {
    const target = document.getElementById("family-playlists");
    if (target) {
      target.innerHTML = "";
      target.append(el("div", { class: "empty" }, `Couldn't load family playlists: ${(err as Error).message}`));
    }
  }
}

async function refreshAllCoversFromDetail() {
  if (!state.summaries) return;
  const summaries = state.summaries.slice();
  const concurrency = 4;
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < summaries.length) {
        const idx = i++;
        const s = summaries[idx];
        try {
          const detail = await window.yoto.playlists.get(s.cardId);
          state.details.set(s.cardId, detail);
          const fresh = state.summaries?.find((x) => x.cardId === s.cardId);
          if (fresh) {
            let changed = false;
            if (detail.coverUrl && detail.coverUrl !== fresh.coverUrl) {
              fresh.coverUrl = detail.coverUrl;
              changed = true;
            }
            if (detail.updatedAt && detail.updatedAt !== fresh.updatedAt) {
              fresh.updatedAt = detail.updatedAt;
              changed = true;
            }
            if (detail.title !== fresh.title) {
              fresh.title = detail.title;
              changed = true;
            }
            if (changed) renderSidebar();
          }
        } catch {}
      }
    })
  );
}

async function selectPlaylist(cardId: string) {
  state.selectedCardId = cardId;
  renderSidebar();
  renderDetail();

  if (state.details.has(cardId)) return;
  try {
    const full = await window.yoto.playlists.get(cardId);
    state.details.set(cardId, full);
    if (state.selectedCardId === cardId) renderDetail();
  } catch (err) {
    const target = document.getElementById("detail");
    if (target) {
      target.innerHTML = "";
      target.append(el("p", { class: "error" }, `Couldn't load playlist: ${(err as Error).message}`));
    }
  }
}

async function startSignIn() {
  state.error = undefined;
  state.view = "signing-in";
  render();
  try {
    const dc = await window.yoto.auth.start();
    state.deviceCode = { userCode: dc.userCode, verificationUriComplete: dc.verificationUriComplete };
    render();
  } catch (err) {
    state.error = (err as Error).message;
    state.view = "welcome";
    render();
  }
}

window.yoto.auth.onComplete((result) => {
  if (result.ok) {
    state.view = "main";
    state.deviceCode = undefined;
    render();
  } else {
    state.error = result.error || "Sign-in failed.";
    state.view = "welcome";
    state.deviceCode = undefined;
    render();
  }
});

setupGlobalDrop();

(async () => {
  const [status] = await Promise.all([
    window.yoto.auth.status(),
    window.yoto.app.getVersion().then((v) => { appVersion = v; }),
  ]);
  state.view = status.signedIn ? "main" : "welcome";
  render();
})();
