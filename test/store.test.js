// test/store.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createStore, FileCapError } from "../src/harness/store.js";
import { MAX_FILE_BYTES, truncate } from "../src/harness/limits.js";
import { silentLog, tmpDir } from "./helpers.js";

const newStore = async () => { const root = await tmpDir(); return { root, store: createStore({ root, log: silentLog }) }; };

test("writeText round-trips and creates parent dirs", async () => {
  const { store } = await newStore();
  await store.writeText("a/b/c.md", "hola");
  assert.equal(await store.readText("a/b/c.md"), "hola");
  assert.equal(await store.readText("missing.md"), null);
});

test("cap is 204800 bytes measured in UTF-8", async () => {
  const { store } = await newStore();
  assert.equal(MAX_FILE_BYTES, 204800);
  await store.writeText("ok.md", "a".repeat(204800));
  await store.writeText("x.md", "previo");
  await assert.rejects(store.writeText("x.md", "ñ".repeat(102401)), FileCapError); // 204802 bytes
  assert.equal(await store.readText("x.md"), "previo");
});

test("backup keeps the previous content in .prev", async () => {
  const { store } = await newStore();
  await store.writeText("m.md", "v1");
  await store.writeText("m.md", "v2", { backup: true });
  assert.equal(await store.readText("m.md.prev"), "v1");
});

test("readJson falls back to .prev, then to the fallback", async () => {
  const { root, store } = await newStore();
  await store.writeJson("p.json", { n: 1 });
  await store.writeJson("p.json", { n: 2 });
  await store.writeText("p.json", "{corrupt");
  assert.deepEqual(await store.readJson("p.json", {}), { n: 1 });
  assert.deepEqual(await store.readJson("none.json", { empty: true }), { empty: true });
});

test("updateJson serializes concurrent updates", async () => {
  const { store } = await newStore();
  await Promise.all(Array.from({ length: 20 }, () => store.updateJson("c.json", { n: 0 }, (v) => ({ n: v.n + 1 }))));
  assert.deepEqual(await store.readJson("c.json", null), { n: 20 });
});

test("withLock runs same-key work in order", async () => {
  const { store } = await newStore();
  const order = [];
  await Promise.all([
    store.withLock("k", async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); }),
    store.withLock("k", async () => { order.push(2); }),
  ]);
  assert.deepEqual(order, [1, 2]);
});

test("rejects paths that escape the root", async () => {
  const { store } = await newStore();
  await assert.rejects(store.writeText("../evil.md", "x"));
  await assert.rejects(store.writeText("..\\evil.md", "x"));
});

test("truncate appends a note with the remaining count", () => {
  assert.equal(truncate("abc", 5, "n"), "abc");
  assert.equal(truncate("abcdef", 4, "Ask for less."), "abcd\n[truncated: 2 more chars. Ask for less.]");
});
