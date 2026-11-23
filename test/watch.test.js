import { test } from "node:test";
import assert from "node:assert/strict";
import { fillPull, mendPull, bodyOnly, nearLooks, PLAIN_PULL, updateBlocks, dueBlocks, blockMaterial, gateWatch, cleanActive, blockHours, hasCoordinates, pullFor, townNames,
  WATCH_TTL_SEC } from "../src/watch.js";

const H = 3600;

test("a block closes every 12 real hours a player has played; idle or absent players add nothing", () => {
  let w = updateBlocks({}, { ana: 100, bob: 0 }, 1000);
  assert.deepEqual(w.closed, [], "first seen: a block opens at the player's count, no backlog");
  assert.deepEqual(w.blocks.ana, { start: 100, since: 1000 });
  // ana plays 11 hours, bob is away (his count does not move)
  w = updateBlocks(w.blocks, { ana: 100 + 11 * H, bob: 0 }, 5000);
  assert.deepEqual(w.closed, []);
  w = updateBlocks(w.blocks, { ana: 100 + 12 * H, bob: 0 }, 9000);
  assert.deepEqual(w.closed, [{ player: "ana", from: 1000, to: 9000, seconds: 12 * H }]);
  assert.deepEqual(w.blocks.ana, { start: 100 + 12 * H, since: 9000 }, "the next block starts at once");
  // a count that went down (the server's data reset) opens a fresh block
  w = updateBlocks(w.blocks, { ana: 50 }, 9500);
  assert.deepEqual(w.closed, []);
  assert.equal(w.blocks.ana.start, 50);
  // the sandbox's hours, clamped
  assert.equal(updateBlocks({ c: { start: 0, since: 0 } }, { c: 2 * H }, 10, 2).closed.length, 1);
  assert.equal(blockHours(undefined), 12);
  assert.equal(blockHours(500), 72);
  assert.deepEqual(cleanActive({ ana: 5, $all: 3, bob: "x", cid: -1 }), { ana: 5 });
  assert.deepEqual(cleanActive([]), {}, "Lua's empty table may be a list");
});

test("blocks owed an answer wait, once each, and are dropped after two days", () => {
  const due = dueBlocks([{ player: "old", to: 0 }], [{ player: "ana", to: 100 }, { player: "ana", to: 100 }], WATCH_TTL_SEC + 10);
  assert.deepEqual(due.map((b) => b.player), ["ana"]);
});

test("a block's material: that player's journeys, diary and places inside the block only", () => {
  const ts = (sec) => new Date(sec * 1000).toISOString();
  const events = [
    { type: "player_journey", player: "ana", ts: ts(2000), named_places: ["Muldraugh Hospital"], regions: ["Muldraugh"], zombies_killed: 4 },
    { type: "player_journey", player: "ana", ts: ts(100), named_places: ["Old Place"] },
    { type: "player_journey", player: "bob", ts: ts(2000), named_places: ["Bob's"] },
    { type: "journal", player: "ana", ts: ts(2500), kind: "free", text: "The hospital was empty." },
  ];
  const m = blockMaterial(events, { player: "ana", from: 1000, to: 1000 + 12 * H });
  assert.deepEqual(m.places, ["Muldraugh Hospital"]);
  assert.equal(m.journeys.length, 1);
  assert.equal(m.diary[0].text, "The hospital was empty.");
  assert.equal(m.hours, 12);
});

test("the watch gate: only a diary entry for a player asked, one each, every language, no coordinates, nothing forbidden, paced", () => {
  const asked = new Map([["ana", { player: "ana", to: 777 }], ["bob", { player: "bob", to: 778 }]]);
  const both = (x) => ({ en: x, "pt-br": x });
  const answer = { directives: [
    { id: "a", type: "diary_entry", player: "ana", kind: "hint", deliver: "now", text: both("Another hospital, further east, keeps calling me.") },
    { id: "a2", type: "diary_entry", player: "ana", text: both("Again.") },
    { id: "c", type: "diary_entry", player: "cid", text: both("Not asked.") },
    { id: "s", type: "chat", scope: "server", text: both("Hello.") },
    { id: "b", type: "diary_entry", player: "bob", kind: "record", text: both("I went to 10650, 9650.") },
  ] };
  const g = gateWatch(answer, { asked, season: "s1", languages: ["en", "pt-br"], forbidden: ["Dalton Keane"], storyIds: new Set(["n1_photo"]) });
  assert.deepEqual(g.accepted.map((d) => [d.id, d.player, d.kind, d.deliver]), [["s1_watch_ana_777", "ana", "watch_hint", undefined]]);
  const why = JSON.stringify(g.rejections);
  assert.match(why, /one entry per player/);
  assert.match(why, /no block of cid/);
  assert.match(why, /only diary_entry/);
  assert.match(why, /coordinates/);
  const leak = gateWatch({ directives: [{ id: "x", type: "diary_entry", player: "bob", text: both("Dalton Keane knew.") }] }, { asked, languages: ["en", "pt-br"], forbidden: ["Dalton Keane"] });
  assert.match(JSON.stringify(leak.rejections), /before its time/);
  const one = gateWatch({ directives: [{ id: "x", type: "diary_entry", player: "bob", text: { en: "Only English." } }] }, { asked, languages: ["en", "pt-br"] });
  assert.match(JSON.stringify(one.rejections), /lacks pt-br/);
  assert.ok(hasCoordinates("the house at x 10650") && hasCoordinates("b_10700_9700") && !hasCoordinates("radio 88.6 at seven"));
});

// Teko, 2026-10-28: a group living in West Point read every hint as if the mystery were there;
// the chapter's piece was in Riverside
const RIVERSIDE = { x: 6500, y: 5300, region: "Riverside, KY", allowed: ["Riverside Diner"],
  towns: ["West Point, KY", "West Point", "Riverside, KY", "Riverside", "Muldraugh"],
  signs: ["starch", "iron", "pressed", "fold", "steam", "laundry", "lavanderia", "goma", "vapor"] };
const westBlock = { player: "ana", to: 900 };
const westOwn = { ana: ["West Point", "West Point Laundry Co"] };
const gateOne = (text, kind = "hint") => gateWatch({ directives: [{ type: "diary_entry", player: "ana", kind, text }] },
  { asked: new Map([["ana", westBlock]]), languages: ["en"], place: RIVERSIDE, own: westOwn });

test("the pull: direction and distance band from where the block happened to the piece's building", () => {
  const ts = new Date(1000 * 1000).toISOString();
  const m = blockMaterial([
    { type: "player_journey", player: "ana", ts, regions: ["West Point"] },
    { type: "zombie_killed", player: "ana", ts, x: 11900, y: 6900 },
  ], { player: "ana", from: 900, to: 2000 });
  assert.deepEqual(m.where, { x: 11900, y: 6900 }, "the last position of the block");
  assert.deepEqual(pullFor(RIVERSIDE, m), { direction: "west", distance: "another town", here: false });
  assert.equal(pullFor({ ...RIVERSIDE, x: 11950, y: 6950, region: "West Point" }, m).distance, "near");
  assert.equal(pullFor({ ...RIVERSIDE, x: 12300, y: 6900, region: "West Point" }, m).distance, "across town");
  assert.deepEqual(pullFor(RIVERSIDE, { regions: ["West Point"] }), { direction: null, distance: "another town", here: false },
    "no position: the towns alone say it is elsewhere");
  assert.deepEqual(townNames({ spawn_regions: [{ name: "West Point, KY" }] }, [{ region: "Riverside" }], ["Rosewood"]),
    ["West Point, KY", "West Point", "Riverside", "Rosewood"]);
});

// the pull, per band (Teko, 2026-11-13): chosen by the mod where the entry is written
const en = (t) => ({ en: t });
const PULL = { near: en("It is right here, toward the {dir}."), town: en("It pulls {dir}, a few streets off."),
  far: en("But it isn't here. Something keeps pulling me {dir}, toward Riverside.") };
const gatePull = (text, pull = PULL, kind = "hint") => gateWatch({ directives: [{ type: "diary_entry", player: "ana", kind, text, pull }] },
  { asked: new Map([["ana", westBlock]]), languages: ["en"], place: RIVERSIDE, own: westOwn });

test("the watch place gate: a hint names no other town; the day and the pull never share a sentence; a record is free", () => {
  // the production line of 2026-10-28: West Point and the chapter's starch in one sentence
  let g = gatePull("Day 410. Walked the same roads again: West Point... the smell of hot starch... that laundry door. {pull}");
  assert.equal(g.accepted.length, 0);
  assert.match(g.rejections[0].reason, /"West Point" \(where they were\) and "(starch|laundry)" \(what is sought\) in one sentence/);
  assert.equal(g.rejections[0].player, "ana", "the reason is the player's, for the retry");
  // a town that is neither the chapter's nor theirs
  g = gatePull("Something waits in Muldraugh. {pull}");
  assert.match(g.rejections[0].reason, /names "Muldraugh".*Riverside/);
  // the intended tone (Teko): the day in plain past actions, then the pull as a feeling of its own
  const tone = "Today we cleared two houses in West Point and burned the bodies. "
    + "{pull} A warm, clean smell of pressed cotton I can't place. I keep telling myself to stay. I don't think I will.";
  g = gatePull(tone);
  assert.deepEqual(g.rejections, []);
  assert.equal(g.accepted[0].kind, "watch_hint");
  assert.deepEqual(g.accepted[0].pull, { x: 6500, y: 5300, ...PULL }, "the piece's centre goes with the bands");
  const tonePt = "Hoje limpamos duas casas em West Point e queimamos os corpos. {pull} Sinto que vou acabar indo.";
  assert.deepEqual(gatePull(tonePt, { near: en("Está aqui, ao {dir}."), town: en("Puxa para o {dir}, umas ruas."),
    far: en("Mas não é aqui. Algo me puxa para o {dir}, para Riverside.") }).rejections, [], "the same in PT-BR");
  assert.deepEqual(gatePull("{pull} And the steam of it.", { ...PULL, far: en("Something pulls me {dir}, toward Riverside Diner.") }).rejections, [],
    "the nearest named place is fine");
  // a record may name where they were, and nothing is sought in it; it has no pull
  assert.deepEqual(gateOne("Day 444. We've been in West Point so long, folding the same laundry.", "record").rejections, []);
  assert.match(gatePull("Day 444. West Point. {pull}", PULL, "record").rejections[0].reason, /a record has no pull/);
  // without a known place (the piece's building unread) the gate is as before, and no pull
  assert.equal(gateWatch({ directives: [{ type: "diary_entry", player: "ana", text: "Muldraugh, the starch." }] },
    { asked: new Map([["ana", westBlock]]), languages: ["en"] }).accepted.length, 1);
  assert.match(gateWatch({ directives: [{ type: "diary_entry", player: "ana", text: "It. {pull}", pull: PULL }] },
    { asked: new Map([["ana", westBlock]]), languages: ["en"] }).rejections[0].reason, /no pull this time/);
});

test("the pull: no terrain, no direction outside {dir}, every band, near and town name no place (Teko, 2026-11-13)", () => {
  // the line of 2026-11-12: "further than the river", the piece on the player's own side
  let g = gatePull("Riverside gave me nothing. {pull}", { ...PULL, far: en("Something pulls me {dir}, further than the river.") });
  assert.match(g.rejections[0].reason, /"river": you are never told what lies between/);
  assert.match(gatePull("Past the ponte, the starch. {pull}").rejections[0].reason, /"ponte"/);
  assert.equal(gatePull("Riverside, nothing. {pull}").accepted.length, 1, "Riverside is a name, not a river");
  assert.match(gatePull("It pulls west. {pull}").rejections[0].reason, /no direction in the body/);
  assert.equal(gatePull("Two days in West Point. {pull}").accepted.length, 1, "West Point is a town, not a direction");
});

test("the pull's form is mended, never refused for it (Teko, 2026-11-18: two hints lost in a day to a missing {dir})", () => {
  let g = gatePull("Nothing here.");
  assert.deepEqual(g.rejections, []);
  assert.equal(g.accepted[0].text, "Nothing here. {pull}", "a body without {pull} gets it at its end");
  assert.equal(gatePull("Nothing {pull} and {pull}.").accepted[0].text, "Nothing {pull} and .", "only the first {pull} stays");
  g = gatePull("Nothing. {pull}", { near: PULL.near, far: PULL.far });
  assert.equal(g.accepted[0].pull.town.en, PLAIN_PULL.town.en, "a missing band takes the plain one");
  g = gatePull("Nothing. {pull}", { ...PULL, town: en("It pulls west, a few streets.") });
  assert.equal(g.accepted[0].pull.town.en, "It pulls {dir}, a few streets.", "a compass word where {dir} goes becomes {dir}");
  g = gatePull("Nothing. {pull}", { ...PULL, town: en("It pulls {dir}, in Riverside.") });
  assert.equal(g.accepted[0].pull.town.en, PLAIN_PULL.town.en, "a band that names a place near the piece takes the plain one");
  g = gatePull("Nothing. {pull}", { ...PULL, near: en("Here {dir}, {dir}.") });
  assert.equal(g.accepted[0].pull.near.en, PLAIN_PULL.near.en, "{dir} twice: plain");
  g = gatePull("Nothing. {pull}", null);
  assert.deepEqual(g.accepted[0].pull.far, { en: PLAIN_PULL.far.en }, "no pull at all: every band plain");
  // the sentence is still the agent's: a direction in the body is refused, to be rewritten
  assert.match(gatePull("It pulls west. {pull}").rejections[0].reason, /no direction in the body/);
  const m = mendPull({ en: "A.", "pt-br": "A." }, { near: { en: "Close, {dir}." } }, { languages: ["en", "pt-br"], place: { x: 1, y: 1 } });
  assert.equal(m.pull.near["pt-br"], PLAIN_PULL.near["pt-br"], "each language mended on its own");
  assert.equal(m.pull.near.en, "Close, {dir}.");
});

test("repeat check reads the body only: the compass word is the mod's, never a worn word", () => {
  assert.deepEqual(bodyOnly({ en: "Grass. {pull} Then.", "pt-br": "{pull}" }), { en: "Grass. Then.", "pt-br": "" });
});

test("coming back close: the player's look now, marked near, once a real day (Teko, 2026-11-18)", () => {
  const now = 1795000000;
  const ev = (player, ring, node = "n2") => ({ type: "zone_returned", player, story_id: `s1_prox_${node}_${ring}` });
  const blocks = { JayPi: { start: 1000, since: now - 5000 }, Oswaldo: { start: 50, since: now - 900 } };
  let r = nearLooks([ev("JayPi", "far"), ev("JayPi", "mid"), ev("Oswaldo", "wide"), ev("Ana", "near", "n1")],
    { node: "n2", blocks, active: { JayPi: 4600, Oswaldo: 80 }, nowSec: now });
  assert.deepEqual(r.closed, [{ player: "JayPi", from: now - 5000, to: now, seconds: 3600, near: "mid" }], "the strongest ring; wide and another chapter never count");
  assert.deepEqual(r.blocks.JayPi, { start: 4600, since: now }, "a fresh block opens");
  assert.deepEqual(r.blocks.Oswaldo, blocks.Oswaldo);
  const again = nearLooks([ev("JayPi", "near")], { node: "n2", blocks: r.blocks, active: { JayPi: 4700 }, given: r.given, nowSec: now + 600 });
  assert.equal(again.closed.length, 0, "one look a real day");
  const tomorrow = nearLooks([ev("JayPi", "near")], { node: "n2", blocks: r.blocks, active: { JayPi: 9000 }, given: r.given, nowSec: now + 86400 });
  assert.equal(tomorrow.closed[0]?.near, "near", "the next day, again");
  assert.deepEqual(Object.keys(tomorrow.given), ["JayPi"]);
  const soon = gateWatch({ directives: [{ type: "diary_entry", player: "ana", text: "The starch again. {pull}", pull: PULL }] },
    { asked: new Map([["ana", { ...westBlock, near: "mid" }]]), languages: ["en"], place: RIVERSIDE, own: westOwn });
  assert.equal(soon.accepted[0].pace, "soon", "the look earned by coming close is written soon");
  assert.equal(gatePull("The starch again. {pull}").accepted[0].pace, undefined, "an ordinary look keeps the diary's pace");
  const waiting = nearLooks([ev("JayPi", "near")], { node: "n2", blocks, nowSec: now, due: [{ player: "JayPi", to: now - 60 }] });
  assert.equal(waiting.closed.length, 0, "a block already waiting for its look is enough");
});

test("fillPull: the band and the compass word from where the reader stands, as the mod does", () => {
  const pull = { x: 1000, y: 1000, ...PULL };
  assert.equal(fillPull("Grass. {pull}", pull, 5000, 1000), "Grass. But it isn't here. Something keeps pulling me west, toward Riverside.");
  assert.equal(fillPull("Grass. {pull}", pull, 1430, 1000), "Grass. It pulls west, a few streets off.");
  assert.deepEqual(fillPull({ en: "{pull} Then.", "pt-br": "{pull} Então." },
    { ...pull, near: { en: "Here, {dir}.", "pt-br": "Aqui, ao {dir}." } }, 1000, 1100), { en: "Here, north. Then.", "pt-br": "Aqui, ao norte. Então." });
  assert.equal(fillPull("Grass. {pull} Then.", pull, undefined, undefined), "Grass. Then.", "no position: the marker goes");
  assert.equal(fillPull("Grass.", pull, 1, 1), "Grass.");
});

test("watch gate: the player's own town written apart (West Point) is the region the game runs together (WestPoint)", async () => {
  const { hintPlaceErrors } = await import("../src/watch.js");
  const place = { region: "Riverside", allowed: [], towns: ["West Point", "Riverside", "Muldraugh"], signs: ["starch"] };
  const ok = "Day 525. Four days in West Point and my hands smell of diesel. But it isn't here. Something keeps pulling me toward Riverside.";
  assert.deepEqual(hintPlaceErrors(ok, place, ["WestPoint"]), []);
  const mixed = "Four days in West Point, and starch on my hands.";
  assert.equal(hintPlaceErrors(mixed, place, ["WestPoint"]).length, 1, "still one sentence mixing the day and the sign");
  assert.equal(hintPlaceErrors("Something in Muldraugh pulls at me.", place, ["WestPoint"]).length, 1, "another town is still refused");
});

test("the place gate: where they were, joined to a search, is refused; a plain report is not (production 2026-11-22)", async () => {
  const { hintPlaceErrors } = await import("../src/watch.js");
  const place = { region: "West Point", towns: ["West Point", "Rosewood"], signs: [] };
  const chase = hintPlaceErrors("Whatever I was chasing in Rosewood keeps sliding off me.", place, ["Rosewood"]);
  assert.ok(chase.some((e) => e.includes("Rosewood") && e.includes("chasing")), chase.join("; "));
  const pt = hintPlaceErrors("Seja lá o que eu perseguia em Rosewood continua escorregando de mim.", place, ["Rosewood"]);
  assert.equal(pt.length, 1, pt.join("; "));
  assert.deepEqual(hintPlaceErrors("I walked through Rosewood and back before dark.", place, ["Rosewood"]), []);
});

test("the block: only the last day's towns and places reach the AI; older days keep what they did", () => {
  const ev = (o) => ({ type: "player_journey", player: "ana", ts: "2033-01-01T00:00:00Z", walked_tiles: 10, ...o });
  const t = Date.parse("2033-01-01T00:00:00Z") / 1000;
  const m = blockMaterial([ev({ regions: ["Rosewood", "Muldraugh"], named_places: ["Rosewood Fire Station"] }),
    ev({ regions: ["WestPoint"], named_places: [] })], { player: "ana", from: t - 3600, to: t + 3600 });
  assert.deepEqual(m.regions, ["WestPoint"]);
  assert.deepEqual(m.places, []);
  assert.equal(m.journeys.length, 2);
  assert.equal(m.journeys[0].regions, undefined);
  assert.equal(m.journeys[0].walked_tiles, 10);
  assert.deepEqual(m.journeys[1].regions, ["WestPoint"]);
});
