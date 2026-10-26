// The tools the harness itself provides to the model: long-term memory and a
// read-only window into Telegram. The media tools (download, Spotify, images)
// stay in src/tools; these four never leave the chat they run in.

import { truncate } from "./limits.js";
import { isVisible, MemoryError, partitionLabel } from "./memory.js";

// Descriptions are written for someone new on the team: what the tool does,
// when to use it, and one example call.
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        'Search long-term memory by keywords. With user_id it searches only what is known about that person. With an empty query it returns the newest entries. Each result starts with its [id], which memory_forget accepts. Example: {"query":"favorite playlist","user_id":123}.',
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to look for. Empty returns the newest entries." },
          user_id: { type: "integer", description: "Telegram id of a person from the People list. Omit to search everywhere visible from this chat." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_save",
      description:
        'Save one durable fact as a single line of 500 characters or fewer. Scope "user" is for a fact about one person; without user_id the person is whoever is speaking. Scope "chat" is for this chat only and "global" for everything else. Never save small talk or secrets. Example: {"scope":"user","user_id":456,"text":"Humberto is vegetarian"}.',
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "chat", "user"], description: "Where the fact belongs." },
          text: { type: "string", description: "The fact, on one line, 500 characters or fewer." },
          user_id: { type: "integer", description: 'Only with scope "user": Telegram id of the person the fact is about.' },
        },
        required: ["scope", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_forget",
      description:
        'Delete the memory entry with this id. The id is the text in square brackets in a memory_search result or in the Memory section of the prompt. Example: {"id":"ab12cd34"}.',
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The entry id, without the square brackets." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "telegram_info",
      description:
        'Ask Telegram about this chat: "chat" returns its title, description and member count, "member" returns one person\'s status in it (needs user_id), "admins" lists the administrators. Example: {"action":"member","user_id":456}.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["chat", "member", "admins"], description: "What to ask Telegram." },
          user_id: { type: "integer", description: 'Required for action "member".' },
        },
        required: ["action"],
      },
    },
  },
];

const NAMES = new Set(AGENT_TOOLS.map((t) => t.function.name));
const INFO_MAX_CHARS = 4_000;

const GLOBAL = { kind: "global" };

export function createAgentToolExecutor({ memory, people, telegramInfo, turn }) {
  const touched = new Set();
  const chatPartition = { kind: "chat", id: turn.chatId };

  // Everything this chat may read: global, this chat, and every person's file
  // (the visibility filter in memory drops entries written in other private chats).
  const visiblePartitions = async () => [GLOBAL, chatPartition, ...(await memory.userPartitions())];

  async function save({ scope, text, user_id: userId }) {
    let partition;
    if (scope === "global") {
      partition = GLOBAL;
    } else if (scope === "chat") {
      partition = chatPartition;
    } else if (scope === "user") {
      const id = userId ?? turn.speakerId;
      if (!Number.isSafeInteger(id)) return `Error: user_id must be an integer, got ${JSON.stringify(userId)}.`;
      if (id !== turn.speakerId && (await people.get(id)) === null) {
        return `Error: unknown user_id ${id}. Use an id from the "People in this chat" section.`;
      }
      partition = { kind: "user", id };
    } else {
      return `Error: unknown scope ${JSON.stringify(scope)}. Use "global", "chat" or "user".`;
    }
    if (typeof text !== "string") return "Error: text must be a string.";

    const entry = await memory.save({ partition, text, origin: turn.origin, by: turn.speakerId });
    touched.add(JSON.stringify(partition));
    return `Saved [${entry.id}] to ${partitionLabel(partition)}.`;
  }

  async function search({ query, user_id: userId }) {
    let partitions;
    if (userId !== undefined && userId !== null) {
      if (!Number.isSafeInteger(userId)) return `Error: user_id must be an integer, got ${JSON.stringify(userId)}.`;
      partitions = [{ kind: "user", id: userId }];
    } else {
      partitions = await visiblePartitions();
    }
    const hits = await memory.search({ query: String(query ?? ""), chatId: turn.chatId, partitions });
    if (hits.length === 0) return "No matching memories.";
    return hits
      .map(({ entry, partition }) => `[${entry.id}] (${partitionLabel(partition)}) ${entry.date} by:${entry.by} · ${entry.text}`)
      .join("\n");
  }

  // Least privilege: a member deletes what they wrote, or what is about them.
  // Nothing else, so an injected "forget everything about X" cannot wipe what
  // another member left.
  const mayForget = (entry, partition) =>
    entry.by === turn.speakerId || (partition.kind === "user" && partition.id === turn.speakerId);

  async function forget({ id }) {
    const wanted = String(id ?? "").replace(/^\[|\]$/g, "");
    // Visibility first: an entry from another private chat must read as "not found".
    for (const partition of await visiblePartitions()) {
      const entry = (await memory.readEntries(partition)).find((e) => e.id === wanted && isVisible(e, turn.chatId));
      if (!entry) continue;
      if (!mayForget(entry, partition)) return "Error: you can only forget memories you wrote or memories about you.";
      await memory.forget({ id: wanted, chatId: turn.chatId, partitions: [partition] });
      return `Forgot [${wanted}].`;
    }
    return `Error: no memory with id ${wanted} is visible from this chat.`;
  }

  async function info({ action, user_id: userId }) {
    if (action === "member" && (userId === undefined || userId === null)) return 'Error: action "member" needs user_id.';
    let result;
    try {
      if (action === "chat") result = await telegramInfo.chat();
      else if (action === "member") result = await telegramInfo.member(userId);
      else if (action === "admins") result = await telegramInfo.admins();
      else return `Error: unknown action ${JSON.stringify(action)}. Use "chat", "member" or "admins".`;
    } catch (err) {
      return `Error: Telegram said: ${err.message}`;
    }
    return truncate(JSON.stringify(result), INFO_MAX_CHARS, "Ask for a narrower action.");
  }

  const handlers = { memory_search: search, memory_save: save, memory_forget: forget, telegram_info: info };

  return {
    has: (name) => NAMES.has(name),
    async execute(name, args) {
      if (!NAMES.has(name)) return `Error: unknown tool ${name}.`;
      try {
        return await handlers[name](args ?? {});
      } catch (err) {
        // A refused save or full partition is something the model can act on;
        // any other failure is a bug and goes up to the loop.
        if (err instanceof MemoryError) return `Error: ${err.message}`;
        throw err;
      }
    },
    touched,
  };
}
