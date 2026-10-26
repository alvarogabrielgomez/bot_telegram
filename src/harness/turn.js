// One directed message from start to finish: who is talking, what the bot
// remembers, the tool loop, the reply with mentions, and the housekeeping that
// follows. Everything runs under the chat's lock, so two messages in the same
// chat never interleave; chats do not wait for each other.

import { AGENT_TOOLS, createAgentToolExecutor } from "./agentTools.js";
import { compactMemory, compactTranscript } from "./compaction.js";
import {
  HISTORY_PROMPT_CHARS,
  MEMORY_COMPACT_BYTES,
  MEMORY_COMPACT_RETRY_BYTES,
  MEMORY_PROMPT_CHARS,
  TRANSCRIPT_COMPACT_BYTES,
} from "./limits.js";
import { runLoop } from "./loop.js";
import { buildSystemPrompt } from "./prompt.js";
import { mentionIds, renderReply } from "./reply.js";
import { FileCapError } from "./store.js";
import { entriesFromMessages, groupTurns, renderHistory, renderTurn, selectRecent } from "./transcript.js";

export const URL_RE = /https?:\/\/\S+/i;

const GLOBAL = { kind: "global" };

export function createAgent({
  store,
  memory,
  people,
  transcript,
  complete,
  mediaTools,
  prompts: { soul, system, users = "" },
  timezone,
  maxLlmCalls,
  now = () => new Date(),
  log,
}) {
  const mediaNames = new Set(mediaTools.map((t) => t.function.name));
  const tools = [...mediaTools, ...AGENT_TOOLS];
  const toolNames = tools.map((t) => t.function.name);
  // Partitions whose last compaction did not shrink them, with the size they had
  // then. Without this a partition the model cannot shrink would cost a large
  // LLM call after every single memory_save.
  const stuckAt = new Map();
  // Same brake for transcripts, keyed by chat id: the size a transcript had when
  // its last compaction left it above the threshold.
  const transcriptStuckAt = new Map();

  // Only people who send a directed message enter the registry. A full registry
  // must not leave the bot silent, so that one error is logged and skipped.
  async function registerSpeaker(input) {
    try {
      await people.upsert(input.speaker, input.chat.id);
    } catch (err) {
      if (!(err instanceof FileCapError)) throw err;
      log.warn({ err, chatId: input.chat.id }, "people.json is full; the speaker is not registered");
    }
  }

  // Who the prompt lists: everyone known in this group, or only the speaker in private.
  async function peopleFor(input) {
    if (input.chat.type !== "private") return people.inChat(input.chat.id);
    const record = await people.get(input.speaker.id);
    return record ? [record] : [];
  }

  async function memorySnapshots(input) {
    const chatId = input.chat.id;
    // The snapshot itself drops entries that were written in other private chats.
    const snap = (partition) => memory.snapshot({ partition, chatId, maxChars: MEMORY_PROMPT_CHARS });
    const snapshots = {
      global: await snap(GLOBAL),
      chat: await snap({ kind: "chat", id: chatId }),
      speaker: await snap({ kind: "user", id: input.speaker.id }),
    };
    const other = input.replyTo?.user;
    if (other && other.id !== input.speaker.id) {
      snapshots.replyTo = { person: other, snapshot: await snap({ kind: "user", id: other.id }) };
    }
    return snapshots;
  }

  // Mention only people the chat can actually reach: the speaker in private,
  // current members in a group. Everyone else renders as a plain name.
  async function mentionableIds(text, input, known, io) {
    const mentionable = new Set();
    const isPrivate = input.chat.type === "private";
    for (const id of mentionIds(text)) {
      if (!known.has(id)) continue; // renderReply drops unknown ids, so asking Telegram would be wasted
      if (isPrivate ? id === input.chat.id : await io.isMember(id)) mentionable.add(id);
    }
    return mentionable;
  }

  async function compactPartition(key) {
    const partition = JSON.parse(key);
    const size = await memory.byteSize(partition);
    if (size <= MEMORY_COMPACT_BYTES) {
      stuckAt.delete(key);
      return;
    }
    const stuck = stuckAt.get(key);
    if (stuck !== undefined && size < stuck + MEMORY_COMPACT_RETRY_BYTES) return;
    if (await compactMemory({ memory, partition, complete, log })) stuckAt.delete(key);
    else stuckAt.set(key, await memory.byteSize(partition));
  }

  async function compactChatTranscript(chatId) {
    const size = await transcript.byteSize(chatId);
    if (size <= TRANSCRIPT_COMPACT_BYTES) {
      transcriptStuckAt.delete(chatId);
      return;
    }
    const stuck = transcriptStuckAt.get(chatId);
    if (stuck !== undefined && size < stuck + MEMORY_COMPACT_RETRY_BYTES) return;
    if (await compactTranscript({ chatId, transcript, complete, timezone, log })) transcriptStuckAt.delete(chatId);
    else transcriptStuckAt.set(chatId, await transcript.byteSize(chatId));
  }

  // Runs after the reply is out, so a slow summary never delays the answer.
  // Failures are only logged: the data is still valid, just bigger than wanted.
  async function compactAfterReply(chatId, touched) {
    try {
      await compactChatTranscript(chatId);
    } catch (err) {
      log.warn({ err, chatId }, "transcript compaction failed");
    }
    for (const key of touched) {
      try {
        await compactPartition(key);
      } catch (err) {
        log.warn({ err, chatId, partition: key }, "memory compaction failed");
      }
    }
  }

  async function runTurn(input, io) {
    const chatId = input.chat.id;
    const isPrivate = input.chat.type === "private";

    await registerSpeaker(input);

    const { entries, summary } = await transcript.load(chatId);
    const { recent } = selectRecent(groupTurns(entries), HISTORY_PROMPT_CHARS, { timezone });
    const snapshots = await memorySnapshots(input);

    const listed = await peopleFor(input);
    const listedIds = new Set(listed.map((p) => p.id));
    listedIds.add(input.speaker.id);
    const extraPeople = [input.replyTo?.user, ...input.mentioned].filter(
      (p, i, all) => p && !listedIds.has(p.id) && all.findIndex((q) => q?.id === p.id) === i,
    );
    const known = new Map([...extraPeople, ...listed, input.speaker].map((p) => [p.id, p]));

    // replyTo.text goes in full; it is cut when the turn is written to disk.
    const userEntry = {
      type: "user",
      ts: input.date.toISOString(),
      messageId: input.messageId,
      from: input.speaker,
      replyTo: input.replyTo,
      text: input.text,
    };
    const messages = [
      {
        role: "system",
        content: buildSystemPrompt({ soul, system, users, input, people: listed, extraPeople, memory: snapshots, summary, timezone, now: now() }),
      },
      ...renderHistory(recent, { timezone }),
      ...renderTurn([userEntry], { timezone }),
    ];

    const agentTools = createAgentToolExecutor({
      memory,
      people,
      telegramInfo: io.telegramInfo,
      turn: { chatId, speakerId: input.speaker.id, origin: { kind: isPrivate ? "private" : "group", chatId } },
    });
    const executeTool = async (name, args) => {
      if (agentTools.has(name)) return agentTools.execute(name, args);
      if (mediaNames.has(name)) return io.deliverTool(name, args);
      return `Error: unknown tool ${name}. Available tools: ${toolNames.join(", ")}.`;
    };

    const result = await runLoop({ messages, tools, complete, executeTool, maxCalls: maxLlmCalls });
    let { text, added } = result;
    // Only media tools count as work that answers the user. A turn that ran just
    // memory or telegram_info tools and ended with no text has said nothing.
    const ranMediaTool = result.toolCalls.some((c) => mediaNames.has(c.name));
    let ranTools = ranMediaTool;

    // Small models often answer a link with chat instead of calling a tool.
    // Memory tools don't count here: the model searches memory often, and that
    // alone must not stop the download.
    const url = input.text.match(URL_RE)?.[0];
    if (url && !ranMediaTool) {
      log.warn({ chatId }, "message has a URL but the model called no media tool; forcing download_video");
      const callId = `call_url_${input.messageId}`;
      const output = await io.deliverTool("download_video", { url });
      text = "";
      ranTools = true;
      added = [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: callId, type: "function", function: { name: "download_video", arguments: JSON.stringify({ url }) } }],
        },
        { role: "tool", tool_call_id: callId, content: output },
      ];
    }

    if (text.trim() === "" && !ranTools) throw new Error("empty model reply");

    // The prompt lists only some people (in a DM, just the speaker). A registry
    // person the model mentions by id must still render as a name, so look the
    // missing ids up; an id the registry does not know stays unknown and is dropped.
    for (const id of mentionIds(text)) {
      if (known.has(id)) continue;
      const record = await people.get(id);
      if (record) known.set(id, record);
    }

    const mentionable = await mentionableIds(text, input, known, io);
    for (const chunk of renderReply(text, { people: known, mentionable })) {
      await io.send(chunk);
    }

    await transcript.appendTurn(chatId, [userEntry, ...entriesFromMessages(added, now())]);
    log.info({ chatId, llmCalls: result.calls, tools: result.toolCalls.map((c) => c.name) }, "turn done");

    await compactAfterReply(chatId, agentTools.touched);
  }

  return {
    handleTurn: (input, io) => store.withLock(`chat:${input.chat.id}`, () => runTurn(input, io)),

    // Forgets the conversation of one chat. Long-term memory stays.
    reset: (chatId) => store.withLock(`chat:${chatId}`, () => transcript.clear(chatId)),
  };
}
