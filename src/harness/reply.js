// Turns the model's text into Telegram messages. The model writes
// [[mention:ID]] where it wants to mention someone; here each token becomes the
// person's name plus, when allowed, a text_mention entity. Entities need no
// parse_mode, so a stray "_" or "*" in the reply can never break the send.

import { TELEGRAM_CHUNK_CHARS } from "./limits.js";
import { stripInvisible } from "./untrusted.js";

const TOKEN_SOURCE = String.raw`\[\[mention:(\d{1,15})\]\]`;

export function mentionIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(new RegExp(TOKEN_SOURCE, "g"))) ids.add(Number(m[1]));
  return [...ids];
}

// Cut the raw text into pieces of `limit` characters or fewer. Prefer the last
// newline, then the last space; a hard cut must not land inside a token.
function splitRaw(text, limit) {
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) {
      cut = limit;
      for (const m of rest.matchAll(new RegExp(TOKEN_SOURCE, "g"))) {
        if (m.index >= limit) break;
        if (m.index < cut && cut < m.index + m[0].length) {
          if (m.index > 0) cut = m.index;
          break;
        }
      }
      // Never leave half of a surrogate pair on either side of the cut.
      const code = rest.charCodeAt(cut - 1);
      if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
}

function renderChunk(raw, { people, mentionable }) {
  let text = "";
  const entities = [];
  let last = 0;
  for (const m of raw.matchAll(new RegExp(TOKEN_SOURCE, "g"))) {
    text += raw.slice(last, m.index);
    last = m.index + m[0].length;
    const id = Number(m[1]);
    const person = people.get(id);
    if (!person) continue; // unknown id: drop the token
    if (mentionable.has(id)) {
      // .length counts UTF-16 units, the same unit Telegram uses for offsets.
      entities.push({
        type: "text_mention",
        offset: text.length,
        length: person.displayName.length,
        user: { id, is_bot: false, first_name: person.firstName },
      });
    }
    text += person.displayName;
  }
  text += raw.slice(last);

  // Trimming leading whitespace shifts every entity left by the same amount.
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  for (const e of entities) e.offset -= lead;
  return { text: trimmed, entities };
}

// Chat replies stay short and plain whatever the model writes: Telegram shows
// Markdown literally (no parse_mode), memory ids are internal, and a small model
// ignores length rules in the prompt.
const MEMORY_ID_RE = /\s*\[[0-9a-f]{8}\]/g;
const SENTENCE_ENDS = [". ", "! ", "? ", "… ", ".\n", "!\n", "?\n", "\n"];
const LIST_ITEM_RE = /^(?:[-•*]|\d+[.)])\s/;

// Prompt plumbing a small model sometimes echoes back to the chat: harness
// labels, "(id 123)" asides, empty-section markers, section names.
const INTERNALS = [
  [/⟦[^⟧]*⟧/g, ""],
  [/\s*\(id -?\d+\)/g, ""],
  [/\s*\(none\)/gi, ""],
  [/\b(?:memoria|memory) (?:chat|global)\b/gi, "memoria"],
];

// One paragraph: line breaks become spaces, except in front of list items.
const oneParagraph = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((out, line, i) => (i === 0 ? line : `${out}${LIST_ITEM_RE.test(line) ? "\n" : " "}${line}`), "");

export function polishReply(text, { maxChars }) {
  let out = String(text ?? "")
    .replace(/\*\*|`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(MEMORY_ID_RE, "");
  for (const [pattern, replacement] of INTERNALS) out = out.replace(pattern, replacement);
  out = oneParagraph(out).trim();
  if (out.length <= maxChars) return out;
  const head = out.slice(0, maxChars);
  // Cut after the last whole sentence that fits; failing that, at the last space.
  const end = Math.max(...SENTENCE_ENDS.map((mark) => head.lastIndexOf(mark)));
  if (end > maxChars * 0.4) return head.slice(0, end + 1).trim();
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > 0 ? space : maxChars).trimEnd()}…`;
}

export function renderReply(text, { people, mentionable, log }) {
  // Bidi and zero-width characters could disguise a link from whoever reads it.
  // The joiners stay: they build emojis such as family sequences.
  const stripped = stripInvisible(text, { keepEmojiJoiners: true });
  if (stripped.removed > 0) log?.info({ field: "reply", removed: stripped.removed }, "stripped invisible characters");
  return splitRaw(stripped.text, TELEGRAM_CHUNK_CHARS)
    .map((raw) => renderChunk(raw, { people, mentionable }))
    .filter((chunk) => chunk.text !== "");
}
