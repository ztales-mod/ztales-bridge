/**
 * Two ways the story follows what players really do, with no extra AI call (Teko, 2026-11-19,
 * after a post on steering a model's text: the steering itself needs a model's insides, which no
 * API we use exposes; these are the parts that fit a story written ahead).
 *
 * Left behind ("abriu e não pegou"): production 2026-11-19, a party opened the basement bin that
 * held chapter 2's photo, took the house's other photos and left it. A player who opens the
 * container holding the open chapter's piece and walks away without it gets, LEFT_AFTER_SEC
 * later and only if nobody picked it up, one diary line: the stage answer's `left_behind`,
 * written with the chapter, else the bridge's own line. Once per player per chapter, delivered
 * in a gap of their play like every diary line.
 *
 * The thread (suspicion lock): a finder's chapter page the AI scored THREAD_MIN_SCORE or more
 * becomes `state.thread` in the next calls (the watch looks while that chapter stands, and the
 * next stage), so the writer sees their own idea grown into the story. One at a time: the newest
 * replaces it; a stage that carried it drops it. Among pages of one call, the author of the last
 * thread waits behind anyone else, so one player never holds the story.
 */
import { missingLanguages } from "./gates.js";

export const LEFT_BEHIND_MAX_CHARS = 300;
export const LEFT_AFTER_SEC = 15 * 60;
export const THREAD_MIN_SCORE = 2;
export const THREAD_MAX_CHARS = 700;
const OPEN_MAX = 200;
const URL_RE = /\b(https?:\/\/|www\.)/i;

const FALLBACK = {
  en: "I keep going back to that place in my head. I took what I came for and left, and something there was not like the rest. I walked past it.",
  "pt-br": "Não paro de voltar àquele lugar na cabeça. Peguei o que fui buscar e saí, e tinha alguma coisa ali diferente do resto. Passei reto por ela.",
};

/** The AI's `left_behind` ({ lang: text }), kept only when usable in every language; else null. */
export function leftBehindText(v, languages, forbidden = []) {
  if (!v || (typeof v !== "object" && typeof v !== "string")) return null;
  const value = typeof v === "string" ? { [(languages && languages[0]) || "en"]: v } : v;
  if (missingLanguages(value, languages).length) return null;
  const all = Object.values(value).filter((x) => typeof x === "string");
  if (!all.length || all.some((x) => !x.trim() || x.length > LEFT_BEHIND_MAX_CHARS || URL_RE.test(x))) return null;
  const bad = (forbidden || []).filter((s) => typeof s === "string" && s.length >= 3).map((s) => s.toLowerCase());
  if (bad.length && all.some((x) => bad.some((f) => x.toLowerCase().includes(f)))) return null;
  return value;
}

/** The bridge's own line, in each language (others read English). */
export function fallbackLeftBehind(languages) {
  const out = {};
  for (const l of languages && languages.length ? languages : ["en"]) out[l] = FALLBACK[l] || FALLBACK.en;
  return out;
}

/**
 * Who opened a container holding one of the open chapter's pieces and has not seen it taken:
 * { "<story_id>|<player>": { sid, player, node, at } }. A pick-up (anyone's) or a holder's report
 * clears every entry of that piece. Pure.
 *   nodePieces   Set of the open chapter's story ids; node the open chapter
 */
export function updateLeftOpen(prev, events, nodePieces, node, nowSec) {
  const out = {};
  for (const [k, v] of Object.entries(prev || {})) if (v && v.node === node) out[k] = { ...v };
  const clear = (sid) => { for (const k of Object.keys(out)) if (out[k].sid === sid) delete out[k]; };
  for (const e of events || []) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "container_opened" && typeof e.story_id === "string" && typeof e.player === "string" && e.player
      && nodePieces && nodePieces.has(e.story_id)) {
      const k = `${e.story_id}|${e.player}`;
      if (!out[k]) out[k] = { sid: e.story_id, player: e.player, node, at: nowSec };
    } else if (e.type === "item_picked" && typeof e.story_id === "string") {
      clear(e.story_id);
    } else if (e.type === "pieces_held" && Array.isArray(e.ids)) {
      for (const sid of e.ids) clear(sid);
    }
  }
  const keys = Object.keys(out);
  for (const k of keys.slice(0, Math.max(0, keys.length - OPEN_MAX))) delete out[k];
  return out;
}

/**
 * The lines due now: entries older than LEFT_AFTER_SEC whose player has had none for this
 * chapter. Returns { directives, sent, open } (sent: keys "<season>:<node>:<player>").
 */
export function dueLeftBehind({ open = {}, sent = [], season = "", node, text = null, languages = ["en"], nowSec, after = LEFT_AFTER_SEC }) {
  const done = new Set(sent || []);
  const left = { ...open };
  const directives = [];
  for (const [k, v] of Object.entries(open || {})) {
    if (!v || v.node !== node || nowSec - (v.at || 0) < after) continue;
    delete left[k];
    const key = `${season}:${node}:${v.player}`;
    if (done.has(key)) continue;
    done.add(key);
    directives.push({ id: `${season ? `${season}_` : ""}left_${node}_${v.player}`, type: "diary_entry", player: v.player,
      kind: "left_behind", node, text: text || fallbackLeftBehind(languages) });
  }
  return { directives, sent: [...done].slice(-300), open: left };
}

/**
 * The thread from this call's page scores (readContributions): the strongest page scored
 * THREAD_MIN_SCORE or more, its author not the last thread's when another qualifies. Its text is
 * the page itself (the motif with the page's id). Null when no page qualifies.
 */
export function chooseThread(contribs, motifs, lastAuthor, setIn) {
  const strong = (contribs || []).filter((c) => c && Number.isInteger(c.score) && c.score >= THREAD_MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  const pick = strong.find((c) => c.player !== lastAuthor) || strong[0];
  if (!pick) return null;
  const m = (motifs || []).find((x) => x && String(x.id) === String(pick.page));
  const text = typeof m?.text === "string" ? m.text.trim().slice(0, THREAD_MAX_CHARS) : "";
  if (!text) return null;
  return { player: pick.player, chapter: pick.chapter, score: pick.score, text, set_in: setIn };
}

/** What a call is told of the thread: { player, chapter, text } or null. */
export function threadFor(thread, season) {
  if (!thread || typeof thread.text !== "string" || !thread.text) return null;
  if (thread.season !== undefined && thread.season !== season) return null;
  return { player: thread.player, chapter: thread.chapter, text: thread.text };
}

/**
 * The thread after a stage for `writeNode` was accepted: the new one when this call chose one;
 * else the old one only while it has not reached a stage (a stage written for another node than
 * the one it was set in carried it).
 */
export function nextThread(prev, chosen, writeNode, seed = false) {
  if (chosen) return chosen;
  if (seed || !prev) return null;
  return prev.set_in === writeNode ? prev : null;
}
