// Long-term memory the agent writes itself, split into partitions (global,
// per chat, per user). Each file is a Markdown list of one-line entries. An
// entry remembers where it was written, and private entries are only visible
// in the private chat they came from.

import { randomUUID } from "node:crypto";
import { MAX_FILE_BYTES, MAX_MEMORY_ENTRY_CHARS, MEMORY_INPUT_MAX_CHARS, SEARCH_RESULTS } from "./limits.js";
import { tokenize } from "./text.js";
import { cleanUntrusted } from "./untrusted.js";

export class MemoryError extends Error {
  name = "MemoryError";
}

const ENTRY_RE = /^- \[([^\]\s]+)\] (\d{4}-\d{2}-\d{2}) (private|group):(-?\d+) by:(-?\d+) · (.+)$/;

export function formatEntry({ id, date, origin, by, text }) {
  return `- [${id}] ${date} ${origin.kind}:${origin.chatId} by:${by} · ${text}`;
}

function parseLine(line) {
  const m = ENTRY_RE.exec(line);
  if (!m) return null;
  return {
    id: m[1],
    date: m[2],
    origin: { kind: m[3], chatId: Number(m[4]) },
    by: Number(m[5]),
    text: m[6],
  };
}

const linesOf = (markdown) => markdown.split(/\r?\n/);

export function parseEntries(markdown) {
  return linesOf(markdown).map(parseLine).filter(Boolean);
}

// A group entry is visible everywhere; a private one only in its own chat.
export function isVisible(entry, chatId) {
  return entry.origin.kind === "group" || entry.origin.chatId === chatId;
}

const SECRET_PATTERNS = [
  ["Telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ["API key", /\b(nvapi|sk|ghp|gho|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/i],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["card or account number", /\b(?:\d[ -]?){13,19}\b/],
  ["password", /\b(password|passwd|contraseña|clave)\s*[:=]\s*\S+/i],
];

// Returns why `text` looks like a secret, or null. A false positive costs one
// refused save; a false negative writes a credential to disk.
export function looksSensitive(text) {
  for (const [reason, re] of SECRET_PATTERNS) {
    if (re.test(text)) return reason;
  }
  return null;
}

const assertSafeId = (id) => {
  if (!Number.isSafeInteger(id)) throw new Error(`invalid memory partition id: ${id}`);
};

function pathOf(partition) {
  if (partition.kind === "global") return "memory/memory.md";
  if (partition.kind === "chat") {
    assertSafeId(partition.id);
    return `memory/chats/${partition.id}.md`;
  }
  if (partition.kind === "user") {
    assertSafeId(partition.id);
    return `memory/users/${partition.id}.md`;
  }
  throw new Error(`unknown memory partition kind: ${partition.kind}`);
}

function headerOf(partition) {
  return partition.kind === "global" ? "# memory · global" : `# memory · ${partition.kind} ${partition.id}`;
}

export function partitionLabel(p) {
  return p.kind === "user" ? `user ${p.id}` : p.kind;
}

const render = (partition, entries) =>
  `${headerOf(partition)}\n${entries.map((e) => `${formatEntry(e)}\n`).join("")}`;

// Thrown inside a store.updateText callback to leave the file untouched: the
// store always writes what the callback returns, so aborting is the only way
// to skip the write (and the .prev backup it would overwrite).
class NoRewrite extends Error {
  constructor(entries) {
    super("no rewrite");
    this.entries = entries;
  }
}

export function createMemory({ store, log, now = () => new Date(), newId = () => randomUUID().slice(0, 8) }) {
  async function readEntries(partition) {
    return parseEntries((await store.readText(pathOf(partition))) ?? "");
  }

  async function updateEntries(partition, fn) {
    const rel = pathOf(partition);
    let written;
    try {
      await store.updateText(
        rel,
        (text) => {
          const content = text ?? "";
          const current = parseEntries(content);
          // A hand-edited or old-format file would lose those lines on rewrite.
          const header = headerOf(partition);
          const unparsed = linesOf(content).filter((l) => l.trim() !== "" && l !== header && !parseLine(l));
          if (unparsed.length > 0) {
            log.warn({ partition, unparsed: unparsed.slice(0, 5) }, "memory file has unparsed lines; not rewriting");
            throw new NoRewrite(current);
          }
          const next = fn(current);
          if (next === current) throw new NoRewrite(current);
          written = next;
          return render(partition, next);
        },
        { backup: true },
      );
    } catch (err) {
      if (err instanceof NoRewrite) return err.entries;
      throw err;
    }
    return written;
  }

  async function save({ partition, text, origin, by }) {
    const rel = pathOf(partition);
    if (!Number.isSafeInteger(by)) throw new Error(`invalid memory author id: ${by}`);
    if (!["private", "group"].includes(origin?.kind) || !Number.isSafeInteger(origin?.chatId)) {
      throw new Error("invalid memory origin");
    }

    // The model may be repeating what a user or a tool result said, so the
    // text is cleaned like any other untrusted text before it is stored.
    const cleaned = cleanUntrusted(text, { max: MEMORY_INPUT_MAX_CHARS });
    if (cleaned.removed > 0) log.info({ field: "memory entry", removed: cleaned.removed }, "stripped invisible characters");
    const clean = cleaned.text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
    if (clean === "") throw new MemoryError("Memory text is empty.");
    if (clean.length > MAX_MEMORY_ENTRY_CHARS) {
      throw new MemoryError(`Memory text has ${clean.length} chars; the limit is ${MAX_MEMORY_ENTRY_CHARS}. Save one short fact.`);
    }
    const reason = looksSensitive(clean);
    if (reason) throw new MemoryError(`That looks like a secret (${reason}); secrets are never stored.`);

    let entry;
    await store.updateText(
      rel,
      (current) => {
        const taken = new Set(parseEntries(current ?? "").map((e) => e.id));
        let id = newId();
        for (let tries = 0; taken.has(id) && tries < 5; tries++) id = newId();
        entry = { id, date: now().toISOString().slice(0, 10), origin: { kind: origin.kind, chatId: origin.chatId }, by, text: clean };

        let base = current ?? `${headerOf(partition)}\n`;
        if (!base.endsWith("\n")) base += "\n";
        const next = `${base}${formatEntry(entry)}\n`;
        if (Buffer.byteLength(next, "utf8") > MAX_FILE_BYTES) {
          throw new MemoryError("This memory partition is full. Use memory_forget on outdated entries first.");
        }
        return next;
      },
      { backup: true },
    );
    return entry;
  }

  // Score = exact token matches, plus half a point for a prefix match between
  // tokens of 4+ characters ("playlist" finds "playlists").
  function scoreOf(queryTokens, text) {
    const tokens = new Set(tokenize(text));
    let score = 0;
    for (const q of queryTokens) {
      if (tokens.has(q)) {
        score += 1;
      } else if ([...tokens].some((t) => Math.min(t.length, q.length) >= 4 && (t.startsWith(q) || q.startsWith(t)))) {
        score += 0.5;
      }
    }
    return score;
  }

  async function search({ query, chatId, partitions }) {
    const queryTokens = [...new Set(tokenize(query ?? ""))];
    const hits = [];
    let seq = 0;
    for (const partition of partitions) {
      for (const entry of await readEntries(partition)) {
        seq += 1;
        if (!isVisible(entry, chatId)) continue;
        const score = queryTokens.length === 0 ? 0 : scoreOf(queryTokens, entry.text);
        if (queryTokens.length > 0 && score === 0) continue;
        hits.push({ entry, partition, score, seq });
      }
    }
    // Entries only carry a date, so line order breaks ties: later in the file is newer.
    hits.sort((a, b) => b.score - a.score || (a.entry.date < b.entry.date ? 1 : a.entry.date > b.entry.date ? -1 : 0) || b.seq - a.seq);
    return hits.slice(0, SEARCH_RESULTS).map(({ entry, partition, score }) => ({ entry, partition, score }));
  }

  async function forget({ id, chatId, partitions }) {
    for (const partition of partitions) {
      let found = false;
      await updateEntries(partition, (current) => {
        const doomed = (e) => e.id === id && isVisible(e, chatId);
        if (!current.some(doomed)) return current;
        found = true;
        return current.filter((e) => !doomed(e));
      });
      if (found) return true;
    }
    return false;
  }

  async function snapshot({ partition, chatId, maxChars }) {
    const visible = (await readEntries(partition)).filter((e) => isVisible(e, chatId));
    const lines = [];
    let used = 0;
    for (let i = visible.length - 1; i >= 0; i--) {
      const e = visible[i];
      const line = `- [${e.id}] ${e.date} by ${e.by}: ${e.text}`;
      if (used + line.length + 1 > maxChars) break;
      used += line.length + 1; // +1 for the newline that joins it in the prompt
      lines.push(line);
    }
    return { lines: lines.reverse(), omitted: visible.length - lines.length };
  }

  async function userPartitions() {
    const names = await store.list("memory/users");
    return names
      .filter((name) => /^-?\d+\.md$/.test(name))
      .map((name) => ({ kind: "user", id: Number(name.slice(0, -3)) }))
      .filter((p) => Number.isSafeInteger(p.id));
  }

  return {
    save,
    search,
    forget,
    snapshot,
    readEntries,
    updateEntries,
    byteSize: (partition) => store.byteSize(pathOf(partition)),
    userPartitions,
  };
}
