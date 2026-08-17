import { app } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pipeline, env } from "@huggingface/transformers";

interface IconLite {
  mediaId: string;
  title: string;
  url: string;
  tags: string[];
}

interface State {
  extractor: ((text: string | string[], opts: object) => Promise<{ data: Float32Array; dims: number[] }>) | null;
  loading: Promise<void> | null;
  iconVectors: Map<string, Float32Array>;
  iconLibVersion: number;
}

const state: State = {
  extractor: null,
  loading: null,
  iconVectors: new Map(),
  iconLibVersion: 0,
};

function modelsRoot(): string {
  // In dev: <projectRoot>/models. In packaged app: process.resourcesPath/models.
  const dev = path.resolve(__dirname, "..", "models");
  if (existsSync(dev)) return dev;
  return path.join(process.resourcesPath || dev, "models");
}

async function ensureExtractor(): Promise<void> {
  if (state.extractor) return;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    env.localModelPath = modelsRoot();
    env.cacheDir = path.join(app.getPath("userData"), "model-cache");
    env.allowRemoteModels = false;
    state.extractor = (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "q8",
    })) as unknown as State["extractor"];
  })();
  await state.loading;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  await ensureExtractor();
  const out = await state.extractor!(texts, { pooling: "mean", normalize: true });
  const dim = out.dims[1];
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(out.data.slice(i * dim, (i + 1) * dim) as Float32Array);
  }
  return vectors;
}

export async function ensureIconsEmbedded(icons: IconLite[]): Promise<void> {
  // Re-embed only if library composition changed (cardinality + ordered ids hash)
  const sig = icons.length + ":" + icons.slice(0, 32).map((i) => i.mediaId).join("");
  const hashed = simpleHash(sig);
  if (hashed === state.iconLibVersion && state.iconVectors.size === icons.length) return;

  const texts = icons.map(
    (i) => `${i.title || ""}. ${(i.tags || []).filter(Boolean).join(", ")}`.trim()
  );
  // Embed in batches to avoid memory spikes
  const batchSize = 64;
  state.iconVectors.clear();
  for (let i = 0; i < icons.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const vecs = await embedBatch(slice);
    for (let j = 0; j < slice.length; j++) {
      state.iconVectors.set(icons[i + j].mediaId, vecs[j]);
    }
  }
  state.iconLibVersion = hashed;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

export interface MatchResult {
  title: string;
  mediaId: string | null;
  url: string | null;
  iconTitle: string | null;
  score: number;
}

const STOP = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","for","with","by","from","is","are","was","were","be","been","being",
  "it","its","this","that","these","those","my","your","our","their","i","you","he","she","they","we","me","him","her","them","us",
  "do","does","did","done","have","has","had","will","would","could","should","may","might","can",
  "just","not","no","yes","up","down","out","off","over","under","into","onto","than","then","so","as","if",
  "song","track","title","intro","outro","interlude","bonus","disc","cd","mp3","aac","opus","ogg","pt","part","vol","volume","ep","lp",
]);

// Concept clusters for common Yoto content themes (kids' stories, songs, nursery rhymes).
// Maps a trigger word to a handful of closely related words. Used to (a) strengthen the
// tag/title lexical boost for topical-but-not-literal matches (e.g. "wings" -> bird icons)
// and (b) enrich the text fed to the embedding model so the vector itself leans the same way.
// This is intentionally conservative/curated rather than exhaustive — extend it as real
// mismatches turn up (see debug/icon-matches.json after a match run).
const CONCEPTS: Record<string, string[]> = {
  wing: ["bird", "feather", "fly", "flying"],
  wings: ["bird", "feather", "fly", "flying"],
  feather: ["bird", "wing", "fly"],
  beak: ["bird"],
  nest: ["bird", "egg"],
  paw: ["dog", "cat", "animal", "cub"],
  paws: ["dog", "cat", "animal", "cub"],
  claw: ["animal", "dragon", "bear"],
  tail: ["animal", "dog", "cat", "mermaid"],
  fin: ["fish", "shark", "mermaid", "ocean"],
  scale: ["fish", "dragon", "snake"],
  scales: ["fish", "dragon", "snake"],
  roar: ["lion", "dinosaur", "bear", "tiger"],
  moo: ["cow", "farm"],
  oink: ["pig", "farm"],
  baa: ["sheep", "farm"],
  quack: ["duck", "farm", "pond"],
  hoot: ["owl", "night"],
  buzz: ["bee", "insect"],
  howl: ["wolf", "night"],
  splash: ["water", "ocean", "pool", "rain"],
  wave: ["ocean", "sea", "beach", "water"],
  tide: ["ocean", "sea", "beach"],
  storm: ["rain", "thunder", "weather", "cloud"],
  thunder: ["storm", "rain", "lightning", "weather"],
  lightning: ["storm", "thunder", "weather"],
  rainbow: ["rain", "sun", "colour", "color"],
  snow: ["winter", "cold", "ice", "weather"],
  frost: ["winter", "cold", "ice"],
  starlight: ["star", "night", "sky", "moon"],
  moonlight: ["moon", "night", "sky", "star"],
  sunrise: ["sun", "morning", "sky"],
  sunset: ["sun", "evening", "sky"],
  engine: ["train", "car", "vehicle"],
  wheel: ["car", "train", "bike", "vehicle"],
  wheels: ["car", "train", "bike", "vehicle"],
  track: ["train", "railway"],
  cockpit: ["plane", "rocket", "pilot"],
  runway: ["plane", "airport"],
  anchor: ["boat", "ship", "sea"],
  sail: ["boat", "ship", "wind", "sea"],
  crew: ["pirate", "ship", "boat"],
  treasure: ["pirate", "gold", "map", "adventure"],
  castle: ["princess", "knight", "king", "queen", "fairy tale"],
  crown: ["king", "queen", "princess", "prince"],
  sword: ["knight", "dragon", "battle"],
  shield: ["knight", "battle", "armour", "armor"],
  spell: ["magic", "witch", "wizard"],
  potion: ["magic", "witch", "wizard"],
  broomstick: ["witch", "magic"],
  fang: ["vampire", "dragon", "wolf"],
  howling: ["wolf", "night"],
  lullaby: ["sleep", "bedtime", "night", "moon"],
  snore: ["sleep", "bedtime"],
  dream: ["sleep", "bedtime", "night", "star"],
  yawn: ["sleep", "bedtime", "tired"],
  cradle: ["baby", "sleep", "bedtime"],
  bottle: ["baby"],
  rattle: ["baby", "toy"],
  candle: ["birthday", "cake", "party"],
  balloon: ["party", "birthday", "celebration"],
  confetti: ["party", "birthday", "celebration"],
  pumpkin: ["halloween", "autumn", "fall"],
  ghost: ["halloween", "spooky", "scary"],
  spider: ["halloween", "spooky", "bug", "insect"],
  bat: ["halloween", "night", "spooky"],
  tinsel: ["christmas", "winter", "holiday"],
  sleigh: ["christmas", "winter", "santa"],
  reindeer: ["christmas", "winter", "santa"],
  gift: ["birthday", "christmas", "present"],
  present: ["birthday", "christmas", "gift"],
  count: ["number", "counting", "maths", "math"],
  counting: ["number", "count", "maths", "math"],
  alphabet: ["letter", "abc", "learning"],
  letter: ["alphabet", "abc", "learning"],
  shape: ["circle", "square", "triangle", "learning"],
  colour: ["color", "rainbow", "paint"],
  color: ["colour", "rainbow", "paint"],
  paint: ["art", "colour", "color", "brush"],
  brush: ["art", "paint"],
  drum: ["music", "instrument", "band"],
  guitar: ["music", "instrument", "band"],
  violin: ["music", "instrument", "band"],
  trumpet: ["music", "instrument", "band"],
  piano: ["music", "instrument", "band"],
  march: ["music", "band", "walk"],
  dance: ["music", "party", "movement"],
  jungle: ["forest", "animal", "tree", "wild"],
  forest: ["tree", "wood", "wild", "nature"],
  meadow: ["field", "grass", "flower", "nature"],
  garden: ["flower", "plant", "nature"],
  seed: ["plant", "grow", "garden"],
  sprout: ["plant", "grow", "garden"],
  harvest: ["farm", "autumn", "fall", "food"],
  campfire: ["camping", "fire", "outdoor", "adventure"],
  tent: ["camping", "outdoor", "adventure"],
  backpack: ["adventure", "travel", "camping"],
  compass: ["adventure", "map", "explore"],
  map: ["adventure", "treasure", "explore"],
  rocket: ["space", "astronaut", "planet", "star"],
  astronaut: ["space", "rocket", "planet", "star"],
  planet: ["space", "rocket", "star", "astronaut"],
  galaxy: ["space", "star", "planet"],
  robot: ["space", "machine", "future"],
};

// Dutch trigger words -> English concept words. Yoto's icon library and this embedding
// model are both English, so a Dutch title (e.g. "Kikker en de sneeuwman") otherwise gets
// near-random matches. Skewed toward common Dutch children's-book/story vocabulary
// (the "Kikker" series, sprookjes, dieren, gevoelens) since that's the typical content.
const CONCEPTS_NL: Record<string, string[]> = {
  kikker: ["frog"],
  eend: ["duck", "bird"],
  eendje: ["duck", "bird"],
  varken: ["pig"],
  varkentje: ["pig"],
  big: ["pig"],
  haas: ["rabbit", "hare"],
  konijn: ["rabbit"],
  konijntje: ["rabbit"],
  beer: ["bear"],
  beertje: ["bear"],
  vos: ["fox"],
  wolf: ["wolf"],
  muis: ["mouse"],
  muisje: ["mouse"],
  rat: ["rat", "mouse"],
  egel: ["hedgehog"],
  ezel: ["donkey"],
  paard: ["horse"],
  paardje: ["horse"],
  pony: ["horse", "pony"],
  koe: ["cow", "farm"],
  koetje: ["cow", "farm"],
  schaap: ["sheep", "farm"],
  schaapje: ["sheep", "farm"],
  geit: ["goat", "farm"],
  kip: ["chicken", "farm"],
  kippetje: ["chicken", "farm"],
  haan: ["rooster", "farm"],
  hond: ["dog"],
  hondje: ["dog"],
  puppy: ["dog", "puppy"],
  kat: ["cat"],
  poes: ["cat"],
  poesje: ["cat"],
  kitten: ["cat", "kitten"],
  vogel: ["bird"],
  vogeltje: ["bird", "feather"],
  vlinder: ["butterfly"],
  vlindertje: ["butterfly"],
  bij: ["bee", "insect"],
  bijtje: ["bee", "insect"],
  spin: ["spider"],
  kikkervisje: ["tadpole", "frog", "pond"],
  vis: ["fish"],
  visje: ["fish"],
  vissen: ["fish"],
  eekhoorn: ["squirrel"],
  uil: ["owl"],
  uiltje: ["owl"],
  slak: ["snail"],
  slakje: ["snail"],
  kikkers: ["frog"],
  leeuw: ["lion"],
  olifant: ["elephant"],
  aap: ["monkey"],
  aapje: ["monkey"],
  giraffe: ["giraffe"],
  zebra: ["zebra"],
  tijger: ["tiger"],
  krokodil: ["crocodile"],
  dinosaurus: ["dinosaur"],
  draak: ["dragon"],
  draakje: ["dragon"],
  sneeuwman: ["snowman", "snow", "winter"],
  sneeuw: ["snow", "winter"],
  sneeuwpop: ["snowman", "snow", "winter"],
  winter: ["winter", "snow", "cold"],
  zomer: ["summer", "sun", "beach"],
  lente: ["spring", "flower", "garden"],
  herfst: ["autumn", "fall", "leaves"],
  regen: ["rain", "weather"],
  regenboog: ["rainbow"],
  onweer: ["storm", "thunder"],
  wind: ["wind", "weather"],
  zon: ["sun", "sunshine"],
  zonnetje: ["sun", "sunshine"],
  maan: ["moon", "night"],
  ster: ["star", "night", "sky"],
  sterretje: ["star", "night", "sky"],
  wolk: ["cloud", "sky"],
  wolkje: ["cloud", "sky"],
  strand: ["beach", "sea", "sand"],
  zee: ["sea", "ocean", "beach"],
  golf: ["wave", "sea", "ocean"],
  boot: ["boat", "ship"],
  bootje: ["boat", "ship"],
  schip: ["ship", "boat"],
  trein: ["train"],
  treintje: ["train"],
  auto: ["car"],
  autootje: ["car"],
  fiets: ["bike", "bicycle"],
  fietsje: ["bike", "bicycle"],
  vliegtuig: ["plane", "airplane", "sky"],
  vliegtuigje: ["plane", "airplane", "sky"],
  raket: ["rocket", "space"],
  ruimte: ["space", "rocket", "planet"],
  planeet: ["planet", "space"],
  verliefd: ["love", "heart"],
  liefde: ["love", "heart"],
  hart: ["heart", "love"],
  hartje: ["heart", "love"],
  blij: ["happy", "smile"],
  vrolijk: ["happy", "smile"],
  verdrietig: ["sad"],
  huilen: ["sad", "cry"],
  bang: ["scared", "afraid"],
  boos: ["angry", "cross"],
  moe: ["tired", "sleep"],
  moppig: ["funny", "silly"],
  vriend: ["friend"],
  vriendje: ["friend"],
  vriendin: ["friend"],
  familie: ["family"],
  mama: ["mother", "family"],
  papa: ["father", "family"],
  moeder: ["mother", "family"],
  vader: ["father", "family"],
  oma: ["grandmother", "family"],
  opa: ["grandfather", "family"],
  baby: ["baby"],
  babytje: ["baby"],
  broer: ["brother", "family"],
  zus: ["sister", "family"],
  zusje: ["sister", "family"],
  slapen: ["sleep", "bedtime"],
  slaap: ["sleep", "bedtime"],
  slaapliedje: ["lullaby", "sleep", "bedtime", "moon"],
  droom: ["dream", "sleep", "night"],
  dromen: ["dream", "sleep", "night"],
  bed: ["bed", "sleep", "bedtime"],
  feest: ["party", "celebration"],
  verjaardag: ["birthday", "party", "cake"],
  cadeau: ["present", "gift", "birthday"],
  cadeautje: ["present", "gift", "birthday"],
  kerst: ["christmas", "winter"],
  kerstmis: ["christmas", "winter"],
  sinterklaas: ["santa", "winter", "gift"],
  pasen: ["easter", "spring", "egg"],
  ei: ["egg"],
  eitje: ["egg"],
  prinses: ["princess", "castle"],
  prins: ["prince", "castle"],
  koning: ["king", "crown", "castle"],
  koningin: ["queen", "crown", "castle"],
  kasteel: ["castle"],
  heks: ["witch", "magic"],
  tovenaar: ["wizard", "magic"],
  toverstaf: ["magic", "wand", "wizard"],
  fee: ["fairy", "magic"],
  sprookje: ["fairy tale", "story", "castle"],
  ridder: ["knight", "castle", "sword"],
  zwaard: ["sword", "knight"],
  reus: ["giant"],
  monster: ["monster"],
  spook: ["ghost"],
  piraat: ["pirate", "ship", "treasure"],
  schat: ["treasure", "pirate"],
  bos: ["forest", "tree", "wood"],
  boom: ["tree", "forest"],
  boompje: ["tree", "forest"],
  bloem: ["flower", "garden"],
  bloempje: ["flower", "garden"],
  tuin: ["garden", "flower", "plant"],
  muziek: ["music"],
  lied: ["song", "music"],
  liedje: ["song", "music"],
  dansen: ["dance", "music"],
  dans: ["dance", "music"],
  circus: ["circus"],
  clown: ["clown", "circus"],
  ballon: ["balloon", "party"],
  ijs: ["ice cream", "ice"],
  ijsje: ["ice cream"],
  taart: ["cake"],
  koekje: ["cookie", "biscuit"],
  appel: ["apple", "fruit"],
  appeltje: ["apple", "fruit"],
  vreemdeling: ["stranger", "visitor", "traveller"],
  vreemd: ["strange", "stranger"],
  ongeduldig: ["impatient", "waiting"],
  wachten: ["waiting", "clock"],
  bijzonder: ["special", "surprise"],
  bijzondere: ["special", "surprise"],
  verveelt: ["bored"],
  vervelen: ["bored"],
  verveeld: ["bored"],
  nieuwjaar: ["new year", "party", "celebration", "fireworks"],
  vuurwerk: ["fireworks", "new year", "party"],
  horizon: ["horizon", "sunset", "sunrise", "sky"],
  gevonden: ["found", "treasure"],
  reis: ["journey", "travel", "adventure", "map"],
  avontuur: ["adventure", "explore", "map"],
  geheim: ["secret", "mystery"],
};

// Strips common track-numbering conventions from a title before it's used for matching
// (both the lexical tag-boost and the text sent to the embedding model), e.g.:
//   "14 - Bedtime Story"      -> "Bedtime Story"
//   "14. Bedtime Story"       -> "Bedtime Story"
//   "(14) Bedtime Story"      -> "Bedtime Story"
//   "Track 14: Bedtime Story" -> "Bedtime Story"
//   "Bedtime Story - 14"      -> "Bedtime Story"
//   "Bedtime Story (14)"      -> "Bedtime Story"
// Without this, a numeral in the title can dominate the (short) embedding text and pull the
// match toward a plain numeral icon (e.g. a "14" icon) instead of the story's actual subject.
const AUDIO_EXT_RE = /\.(mp3|m4a|m4b|wav|flac|ogg|opus|aac|wma|aiff?)$/i;

function stripTrackNumber(s: string): string {
  let t = s.trim();
  t = t.replace(AUDIO_EXT_RE, "");
  t = t.replace(/^(?:track|nr\.?|no\.?|number)\s*[:.\-]?\s*\d+\s*[:.\-]?\s*/i, "");
  t = t.replace(/^[([]\s*\d+\s*[)\]]\s*[:.\-]?\s*/, "");
  // Leading number followed by punctuation ("14 - ", "14. ", "14_") OR just whitespace
  // ("14 Études...") — the latter is the common ripped-album naming convention. Only
  // strip the bare-whitespace form when at least 2 chars of title text remain after it,
  // so short numbered titles like "3 Bears" don't get mangled into nonsense.
  t = t.replace(/^\d{1,3}\s*[.\-_:)]\s*/, "");
  t = t.replace(/^\d{1,3}\s+(?=\S{2,})/, "");
  t = t.replace(/\s*[([]\s*\d+\s*[)\]]\s*$/, "");
  t = t.replace(/\s*[.\-_:]\s*\d+\s*$/, "");
  t = t.replace(AUDIO_EXT_RE, "");
  return t.trim() || s.trim();
}

// Normalizes leftover filename punctuation (underscores, repeated dashes) to spaces so the
// embedding model sees "Kikker en de sneeuwman" rather than "Kikker_en_de_sneeuwman".
function cleanForEmbedding(s: string): string {
  return stripTrackNumber(s).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(s: string): string[] {
  return stripTrackNumber(s)
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

// Returns extra concept words implied by the given title words (deduped, excludes the words already present).
// Looks up the concept words a given title word implies (see CONCEPTS / CONCEPTS_NL above).
function conceptsFor(word: string): string[] {
  return CONCEPTS[word] || CONCEPTS_NL[word] || [];
}

// Batch-level "how common is this word across the whole set of titles being matched right
// now" weight. A series name like "Kikker" that appears in almost every title in the batch
// carries little information about any one episode's subject, so its tag-boost contribution
// is scaled down — the episode-specific word (which is rare in the batch) then decides the
// icon instead. Unique-to-one-title words keep full weight (1); words in every title are
// scaled down to 0.15 (kept nonzero so a genuinely relevant series-wide word still counts a
// little, e.g. a "Frog" tag isn't actively wrong for a Kikker episode).
function buildBatchWeights(titleWordsList: string[][]): Map<string, number> {
  const total = titleWordsList.length;
  const df = new Map<string, number>();
  for (const words of titleWordsList) {
    for (const w of new Set(words)) df.set(w, (df.get(w) || 0) + 1);
  }
  const weights = new Map<string, number>();
  if (total <= 1) {
    for (const w of df.keys()) weights.set(w, 1);
    return weights;
  }
  for (const [w, count] of df) {
    const fraction = (count - 1) / (total - 1); // 0 = unique to one title, 1 = in every title
    weights.set(w, Math.max(0.15, 1 - 0.85 * fraction));
  }
  return weights;
}

// direct: title word -> batch weight (0.15-1). concept: expanded concept word -> batch
// weight inherited from whichever source word(s) produced it (max, if more than one).
function tagBoost(
  direct: Map<string, number>,
  concept: Map<string, number>,
  icon: IconLite
): number {
  if (direct.size === 0 && concept.size === 0) return 0;

  let boost = 0;
  const tags = (icon.tags || []).map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
  const iconTitleTokens = (icon.title || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

  for (const tag of tags) {
    const dw = lookupWithPlural(direct, tag);
    const cw = lookupWithPlural(concept, tag);
    if (dw !== undefined) boost += 0.35 * dw; // literal word match in a curated tag — strong signal
    else if (cw !== undefined) boost += 0.18 * cw; // matched via a concept relation (e.g. "wings" -> "bird")
  }
  // Concept-tier matching is deliberately NOT applied to icon titles: titles often contain
  // incidental franchise/series names (e.g. "Thomas and Friends - Ear") whose words can
  // coincidentally match a concept word (vriendje -> friend) with no real relevance. Tags
  // are curated to describe what the icon depicts, so that's where concept matches belong.
  // A literal/direct word match in a title is still trusted (e.g. an icon plainly titled
  // "Frog"), just not a concept-relation one.
  for (const tt of iconTitleTokens) {
    const dw = lookupWithPlural(direct, tt);
    if (dw !== undefined) boost += 0.12 * dw;
  }
  return Math.min(boost, 0.6);
}

function lookupWithPlural(weights: Map<string, number>, word: string): number | undefined {
  if (weights.has(word)) return weights.get(word);
  const alt = word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word + "s";
  return weights.get(alt);
}

export async function matchTitles(
  titles: string[],
  icons: IconLite[],
  threshold = 0
): Promise<MatchResult[]> {
  await ensureIconsEmbedded(icons);
  if (titles.length === 0) return [];

  const titleWordsList = titles.map((t) => tokenize(t));
  // How common is each word across THIS batch of titles (see buildBatchWeights) — a series
  // name like "Kikker" that's in nearly every title gets downweighted so it stops winning
  // over the word that actually distinguishes one episode from the next.
  const batchWeights = buildBatchWeights(titleWordsList);

  // NOTE: concept words are deliberately NOT appended to the embedding input text.
  // A bare word like "friend" in the query pulled the embedding toward ANY icon whose title
  // happens to contain that word too (e.g. "Thomas and Friends - Ear"), regardless of real
  // relevance — general embedding models are surprisingly sensitive to exact token overlap.
  // Concept words still contribute, but only through the controlled tagBoost step below
  // (matched against curated icon tags, not raw title text).
  const embedInputs = titles.map((title) => cleanForEmbedding(title));
  const queryVecs = await embedBatch(embedInputs);

  const debugRows: Array<{ title: string; picked: string | null; score: number; candidates: Array<{ title: string; score: number }> }> = [];

  const results = titles.map((title, qi) => {
    const q = queryVecs[qi];
    const titleWords = titleWordsList[qi];

    const directWeights = new Map<string, number>();
    for (const w of titleWords) directWeights.set(w, batchWeights.get(w) ?? 1);

    const conceptWeights = new Map<string, number>();
    for (const w of titleWords) {
      const wWeight = batchWeights.get(w) ?? 1;
      for (const c of conceptsFor(w)) {
        conceptWeights.set(c, Math.max(conceptWeights.get(c) ?? 0, wWeight));
      }
    }

    const scored: Array<{ icon: IconLite; score: number }> = [];
    for (const icon of icons) {
      const v = state.iconVectors.get(icon.mediaId);
      if (!v) continue;
      const c = cosine(q, v);
      const score = c + tagBoost(directWeights, conceptWeights, icon);
      scored.push({ icon, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    debugRows.push({
      title,
      picked: best && best.score >= threshold ? best.icon.title : null,
      score: best ? best.score : 0,
      candidates: scored.slice(0, 5).map((s) => ({ title: s.icon.title, score: Math.round(s.score * 1000) / 1000 })),
    });

    if (!best || best.score < threshold) {
      return { title, mediaId: null, url: null, iconTitle: null, score: best ? best.score : -Infinity };
    }
    return {
      title,
      mediaId: best.icon.mediaId,
      url: best.icon.url,
      iconTitle: best.icon.title,
      score: best.score,
    };
  });

  try {
    const dir = path.join(app.getPath("userData"), "debug");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "icon-matches.json"), JSON.stringify(debugRows, null, 2));
  } catch {}

  return results;
}
