// File store for the agent harness: every read and write of agent data goes
// through here, so the size cap, atomic writes and path guard apply uniformly.

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { MAX_FILE_BYTES } from "./limits.js";

export class FileCapError extends Error {
  constructor(relPath, bytes) {
    super(`${relPath} would be ${bytes} bytes, over the ${MAX_FILE_BYTES} byte cap`);
    this.name = "FileCapError";
    this.relPath = relPath;
    this.bytes = bytes;
  }
}

const isMissing = (err) => err?.code === "ENOENT";

export function createStore({ root, log }) {
  const base = resolve(root);
  // Tail of the promise chain per lock key; a key is dropped once idle.
  const locks = new Map();

  // Resolve `rel` under the root. Backslashes count as separators on every
  // platform, so `..\x` is rejected on Linux too, not just on Windows.
  function pathOf(rel) {
    const full = resolve(base, rel.replaceAll("\\", "/"));
    if (!full.startsWith(base + sep)) throw new Error("path escapes data dir: " + rel);
    return full;
  }

  async function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((done) => { release = done; });
    const tail = prev.then(() => gate); // gate never rejects, so the chain never breaks
    locks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  async function readText(rel) {
    try {
      return await readFile(pathOf(rel), "utf8");
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async function writeText(rel, content, { backup = false } = {}) {
    const file = pathOf(rel);
    const bytes = Buffer.byteLength(content, "utf8");
    // Checked before touching disk, so a rejected write leaves the old file and its .prev intact.
    if (bytes > MAX_FILE_BYTES) throw new FileCapError(rel, bytes);
    await mkdir(dirname(file), { recursive: true });
    if (backup) {
      try {
        await copyFile(file, file + ".prev");
      } catch (err) {
        if (!isMissing(err)) throw err; // nothing to back up on the first write
      }
    }
    // Write beside the target and rename, so a crash never leaves a half-written file.
    // Each write gets its own temp name: two unlocked writes to one file must not share it.
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, file);
  }

  // Parse `text`, or log why it is unusable and return undefined.
  function tryParse(text, rel) {
    try {
      return JSON.parse(text);
    } catch (err) {
      log.warn({ err, rel }, "corrupt JSON in store file");
      return undefined;
    }
  }

  async function readJson(rel, fallback) {
    const text = await readText(rel);
    if (text !== null) {
      const value = tryParse(text, rel);
      if (value !== undefined) return value;
      const prevText = await readText(rel + ".prev");
      if (prevText !== null) {
        const prevValue = tryParse(prevText, rel + ".prev");
        if (prevValue !== undefined) {
          log.warn({ rel }, "restored JSON from .prev backup");
          return prevValue;
        }
      }
      log.warn({ rel }, "no usable JSON, using fallback");
    }
    // Copy so an updater that mutates its input can't corrupt a shared default.
    return structuredClone(fallback);
  }

  const writeJson = (rel, value) => writeText(rel, JSON.stringify(value, null, 2), { backup: true });

  const updateText = (rel, fn, { backup = false } = {}) =>
    withLock(`file:${rel}`, async () => {
      const next = fn(await readText(rel));
      await writeText(rel, next, { backup });
      return next;
    });

  const updateJson = (rel, fallback, fn) =>
    withLock(`file:${rel}`, async () => {
      const next = fn(await readJson(rel, fallback));
      await writeJson(rel, next);
      return next;
    });

  async function remove(rel) {
    await rm(pathOf(rel), { force: true });
  }

  async function byteSize(rel) {
    try {
      return (await stat(pathOf(rel))).size;
    } catch (err) {
      if (isMissing(err)) return 0;
      throw err;
    }
  }

  async function list(relDir) {
    try {
      const entries = await readdir(pathOf(relDir), { withFileTypes: true });
      // Temp files of in-flight (or crashed) writes are not entries.
      return entries.filter((e) => e.isFile() && !e.name.endsWith(".tmp")).map((e) => e.name).sort();
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  return { withLock, readText, writeText, readJson, writeJson, updateText, updateJson, remove, byteSize, list };
}
