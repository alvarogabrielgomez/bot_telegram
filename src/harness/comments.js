// Keeps the bot from repeating itself. Every reply is checked against the bot's
// recent replies in the same chat; the short comment it adds after a tool
// delivered something (a video, a song, images) has tighter rules. The harness
// enforces this in code because a small model ignores "be varied" in a prompt.

import { normalize } from "./text.js";

// After a tool delivered something: one short line, clearly different from the
// recent comments for the same tool.
export const TOOL_COMMENT_RULES = { maxChars: 60, maxSimilarity: 0.3, minChars: 0 };
// Any other reply: no extra length cap (polishReply already cuts at 500), a looser
// similarity bar, and very short replies ("sí", "listo", an id) are never checked.
export const REPLY_RULES = { maxChars: Infinity, maxSimilarity: 0.5, minChars: 26 };

const COMPARE_WITH = 5; // recent replies a new one is checked against
const KEEP = 10; // replies stored per kind

const trigrams = (text, ignore) => {
  let words = normalize(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ");
  words = words.filter((w) => w && !ignore.has(w));
  const s = ` ${words.join(" ")} `;
  const grams = new Set();
  for (let i = 0; i + 3 <= s.length; i++) grams.add(s.slice(i, i + 3));
  return grams;
};

// Jaccard similarity of character trigrams, 0 (nothing shared) to 1 (same text).
// Accents, case, punctuation and the `ignore` words (names) don't count.
export function similarity(a, b, ignoreWords = []) {
  const ignore = new Set(ignoreWords.flatMap((w) => normalize(String(w)).split(/[^\p{L}\p{N}]+/u)).filter(Boolean));
  const x = trigrams(a, ignore);
  const y = trigrams(b, ignore);
  if (x.size === 0 && y.size === 0) return 1;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared / (x.size + y.size - shared);
}

// Returns null when the reply is acceptable, or the reason it isn't (written for
// the model, which gets it back to try again).
export function checkReply(text, recent, { maxChars, maxSimilarity, minChars, ignore = [] }) {
  const length = Array.from(text.trim()).length;
  if (length === 0) return "it is empty";
  if (length > maxChars) return `it has ${length} characters; the limit is ${maxChars}`;
  if (length < minChars) return null;
  for (const previous of recent.slice(-COMPARE_WITH)) {
    const score = similarity(text, previous, ignore);
    if (score >= maxSimilarity) {
      return `it is ${Math.round(score * 100)}% similar to a recent message ("${previous}"); the limit is ${Math.round(maxSimilarity * 100)}%`;
    }
  }
  return null;
}

// Per-chat history in chats/<chatId>/comments.json: { [kind]: string[] }, where
// kind is a tool name for post-tool comments or "reply" for everything else.
export function createCommentLog({ store }) {
  const rel = (chatId) => `chats/${Number(chatId)}/comments.json`;
  return {
    async recent(chatId, kind) {
      const all = await store.readJson(rel(chatId), {});
      return Array.isArray(all[kind]) ? all[kind] : [];
    },
    async add(chatId, kind, text) {
      await store.updateJson(rel(chatId), {}, (all) => ({ ...all, [kind]: [...(all[kind] ?? []), text].slice(-KEEP) }));
    },
  };
}
