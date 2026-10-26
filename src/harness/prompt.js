// System prompt assembly. The stable files come first and the per-turn facts
// last, so a provider that caches prompt prefixes can reuse the stable part.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatTime, personLabel } from "./identity.js";
import { MAX_FILE_BYTES, PROMPT_FILES_WARN_BYTES } from "./limits.js";

async function readPromptFile(dir, name) {
  let text;
  try {
    text = await readFile(join(dir, name), "utf8");
  } catch (err) {
    const why = err?.code === "ENOENT" ? "the file is missing" : err.message;
    throw new Error(`Cannot load ${name} from ${dir}: ${why}`, { cause: err });
  }
  text = text.replace(/^﻿/, ""); // some Windows editors add a BOM
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`${name} is ${bytes} bytes, over the ${MAX_FILE_BYTES} byte cap`);
  }
  return { text, bytes };
}

export async function loadPromptFiles(dir, { log }) {
  const soul = await readPromptFile(dir, "soul.md");
  const system = await readPromptFile(dir, "system.md");
  const total = soul.bytes + system.bytes;
  if (total > PROMPT_FILES_WARN_BYTES) {
    log.warn({ bytes: total, warnAt: PROMPT_FILES_WARN_BYTES }, "soul.md and system.md together are large; every message pays for them");
  }
  return { soul: soul.text, system: system.text };
}

// One memory section: its lines, a pointer to what did not fit, or "(none)".
function memoryBlock(heading, snapshot) {
  const body = [...snapshot.lines];
  if (snapshot.omitted > 0) {
    body.push(`(+${snapshot.omitted} older ${snapshot.omitted === 1 ? "entry" : "entries"}; use memory_search)`);
  }
  if (body.length === 0) body.push("(none)");
  return [heading, ...body].join("\n");
}

function chatLine(chat) {
  if (chat.type === "private") return `private chat (id ${chat.id})`;
  return `group${chat.title ? ` "${chat.title}"` : ""} (id ${chat.id})`;
}

export function buildSystemPrompt({ soul, system, input, people, extraPeople, memory, summary, timezone, now }) {
  const sections = [soul.trim(), system.trim()].filter((s) => s !== "");

  const turn = [
    "## Current turn",
    `- Chat: ${chatLine(input.chat)}`,
    `- Speaker: ${personLabel(input.speaker)}`,
  ];
  if (input.replyTo?.isBot) turn.push("- Replying to: you (the bot)");
  else if (input.replyTo?.user) turn.push(`- Replying to: ${personLabel(input.replyTo.user)}`);
  turn.push(`- Time: ${formatTime(now, timezone)} (${timezone})`);
  sections.push(turn.join("\n"));

  // The speaker is always listed, even when the registry could not store them.
  const listed = people.some((p) => p.id === input.speaker.id) ? people : [input.speaker, ...people];
  const shown = new Set(listed.map((p) => p.id));
  const lines = listed.map((p) => `- ${personLabel(p)}${p.id === input.speaker.id ? " (speaking now)" : ""}`);
  for (const p of extraPeople) {
    if (shown.has(p.id)) continue;
    shown.add(p.id);
    lines.push(`- ${personLabel(p)} (from this message)`);
  }
  sections.push(["## People in this chat", ...lines].join("\n"));

  const memoryBlocks = [
    memoryBlock("### Global", memory.global),
    memoryBlock("### This chat", memory.chat),
    memoryBlock(`### About ${input.speaker.displayName} (id ${input.speaker.id})`, memory.speaker),
  ];
  if (memory.replyTo) {
    memoryBlocks.push(memoryBlock(`### About ${memory.replyTo.person.displayName} (id ${memory.replyTo.person.id})`, memory.replyTo.snapshot));
  }
  sections.push(["## Memory", ...memoryBlocks].join("\n"));

  if (summary && summary.trim() !== "") {
    sections.push(`## Earlier in this chat (summary)\n${summary.trim()}`);
  }

  return sections.join("\n\n");
}
