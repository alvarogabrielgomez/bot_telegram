// Who is speaking. Telegram names are free text a user controls, so the id is
// the identity and every name is sanitized before it reaches a prompt. The
// ⟦ ⟧ brackets are reserved for labels the harness writes itself; they are
// stripped from anything a user typed.

const NAME_MAX = 64;
const REPLY_TEXT_MAX = 200;
const TITLE_MAX = 128;

export function sanitizeUserText(text) {
  return String(text ?? "").replaceAll("⟦", "[").replaceAll("⟧", "]");
}

// One-line, label-safe text: no brackets, no control characters, single spaces.
const clean = (value) =>
  sanitizeUserText(value)
    .replace(/\p{Cc}/gu, (c) => (/\s/.test(c) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();

// Cut by code points so an emoji is never split in half.
const cap = (text, max) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("").trimEnd();
};

export function personFromUser(user) {
  const firstName = cap(clean(user.first_name), NAME_MAX);
  const lastName = cap(clean(user.last_name), NAME_MAX) || null;
  const displayName = cap(clean(`${user.first_name ?? ""} ${user.last_name ?? ""}`), NAME_MAX) || `user ${user.id}`;
  // Telegram usernames are [A-Za-z0-9_]; anything else is not a real username.
  const username = typeof user.username === "string" && /^\w{1,64}$/.test(user.username) ? user.username : null;
  return { id: user.id, firstName, lastName, username, displayName };
}

// Quoted text is context for the model, not something to store or trust: cut it short.
const quoteText = (message) => {
  const raw = message.text ?? message.caption;
  if (typeof raw !== "string") return null;
  return cap(sanitizeUserText(raw), REPLY_TEXT_MAX) || null;
};

export function turnInputFromMessage(message, { botId, text }) {
  if (!message.from) throw new Error("message has no sender");

  const reply = message.reply_to_message;
  let replyTo = null;
  if (reply) {
    const isBot = reply.from?.id === botId;
    replyTo = {
      isBot,
      // The bot's own messages are labelled "you"; nobody else needs a Person for them.
      user: reply.from && !isBot ? personFromUser(reply.from) : null,
      text: quoteText(reply),
    };
  }

  const mentioned = [];
  for (const entity of [...(message.entities ?? []), ...(message.caption_entities ?? [])]) {
    if (entity.type !== "text_mention" || !entity.user) continue;
    if (mentioned.some((p) => p.id === entity.user.id)) continue;
    mentioned.push(personFromUser(entity.user));
  }

  return {
    chat: {
      id: message.chat.id,
      type: message.chat.type,
      title: message.chat.title ? cap(clean(message.chat.title), TITLE_MAX) : null,
    },
    speaker: personFromUser(message.from),
    replyTo,
    mentioned,
    text: sanitizeUserText(text),
    messageId: message.message_id,
    date: new Date(message.date * 1000),
  };
}

const formatters = new Map();

// "YYYY-MM-DD HH:mm" in `timezone`. The sv-SE locale prints that shape natively.
export function formatTime(date, timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  return formatter.format(date);
}

export function personLabel(p) {
  return `${p.displayName}${p.username ? ` · @${p.username}` : ""} · id ${p.id}`;
}

// The line the harness writes above every user message. The model reads the id
// in it as the speaker; the user cannot forge it because ⟦ is stripped from text.
export function speakerLabel({ from, replyTo, date, timezone }) {
  let label = `⟦from: ${personLabel(from)} · ${formatTime(date, timezone)}⟧`;
  if (replyTo) {
    const quote = replyTo.text ? `: «${replyTo.text}»` : "";
    if (replyTo.isBot) label += `\n⟦replying to: you (the bot)${quote}⟧`;
    else if (replyTo.user) label += `\n⟦replying to: ${personLabel(replyTo.user)}${quote}⟧`;
  }
  return label;
}
