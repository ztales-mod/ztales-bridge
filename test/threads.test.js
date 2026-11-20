import { test } from "node:test";
import assert from "node:assert/strict";
import { tick } from "../src/tick.js";
import { MemoryTransport } from "../src/transport.js";
import { MemoryStore } from "../src/store.js";
import { leftBehindText, updateLeftOpen, dueLeftBehind, chooseThread, threadFor, nextThread, LEFT_AFTER_SEC } from "../src/threads.js";

const T0 = 1_800_000_000;
const L = ["en", "pt-br"];

test("left_behind: kept only whole, short, in every language, with no forbidden name", () => {
  const ok = { en: "That cellar keeps coming back to me.", "pt-br": "Aquele porão não sai da minha cabeça." };
  assert.deepEqual(leftBehindText(ok, L), ok);
  assert.equal(leftBehindText({ en: "only english" }, L), null);
  assert.equal(leftBehindText({ en: "x".repeat(301), "pt-br": "y" }, L), null);
  assert.equal(leftBehindText({ en: "Marlowe again", "pt-br": "Marlowe de novo" }, L, ["Marlowe"]), null);
  assert.equal(leftBehindText(undefined, L), null);
});

test("opened and left: a line after the wait, once per player per chapter; a pick-up clears it", () => {
  const pieces = new Set(["n2_photo"]);
  let open = updateLeftOpen({}, [
    { type: "container_opened", story_id: "n2_photo", player: "jp" },
    { type: "container_opened", story_id: "n2_photo", player: "ana" },
    { type: "container_opened", story_id: "other_thing", player: "bo" },
  ], pieces, "n2", T0);
  assert.deepEqual(Object.keys(open).sort(), ["n2_photo|ana", "n2_photo|jp"]);
  // too soon: nothing
  let r = dueLeftBehind({ open, season: "s1", node: "n2", languages: L, nowSec: T0 + 60 });
  assert.equal(r.directives.length, 0);
  // after the wait: one line each, the bridge's own when the AI wrote none
  r = dueLeftBehind({ open, season: "s1", node: "n2", languages: L, nowSec: T0 + LEFT_AFTER_SEC });
  assert.deepEqual(r.directives.map((d) => d.id).sort(), ["s1_left_n2_ana", "s1_left_n2_jp"]);
  assert.equal(r.directives[0].type, "diary_entry");
  assert.equal(r.directives[0].kind, "left_behind");
  assert.ok(r.directives[0].text.en && r.directives[0].text["pt-br"]);
  assert.deepEqual(r.open, {});
  // opening again in the same chapter: never a second line
  open = updateLeftOpen(r.open, [{ type: "container_opened", story_id: "n2_photo", player: "jp" }], pieces, "n2", T0 + 2000);
  const again = dueLeftBehind({ open, sent: r.sent, season: "s1", node: "n2", nowSec: T0 + 2000 + LEFT_AFTER_SEC });
  assert.equal(again.directives.length, 0);
  // somebody picked it up before the wait ran out: nobody is told
  open = updateLeftOpen({}, [{ type: "container_opened", story_id: "n2_photo", player: "bo" }], pieces, "n2", T0);
  open = updateLeftOpen(open, [{ type: "item_picked", story_id: "n2_photo", player: "ana" }], pieces, "n2", T0 + 30);
  assert.deepEqual(open, {});
  // the chapter moved on: what waited for the old one is dropped
  open = updateLeftOpen({ "n2_photo|bo": { sid: "n2_photo", player: "bo", node: "n2", at: T0 } }, [], new Set(), "n3", T0);
  assert.deepEqual(open, {});
});

test("tick: the AI's left_behind line reaches who opened the piece's container and went without it", async () => {
  const store = new MemoryStore();
  const line = { en: "The cellar keeps coming back to me.", "pt-br": "O porão não sai da minha cabeça." };
  await store.setState({ node: "n2", season: "s1", languages: L, pieces_by_node: [{ node: "n2", ids: ["n2_photo"] }],
    left_behind_texts: { n2: line } });
  const files = {
    "outbox/seq.json": JSON.stringify({ seq: 1, players_online: 1 }),
    "outbox/events-1-00001.json": JSON.stringify({ events: [{ type: "container_opened", story_id: "n2_photo", player: "jp", x: 1, y: 2, z: -1 }] }),
  };
  const t = new MemoryTransport(files);
  await tick({ t, store, nowSec: T0 });
  assert.ok((await store.getState()).left_open["n2_photo|jp"]);
  t.files.set("outbox/seq.json", JSON.stringify({ seq: 1, players_online: 1 }));
  const r = await tick({ t, store, nowSec: T0 + LEFT_AFTER_SEC + 1 });
  assert.ok(r.notes.some((n) => n.startsWith("left behind: jp")), r.notes.join("; "));
  const inbox = [...t.files.keys()].filter((k) => /^inbox\/directives-/.test(k));
  const sent = inbox.flatMap((k) => JSON.parse(t.files.get(k)).directives);
  const d = sent.find((x) => x.id === "s1_left_n2_jp");
  assert.ok(d, "the line went out");
  assert.deepEqual(d.text, line);
  assert.deepEqual((await store.getState()).left_open, {});
});

test("thread: the strongest page of 2 or more, another author first; carried by one stage, then dropped", () => {
  const motifs = [{ id: "j1", text: "The man at the gas station knew the dog's name." }, { id: "j2", text: "Someone moved the photo after we left." }];
  const contribs = [{ player: "ana", chapter: "n1", page: "j1", score: 3 }, { player: "jp", chapter: "n2", page: "j2", score: 2 }];
  assert.equal(chooseThread(contribs, motifs, null, "n3").player, "ana");
  // ana held the last thread: jp's page goes first
  const th = chooseThread(contribs, motifs, "ana", "n3");
  assert.equal(th.player, "jp");
  assert.equal(th.text, motifs[1].text);
  assert.equal(chooseThread([{ player: "jp", chapter: "n2", page: "j2", score: 1 }], motifs, null, "n3"), null);
  // what a call is told: no score, no bookkeeping
  assert.deepEqual(threadFor({ ...th, season: "s1" }, "s1"), { player: "jp", chapter: "n2", text: motifs[1].text });
  assert.equal(threadFor({ ...th, season: "s1" }, "s2"), null);
  // set while writing n3: kept through n3's own rewrites, dropped once a later stage carried it
  assert.equal(nextThread(th, null, "n3"), th);
  assert.equal(nextThread(th, null, "n4"), null);
  assert.equal(nextThread(th, null, "n3", true), null);
});
