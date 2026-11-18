/**
 * Watching each player (docs/13 item 4, Teko 2026-10-22). Every player's play is cut into blocks
 * of WatchBlockHours (12) REAL hours played: the mod counts, per player, the real seconds online
 * and active (outbox/seq.json `active`, src ZTales_Journey.lua); an idle or absent player adds
 * nothing. Never a wall-clock timer.
 *
 * When a block closes, the bridge asks the chapter model once (task "watch"; blocks closing in
 * the same tick go in one call) for that player only: a hint fitted to what they did, plainer the
 * longer the chapter has stood, a short record of their stretch, or nothing. Gated here: only a
 * diary_entry for the players asked, every language, no coordinates, no forbidden name, paced
 * (never delivered on the spot).
 */
import { gateBatch } from "./gates.js";
import { compass, normalize, signHit } from "./clues.js";
import { repeatErrors } from "./anchors.js";

export const WATCH_BLOCK_HOURS = 12;
export const WATCH_HOURS_MIN = 1;
export const WATCH_HOURS_MAX = 72;
/** A closed block nobody could answer for two days (no story, the AI away) is dropped. */
export const WATCH_TTL_SEC = 2 * 86400;
/** At most this many blocks in one call (the rest wait for the next tick). */
export const WATCH_MAX_PER_CALL = 8;
export const WATCH_MAX_CHARS = 600;
/** Calls per block (Teko, 2026-10-28): the first and at most two retries, each told what was wrong. */
export const WATCH_MAX_CALLS = 3;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** seq.json's `watch_block_hours`, clamped; the default when missing. */
export function blockHours(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return WATCH_BLOCK_HOURS;
  return Math.min(WATCH_HOURS_MAX, Math.max(WATCH_HOURS_MIN, n));
}

/** seq.json's `active` -> { player: seconds }; anything else is dropped. */
export function cleanActive(doc) {
  const out = {};
  if (!isObj(doc)) return out;
  for (const [k, v] of Object.entries(doc)) {
    const n = Number(v);
    if (typeof k === "string" && k && !k.startsWith("$") && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

/**
 * Blocks after this tick. prev: { player: { start, since } } (start: the player's active seconds
 * when the block opened; since: the bridge's epoch then). A player seen for the first time opens
 * a block at their current count (a bridge installed late never closes a backlog at once). A
 * count that went down (the server's data reset) opens a fresh block. At most one block closes
 * per player per tick. Returns { blocks, closed: [{ player, from, to, seconds }] }.
 */
export function updateBlocks(prev, active, nowSec, hours = WATCH_BLOCK_HOURS) {
  const need = blockHours(hours) * 3600;
  const blocks = { ...(isObj(prev) ? prev : {}) };
  const closed = [];
  for (const [player, sec] of Object.entries(active || {})) {
    const b = blocks[player];
    if (!b || !(sec >= b.start)) { blocks[player] = { start: sec, since: nowSec }; continue; }
    if (sec - b.start >= need) {
      closed.push({ player, from: b.since, to: nowSec, seconds: sec - b.start });
      blocks[player] = { start: sec, since: nowSec };
    }
  }
  return { blocks, closed };
}

/**
 * Coming back close (Teko, 2026-11-18: "he must not feel unrewarded for having been close"). A
 * proximity ring of the current chapter fires once per player; the mod (0.2.9) reports a player
 * back inside one on a later real day as `zone_returned`. Then that player's block closes now,
 * early, marked `near` (the strongest ring this tick): the watch look writes them a hint from their
 * own history, and it is written soon (pace "soon"). Wide never counts (300 tiles is a town); one
 * look per player per real day; a player whose block already waits is left alone.
 * Returns { blocks, closed, given } (given: { player: day } of the looks granted).
 */
const RING_RANK = { far: 2, mid: 3, near: 4 };
export function nearLooks(events, { node, blocks, active = {}, given = {}, due = [], nowSec, tzOffsetHours = -3 }) {
  const out = { blocks: { ...(isObj(blocks) ? blocks : {}) }, closed: [], given: { ...(isObj(given) ? given : {}) } };
  if (!node) return out;
  const day = Math.floor((nowSec + tzOffsetHours * 3600) / 86400);
  // only today's grants are kept: the record never grows
  for (const [p, d] of Object.entries(out.given)) if (d !== day) delete out.given[p];
  const best = new Map();
  for (const e of events || []) {
    if (e?.type !== "zone_returned" || typeof e.player !== "string" || !e.player) continue;
    const m = /prox_([^_]+)_(far|mid|near)$/.exec(String(e.story_id || ""));
    if (!m || m[1] !== node) continue;
    if ((RING_RANK[m[2]] || 0) > (RING_RANK[best.get(e.player)] || 0)) best.set(e.player, m[2]);
  }
  const waiting = new Set((Array.isArray(due) ? due : []).map((b) => b?.player));
  for (const [player, ring] of best) {
    if (out.given[player] === day || waiting.has(player)) continue;
    const b = out.blocks[player];
    const sec = Number.isFinite(active[player]) ? active[player] : b?.start;
    out.closed.push({ player, from: b?.since ?? nowSec - 3600, to: nowSec, seconds: Math.max(0, (sec ?? 0) - (b?.start ?? sec ?? 0)), near: ring });
    if (Number.isFinite(sec)) out.blocks[player] = { start: sec, since: nowSec };
    out.given[player] = day;
  }
  return out;
}

/** The blocks still owed an answer: the earlier ones (expired dropped) plus the new ones. */
export function dueBlocks(prev, closed, nowSec) {
  const out = (Array.isArray(prev) ? prev : []).filter((b) => b && nowSec - (b.to || 0) < WATCH_TTL_SEC);
  for (const c of closed || []) if (!out.some((b) => b.player === c.player && b.to === c.to)) out.push(c);
  return out;
}

const epochOf = (e) => {
  const t = e && typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
/** An event inside [from, to] (a few minutes of slack: the mod's clock and ours). An event without
 *  a time counts: it reached the bridge, so it happened before `to`. */
const inBlock = (e, from, to) => {
  const t = epochOf(e);
  return t == null || (t >= from - 600 && t <= to + 600);
};

/**
 * What one player did in one block, for the AI: their journeys (where they went, what they
 * fought, with whom, how they felt), what they wrote in their diary, and the places visited.
 */
export function blockMaterial(events, { player, from, to }) {
  const journeys = [];
  const diary = [];
  const places = new Set();
  const regions = new Set();
  let where = null;
  for (const e of events || []) {
    if (!e || e.player !== player || !inBlock(e, from, to)) continue;
    // where the block happened: the player's last event with a position (journeys carry none)
    if (typeof e.x === "number" && typeof e.y === "number" && (e.x || e.y)) where = { x: e.x, y: e.y };
    if (e.type === "player_journey") {
      journeys.push({ from: e.from, to: e.to, online_minutes: e.online_minutes, regions: e.regions, named_places: e.named_places,
        walked_tiles: e.walked_tiles, driven_tiles: e.driven_tiles, zombies_killed: e.zombies_killed, companions: e.companions,
        died: e.died, moods: e.moods, moods_end: e.moods_end, profession: e.profession, char: e.char });
      for (const p of Array.isArray(e.named_places) ? e.named_places : []) places.add(String(p));
      for (const r of Array.isArray(e.regions) ? e.regions : []) regions.add(String(r));
    } else if (e.type === "journal" && typeof e.text === "string" && e.text.trim()) {
      diary.push({ kind: e.kind ?? null, chapter: e.chapter ?? null, text: e.text.slice(0, 1200) });
    }
  }
  return { player, hours: Math.round(((to - from) / 3600) * 10) / 10, journeys: journeys.slice(-12), diary: diary.slice(-6),
    places: [...places].slice(0, 30), regions: [...regions].slice(0, 12), ...(where ? { where } : {}) };
}

const shortName = (n) => String(n || "").split(",")[0].trim();
// the game writes some regions run together ("WestPoint") and players and the AI write them apart
// ("West Point"): both spellings are one place (simulation 2026-11-04: a report naming the player's
// own West Point was refused as "another town")
const squash = (n) => normalize(shortName(n)).replace(/ /g, "");
const sameName = (a, b) => !!a && !!b && squash(a) === squash(b);
const spellings = (n) => [...new Set([n, String(n || "").replace(/([a-z])([A-Z])/g, "$1 $2")])];

/**
 * Where the chapter's piece is, seen from one player's block (Teko, 2026-10-28: the hints of a group
 * living in West Point read as if the mystery were there; the piece was in Riverside).
 * place: { x, y, region } (the piece's building, its centre). material: blockMaterial(...).
 * Returns { direction, distance: "near" | "across town" | "another town" | null, here: bool | null }:
 * the compass word from where the block happened, the rough band, and whether the piece's town is
 * among the towns the player went through.
 */
export function pullFor(place, material) {
  if (!place) return null;
  const regions = material?.regions || [];
  const here = place.region && regions.length ? regions.some((r) => sameName(r, place.region)) : null;
  const w = material?.where;
  let distance = null;
  let direction = null;
  if (w && Number.isFinite(place.x)) {
    const d = Math.hypot(place.x - w.x, place.y - w.y);
    direction = compass(w.x, w.y, place.x, place.y)?.[0] || null;
    distance = d <= 150 ? "near" : d <= 700 && here !== false ? "across town" : "another town";
  } else if (here != null) distance = here ? "across town" : "another town";
  return { direction, distance, here };
}

/**
 * Every town or region name the catalog knows, short forms too ("Muldraugh, KY" -> "Muldraugh"):
 * the spawn regions, the regions of the buildings loaded, and the regions the players went through.
 */
export function townNames(index, buildings = [], extra = []) {
  const out = new Set();
  const add = (n) => { for (const v of [String(n || "").trim(), shortName(n)]) if (normalize(v).trim().length >= 3) out.add(v); };
  for (const r of index?.spawn_regions || []) add(r?.name);
  for (const b of buildings) add(b?.region);
  for (const r of extra) add(r);
  return [...out];
}

// sentences: at . ! ? ; or a new line, never inside an ellipsis ("West Point, the bridge... starch" is one)
const sentencesOf = (text) => String(text || "").split(/(?<!\.)[.!?](?!\.)|[;\n]/).map((x) => x.trim()).filter(Boolean);
const holds = (norm, name) => { const n = normalize(name).trim(); return !!n && norm.includes(` ${n} `); };

/**
 * The place gate on one hint text (kind hint only; a record may name where they were):
 *  1. No town or region name but the chapter's region, the nearest named place, or the player's own
 *     towns of the block (allowed in a report sentence only, rule 2).
 *  2. A sentence that names the player's own area (a town or named place of their block, not the
 *     chapter's) never holds a sign of the chapter's place (src/clues.js factSigns): the report of
 *     the day and the thing sought stay in sentences of their own.
 * place: { region, allowed: [names], towns: [names], signs: [words] }; own: [names]. Returns reasons.
 */
export function hintPlaceErrors(text, place, own = []) {
  if (!place) return [];
  const errors = [];
  const allowed = [place.region, shortName(place.region), ...(place.allowed || [])].filter(Boolean)
    .map((n) => normalize(n).trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  const strip = (norm) => { let s = norm; for (const a of allowed) s = s.split(` ${a} `).join(" | "); return s; };
  const mine = own.filter((n) => !sameName(n, place.region)).flatMap(spellings);
  const norm = strip(normalize(text));
  const other = (place.towns || []).filter((n) => holds(norm, n) && !mine.some((m) => sameName(m, n)));
  if (other.length) {
    errors.push(`a hint names "${shortName(other[0])}": the chapter's place is in ${shortName(place.region) || "another town"}; `
      + `name only ${[shortName(place.region), ...(place.allowed || [])].filter(Boolean).join(" or ")}, or no town`);
  }
  for (const s of sentencesOf(text)) {
    const n = strip(normalize(s));
    const area = mine.find((m) => holds(n, m) || holds(n, shortName(m)));
    const sign = area ? signHit(n, place.signs || []) : null;
    if (sign) {
      errors.push(`"${s.slice(0, 80)}" puts "${shortName(area)}" (where they were) and "${sign}" (what is sought) in one sentence: `
        + "report the day in plain past actions, then the pull in a sentence of its own, as a thought or feeling (But it isn't here. I keep thinking...)");
      break;
    }
  }
  return errors;
}

// a map coordinate written out ("10650, 9650", "x 10650", "at 10650/9650") or a building id
const COORDS_RE = /\b\d{4,5}\s*[,;/x×]\s*\d{4,5}\b|\b[xy]\s*[:=]?\s*\d{4,5}\b|\bb_\d+_\d+\b/i;
export function hasCoordinates(text) {
  return COORDS_RE.test(String(text || ""));
}

const textsOf = (v) => (typeof v === "string" ? [v] : isObj(v) ? Object.values(v).filter((x) => typeof x === "string") : []);

/*
 * The pull of a hint (Teko, 2026-11-13). A hint was written for where the player stood when the
 * block closed and read minutes later 4000 tiles away ("it pulls west, across town", read in West
 * Point). The hint's body is written from the player's history and holds `{pull}`; the pull
 * itself is written once per distance band (`near`, `town`, `far`), the compass word left as
 * `{dir}`. The mod (0.2.8, ZTales_Diary.fillPull) picks the band and the word from where the
 * player is the moment the entry is written. Bands as pullFor: near <= 150 tiles, town <= 700.
 */
export const PULL_BANDS = ["near", "town", "far"];
export const PULL_NEAR = 150;
export const PULL_TOWN = 700;
export const PULL_MAX_CHARS = 200;
const COMPASS_RE = /\b(north|south|east|west|northeast|northwest|southeast|southwest|norte|sul|leste|oeste|nordeste|noroeste|sudeste|sudoeste)\b/i;
/**
 * Terrain the bridge never gives the agent (Teko, 2026-11-13: "further than the river" sent a
 * player across a river the piece was not behind). A hint names none of it: the agent knows the
 * piece's building and the player's towns, never what lies between.
 */
export const TERRAIN_WORDS = ["river", "rivers", "bridge", "bridges", "lake", "creek", "stream", "hill", "hills", "railroad",
  "railway", "railroad tracks", "train tracks", "highway", "interstate", "valley", "rio", "rios", "ponte", "pontes", "lago", "riacho",
  "corrego", "morro", "morros", "colina", "colinas", "ferrovia", "trilhos", "rodovia"];
const count = (s, m) => String(s).split(m).length - 1;

/** The band a player at (x, y) reads, the piece's centre at (px, py). */
export function pullBand(px, py, x, y) {
  const d = Math.hypot(px - x, py - y);
  return d <= PULL_NEAR ? "near" : d <= PULL_TOWN ? "town" : "far";
}

/**
 * A text map with `{pull}` filled for a player at (x, y), as the mod does it; for a mod older than
 * 0.2.8 the bridge fills it from where the block closed. No position: the marker goes.
 */
export function fillPull(text, pull, x, y) {
  const one = (t, lang) => {
    if (typeof t !== "string" || !t.includes("{pull}")) return t;
    let line = "";
    if (pull && Number.isFinite(x) && Number.isFinite(y)) {
      const band = pullBand(pull.x, pull.y, x, y);
      const bandText = isObj(pull[band]) ? (pull[band][lang] ?? pull[band].en) : pull[band];
      const c = compass(x, y, pull.x, pull.y) || compass(x, y, pull.x, pull.y - 100);
      line = String(bandText || "").split("{dir}").join(c[lang === "pt-br" ? 1 : 0]);
    }
    return t.split("{pull}").join(line).replace(/ {2,}/g, " ").trim();
  };
  if (typeof text === "string") return one(text, "en");
  return Object.fromEntries(Object.entries(text || {}).map(([k, v]) => [k, one(v, k)]));
}

/** What is wrong with a hint's body and its pull (languages: every one must be written). */
export function pullErrors(text, pull, { languages = ["en"], place = null } = {}) {
  const errs = [];
  const bodyOf = (lang) => (isObj(text) ? text[lang] : text);
  if (!place || !Number.isFinite(place.x)) {
    if (textsOf(text).some((x) => x.includes("{pull}")) || pull != null) errs.push("no pull this time (the chapter's place is unknown): no {pull}, no `pull`");
    return errs;
  }
  if (!isObj(pull)) return ["a hint needs `pull`: { near, town, far }, each {lang: text} holding {dir} once"];
  const towns = placeTowns(place);
  const stripTowns = (s) => { let n = normalize(s); for (const t of towns) n = n.split(normalize(t)).join(" "); return n; };
  for (const lang of languages) {
    const b = bodyOf(lang);
    if (typeof b !== "string") continue;
    if (count(b, "{pull}") !== 1) errs.push(`text.${lang}: write {pull} exactly once, where the pull goes`);
    if (b.includes("{dir}")) errs.push(`text.${lang}: {dir} goes only in the pull texts`);
    const m = COMPASS_RE.exec(stripTowns(b.split("{pull}").join(" ")));
    if (m) errs.push(`text.${lang}: "${m[1]}": no direction in the body; the pull texts carry it, as {dir}`);
  }
  for (const band of PULL_BANDS) {
    const v = pull[band];
    for (const lang of languages) errs.push(...bandErrors(isObj(v) ? v[lang] : null, band, lang, towns));
  }
  return [...new Set(errs)];
}

const placeTowns = (place) => [...(place?.towns || []), place?.region, ...(place?.allowed || [])].filter(Boolean);

/** What is wrong with one band's text in one language (empty: it may go). */
function bandErrors(t, band, lang, towns = []) {
  const errs = [];
  if (typeof t !== "string" || !t.trim()) return [`pull.${band}.${lang} missing`];
  const stripTowns = (s) => { let n = normalize(s); for (const x of towns) n = n.split(normalize(x)).join(" "); return n; };
  if (t.length > PULL_MAX_CHARS) errs.push(`pull.${band}.${lang}: longer than ${PULL_MAX_CHARS} characters`);
  if (count(t, "{dir}") !== 1) errs.push(`pull.${band}.${lang}: write {dir} exactly once (the mod puts the compass word there)`);
  if (t.includes("{pull}")) errs.push(`pull.${band}.${lang}: no {pull} inside a pull`);
  const m = COMPASS_RE.exec(stripTowns(t.split("{dir}").join(" ")));
  if (m) errs.push(`pull.${band}.${lang}: "${m[1]}": the direction is only {dir}`);
  if (band !== "far") {
    const n = normalize(t);
    const named = towns.find((x) => normalize(x).trim().length >= 3 && n.includes(normalize(x)));
    if (named) errs.push(`pull.${band}.${lang}: names "${named}": near and town are read by someone already close; name no place`);
  }
  if (hasCoordinates(t)) errs.push(`pull.${band}.${lang}: no coordinates`);
  return errs;
}

/**
 * Plain bands, used only where the agent's own band cannot be mended (Teko, 2026-11-18: two hints
 * were lost in a day to a missing {dir}; the body is the agent's, a plain pull is better than none).
 */
export const PLAIN_PULL = {
  near: { en: "It is close, somewhere toward the {dir}.", "pt-br": "Está perto, em algum lugar para o {dir}." },
  town: { en: "A few streets from here, toward the {dir}.", "pt-br": "A algumas ruas daqui, para o {dir}." },
  far: { en: "It is far from here, toward the {dir}.", "pt-br": "Fica longe daqui, para o {dir}." },
};

/**
 * Mend what the agent got wrong in a hint's form, never its words: `{pull}` missing from the body
 * goes at its end (extra ones go); in a band, a compass word written instead of {dir} becomes
 * {dir}; a band still wrong (or missing) takes the plain band. Returns { text, pull, mended: [why] }.
 * Only for a hint whose chapter has a place; a body with a direction or {dir} in it is left for the
 * gate to refuse (that is the agent's sentence, not its form).
 */
export function mendPull(text, pull, { languages = ["en"], place = null } = {}) {
  const mended = [];
  if (!place || !Number.isFinite(place.x)) return { text, pull, mended };
  const towns = placeTowns(place);
  const fixBody = (b, lang) => {
    if (typeof b !== "string") return b;
    const n = count(b, "{pull}");
    if (n === 1) return b;
    mended.push(`text.${lang}: {pull} ${n ? "once" : "added at the end"}`);
    if (!n) return `${b.trim()} {pull}`;
    const i = b.indexOf("{pull}") + "{pull}".length;
    return (b.slice(0, i) + b.slice(i).split("{pull}").join("")).replace(/ {2,}/g, " ").trim();
  };
  const body = isObj(text) ? Object.fromEntries(Object.entries(text).map(([k, v]) => [k, fixBody(v, k)])) : fixBody(text, "en");
  const out = {};
  for (const band of PULL_BANDS) {
    const v = isObj(pull) ? pull[band] : null;
    out[band] = {};
    for (const lang of languages) {
      let t = isObj(v) ? v[lang] : typeof v === "string" && lang === "en" ? v : null;
      if (typeof t === "string" && !t.includes("{dir}")) {
        const m = COMPASS_RE.exec(t);
        if (m) { t = t.slice(0, m.index) + "{dir}" + t.slice(m.index + m[0].length); mended.push(`pull.${band}.${lang}: "${m[1]}" -> {dir}`); }
      }
      if (bandErrors(t, band, lang, towns).length) {
        mended.push(`pull.${band}.${lang}: plain`);
        t = PLAIN_PULL[band][lang] ?? PLAIN_PULL[band].en;
      }
      out[band][lang] = t;
    }
  }
  return { text: body, pull: out, mended };
}

/** A hint's body without its `{pull}` marker: what the hint itself says. */
export function bodyOnly(text) {
  const one = (t) => (typeof t === "string" ? t.split("{pull}").join(" ").replace(/ {2,}/g, " ").trim() : t);
  return isObj(text) ? Object.fromEntries(Object.entries(text).map(([k, v]) => [k, one(v)])) : one(text);
}

/** Terrain words in any of the texts (TERRAIN_WORDS): the first one found, or null. */
export function terrainHit(texts) {
  for (const t of texts) {
    const n = normalize(t);
    const w = TERRAIN_WORDS.find((x) => n.includes(` ${normalize(x).trim()} `));
    if (w) return w;
  }
  return null;
}

/**
 * The AI's watch answer -> { accepted, rejections }. Only `diary_entry` for a player asked, one
 * each; ids are the bridge's (`<season>_watch_<player>_<to>`), delivered paced (the diary's own
 * gap, never "now"); kind "watch_hint" or "watch_record".
 *   asked: Map player -> block; storyIds: Set of piece ids (never written in a diary line)
 */
export function gateWatch(answer, { asked, season = "", languages = ["en"], forbidden = [], storyIds = new Set(), pushedIds = new Set(),
  place = null, own = {}, memory = null }) {
  const rejections = [];
  const wanted = [];
  const anchorOf = new Map();   // id -> the anchor it declared (kept by the bridge, never sent)
  const done = new Set();
  const mended = [];
  for (let d of Array.isArray(answer?.directives) ? answer.directives : []) {
    const id = isObj(d) && typeof d.id === "string" ? d.id : "?";
    if (!isObj(d) || d.type !== "diary_entry") { rejections.push({ id, reason: "only diary_entry in a watch task" }); continue; }
    const block = asked.get(d.player);
    if (!block) { rejections.push({ id, reason: `no block of ${d.player} was asked` }); continue; }
    if (done.has(d.player)) { rejections.push({ id, reason: `one entry per player: ${d.player} already has one` }); continue; }
    const player = d.player;
    const all = textsOf(d.text);
    if (!all.length || all.some((x) => !x.trim())) { rejections.push({ id, player, reason: "diary_entry without text" }); continue; }
    if (all.some((x) => x.length > WATCH_MAX_CHARS)) { rejections.push({ id, player, reason: `longer than ${WATCH_MAX_CHARS} characters` }); continue; }
    if (all.some(hasCoordinates)) { rejections.push({ id, player, reason: "a diary never gives coordinates or a building id" }); continue; }
    if (all.some((x) => [...storyIds].some((s) => s && x.includes(s)))) { rejections.push({ id, player, reason: "names a piece's id" }); continue; }
    const kind = /record/.test(String(d.kind || "")) ? "watch_record" : "watch_hint";
    // a hint's form is mended here, not refused: {pull} in the body, {dir} in each band
    if (kind === "watch_hint" && place) {
      const m = mendPull(d.text, d.pull, { languages, place });
      if (m.mended.length) { d = { ...d, text: m.text, pull: m.pull }; mended.push({ id, player, mended: m.mended }); }
    }
    const pullTexts = isObj(d.pull) ? PULL_BANDS.flatMap((b) => textsOf(d.pull[b])) : [];
    if (kind === "watch_record" && (d.pull != null || all.some((x) => x.includes("{pull}")))) {
      rejections.push({ id, player, reason: "a record has no pull: no {pull}, no `pull`" }); continue;
    }
    const hill = terrainHit([...all, ...pullTexts]);
    if (hill) {
      rejections.push({ id, player, reason: `"${hill}": you are never told what lies between the player and the place (rivers, bridges, hills, roads); name none` });
      continue;
    }
    if (kind === "watch_hint") {
      const bad = pullErrors(d.text, d.pull, { languages, place });
      if (bad.length) { rejections.push({ id, player, reason: bad.slice(0, 3).join("; ") }); continue; }
    }
    // what a reader may get: the body with the far pull in it (the strictest reading for the gates below)
    const read = kind === "watch_hint" && isObj(d.pull) && place ? fillPull(d.text, { ...d.pull, x: place.x, y: place.y }, place.x + PULL_TOWN + 1, place.y) : d.text;
    const readAll = textsOf(read);
    if (pullTexts.some((x) => x.length > PULL_MAX_CHARS) || readAll.some((x) => x.length > WATCH_MAX_CHARS)) {
      rejections.push({ id, player, reason: `the text with its pull is longer than ${WATCH_MAX_CHARS} characters` }); continue;
    }
    const leak = forbidden.filter((f) => typeof f === "string" && f.length >= 3).find((f) => pullTexts.some((x) => x.toLowerCase().includes(f.toLowerCase())));
    if (leak) { rejections.push({ id, player, reason: `names "${leak}" before its time` }); continue; }
    if (kind === "watch_hint" && place) {
      const bad = readAll.flatMap((x) => hintPlaceErrors(x, place, own[d.player] || []));
      if (bad.length) { rejections.push({ id, player, reason: bad[0] }); continue; }
    }
    // anchor variety (src/anchors.js): a hint names the detail it hangs on, never the last ones again
    // the body only: the pull's words are the mod's compass and the bands, never the hint's own
    if (kind === "watch_hint" && memory) {
      const again = repeatErrors(bodyOnly(d.text), d.anchor, memory, player);
      if (again.length) { rejections.push({ id, player, reason: again.join("; ") }); continue; }
    }
    // only the fields a diary entry needs; no `deliver`: paced, written in a gap of their own play.
    // `pull` carries the piece's centre: the mod measures from the player to it when it writes.
    const pull = kind === "watch_hint" && isObj(d.pull) && place
      ? { x: Math.round(place.x), y: Math.round(place.y), ...Object.fromEntries(PULL_BANDS.map((b) => [b, d.pull[b]])) } : null;
    // a look the player earned by coming back close (src/tick.js nearLooks) is written soon
    wanted.push({ id: `${season ? `${season}_` : ""}watch_${d.player}_${block.to}`, type: "diary_entry", kind, player: d.player,
      text: d.text, ...(pull ? { pull } : {}), ...(block.node ? { node: block.node } : {}), ...(block.near ? { pace: "soon" } : {}) });
    anchorOf.set(wanted[wanted.length - 1].id, d.anchor ?? null);
    done.add(d.player);
  }
  const g = gateBatch(wanted, { pushedIds, languages, forbidden });
  const playerOf = new Map(wanted.map((w) => [w.id, w.player]));
  return { accepted: g.accepted, anchors: anchorOf, mended,
    rejections: [...rejections, ...g.rejected.map((r) => ({ ...r, player: playerOf.get(r.id) }))] };
}
