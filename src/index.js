import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { TOOLS, dispatch } from "./tools/index.js";
import { logger } from "./logger.js";
import { withSpan } from "./tracing.js";
import { createStore } from "./harness/store.js";
import { createMemory } from "./harness/memory.js";
import { createPeople } from "./harness/people.js";
import { createTranscript } from "./harness/transcript.js";
import { createChatCompletion } from "./harness/llm.js";
import { loadPromptFiles } from "./harness/prompt.js";
import { createAgent } from "./harness/turn.js";
import { createTelegramIO } from "./harness/telegramIO.js";
import { turnInputFromMessage } from "./harness/identity.js";

// The agent's identity and rules live in files the owner edits. If they are
// missing or too big, stop here: a bot with no prompt would answer as nobody.
let prompts;
try {
  prompts = await loadPromptFiles(config.agent.promptDir, { log: logger });
} catch (err) {
  logger.fatal({ err, promptDir: config.agent.promptDir }, "cannot load the agent prompt files");
  process.exit(1);
}

const store = createStore({ root: config.agent.dataDir, log: logger });
const agent = createAgent({
  store,
  memory: createMemory({ store, log: logger }),
  people: createPeople({ store }),
  transcript: createTranscript({ store, log: logger }),
  complete: createChatCompletion(config.llm),
  mediaTools: TOOLS,
  prompts,
  timezone: config.agent.timezone,
  maxLlmCalls: config.agent.maxLlmCalls,
  log: logger,
});

// Telegraf aborts handlers after 90s by default, and that timeout rejects
// outside our try/catch — an unhandled rejection that crashes the process.
// Downloads regularly exceed 90s, so give handlers 10 minutes.
const bot = new Telegraf(config.telegram.botToken, { handlerTimeout: 10 * 60 * 1000 });

// Whitelist check before anything else — silently ignore strangers. Access is
// gated by context, not by user alone:
//   - private chat: allowed only if the sender is in allowedUserIds
//   - group chat:   allowed only if the group is in allowedChatIds (any member
//                   may use it, but only inside that group)
// This means a whitelisted user can't drag the bot into some other random
// group and use it there.
bot.use((ctx, next) => {
  const isPrivate = ctx.chat?.type === "private";
  const allowed = isPrivate
    ? ctx.from && config.telegram.allowedUserIds.includes(ctx.from.id)
    : config.telegram.allowedChatIds.includes(ctx.chat?.id);
  if (!allowed) {
    logger.warn(
      { userId: ctx.from?.id, chatId: ctx.chat?.id, chatType: ctx.chat?.type },
      "ignored message from unauthorized chat/user"
    );
    return;
  }
  return next();
});

bot.command("start", (ctx) =>
  ctx.reply(
    "Hi! I can download videos/audio, add songs to Spotify, search images, or just chat. Send me a link or a request."
  )
);

// Clears this chat's transcript and summary. Long-term memory stays.
bot.command("reset", async (ctx) => {
  try {
    await agent.reset(ctx.chat.id);
    await ctx.reply("Conversation history cleared.");
  } catch (err) {
    logger.error({ err, chatId: ctx.chat.id }, "reset failed");
    await replyQuietly(ctx, "Sorry, I couldn't clear the history. 😕", logger);
  }
});

// The bot only reacts when a message opens with a trigger word. Returns the
// message stripped of the prefix, or null if the bot should stay silent.
function matchTrigger(text) {
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  for (const prefix of config.telegram.triggerPrefixes) {
    if (!lower.startsWith(prefix)) continue;
    // Require the prefix to be a whole word: end of message, or followed by
    // a space or punctuation ("bot", "bot,", "bot: hi") — not "botanist".
    const after = trimmed.slice(prefix.length);
    if (after === "" || /^[\s,.:!?]/.test(after)) {
      return after.replace(/^[\s,.:!?]+/, "").trimStart();
    }
  }
  return null;
}

// The error message is a courtesy: if it can't be sent, log and move on.
async function replyQuietly(ctx, text, log) {
  try {
    await ctx.reply(text);
  } catch (err) {
    log.warn({ err }, "could not send the error message");
  }
}

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;

  // A message is directed at the bot when it opens with a trigger word or
  // replies to one of the bot's own messages. Everything else is ignored, so
  // the bot stays quiet in a busy friend group and stores nothing about it.
  let userText = matchTrigger(ctx.message.text);
  if (userText === null && ctx.message.reply_to_message?.from?.id === ctx.botInfo.id) {
    userText = ctx.message.text;
  }
  if (userText === null) return;

  // Root span for the whole update — child spans (LLM call, tool dispatch,
  // outbound http) nest under it, and the trace id lands on every log line.
  await withSpan(
    "telegram.message",
    { "chat.id": chatId, "chat.type": ctx.chat.type, "user.id": ctx.from.id },
    async () => {
      const log = logger.child({ chatId, userId: ctx.from.id });
      log.info({ len: userText.length }, "handling message");

      try {
        const input = turnInputFromMessage(ctx.message, { botId: ctx.botInfo.id, text: userText });
        await agent.handleTurn(input, createTelegramIO({ ctx, dispatch, log }));
      } catch (err) {
        log.error({ err }, "handler failed");
        await replyQuietly(ctx, "Sorry, something went wrong with that request. 😕", log);
      }
    }
  );
});

bot.launch(() => {
  logger.info(
    { username: bot.botInfo?.username, model: config.llm.model, llmBaseUrl: config.llm.baseUrl },
    "bot started"
  );
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
