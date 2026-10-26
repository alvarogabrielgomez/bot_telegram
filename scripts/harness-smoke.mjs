// Harness smoke: drives the real agent with a scripted LLM and a fake Telegram IO.
// Run from the repo root: node scripts/harness-smoke.mjs
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const R = new URL("../src/harness/", import.meta.url).href;
const { createStore, FileCapError } = await import(R + "store.js");
const { createMemory } = await import(R + "memory.js");
const { createPeople } = await import(R + "people.js");
const { createTranscript } = await import(R + "transcript.js");
const { createAgent } = await import(R + "turn.js");
const { loadPromptFiles } = await import(R + "prompt.js");
const { turnInputFromMessage } = await import(R + "identity.js");

const warns = [];
const log = { trace() {}, debug() {}, info() {}, error() {}, fatal() {}, warn: (o, m) => warns.push(m), child() { return log; } };
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`); };

const DOWNLOAD_VIDEO = { type: "function", function: { name: "download_video", description: "d", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } };
const ALVARO = { id: 123, is_bot: false, first_name: "Alvaro" };
const HUMBERTO = { id: 456, is_bot: false, first_name: "Humberto" };
const CARLA = { id: 789, is_bot: false, first_name: "Carla" };
const NEWBIE = { id: 555, is_bot: false, first_name: "Nuevo" };
const GROUP = { id: -1001, type: "supergroup", title: "Amigos" };
const DM = { id: 123, type: "private" };
const prompts = await loadPromptFiles("agent", { log });

// Memory and the summary live in a marked context message, not in the system prompt.
// Inside it spaces are datamarked: "busca trabajo" reads "buscaˆtrabajo".
const contextOf = (messages) => messages.find((m) => m.role === "user" && m.content.startsWith("⟦harness context"))?.content ?? "";

const tc = (id, name, args) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
function makeComplete() {
  const queue = [];
  const calls = [];
  const complete = async (messages, opts) => {
    calls.push({ messages: structuredClone(messages), opts });
    const step = queue.shift();
    if (!step) throw new Error("script exhausted (unexpected LLM call)");
    const s = typeof step === "function" ? await step(messages, opts) : step;
    return { message: { role: "assistant", content: s.content ?? "", tool_calls: s.tool_calls }, finishReason: s.finishReason ?? (s.tool_calls ? "tool_calls" : "stop") };
  };
  return { complete, queue, calls };
}
function fakeIO() {
  const io = { sent: [], delivered: [], isMemberCalls: [] };
  io.deliverTool = async (name, args) => { io.delivered.push({ name, args }); return `Delivered to the user: ${name} ok`; };
  io.send = async (chunk) => { io.sent.push(chunk); };
  io.isMember = async (id) => { io.isMemberCalls.push(id); return true; };
  io.telegramInfo = { chat: async () => ({}), member: async () => ({}), admins: async () => [] };
  return io;
}
let msgId = 1;
const msg = (from, text, chat, reply) =>
  turnInputFromMessage({ message_id: msgId++, from, chat, date: 1793000000 + msgId, text, ...(reply ? { reply_to_message: reply } : {}) }, { botId: 999, text });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "final-smoke-"));
  const store = createStore({ root: dir, log });
  const memory = createMemory({ store, log });
  const people = createPeople({ store });
  const transcript = createTranscript({ store, log });
  const fake = makeComplete();
  const agent = createAgent({ store, memory, people, transcript, complete: fake.complete, mediaTools: [DOWNLOAD_VIDEO], prompts, timezone: "UTC", maxLlmCalls: 5, log });
  return { dir, store, memory, people, transcript, fake, agent };
}
const dirs = [];

// ---------- 1. Group acceptance ----------
{
  const s = await setup(); dirs.push(s.dir);
  s.fake.queue.push({ content: "Hola Alvaro" });
  await s.agent.handleTurn(msg(ALVARO, "hola, soy Alvaro", GROUP), fakeIO());
  s.fake.queue.push({ content: "Antes habló Alvaro" });
  await s.agent.handleTurn(msg(HUMBERTO, "¿quién habló antes?", GROUP), fakeIO());
  const second = s.fake.calls[1].messages;
  check("G1 system prompt: Speaker is Humberto with id", /- Speaker: Humberto · id 456/.test(second[0].content));
  check("G1 people list includes Alvaro with id", /- Alvaro · id 123/.test(second[0].content));
  check("G1 history carries Alvaro's labelled turn", second.some((m) => m.role === "user" && m.content.startsWith("⟦from: Alvaro · id 123")));
  check("G1 history carries the bot's answer to Alvaro", second.some((m) => m.role === "assistant" && m.content === "Hola Alvaro"));
  check("G1 current message labelled Humberto", second.at(-1).content.startsWith("⟦from: Humberto · id 456"));

  s.fake.queue.push({ content: "[[mention:456]], Alvaro dice que llega tarde" });
  const io = fakeIO();
  await s.agent.handleTurn(msg(ALVARO, "dile a Humberto que llego tarde", GROUP), io);
  const e = io.sent[0]?.entities ?? [];
  check("G2 'dile a Humberto' sends text_mention of 456 at 0/8", e.length === 1 && e[0].type === "text_mention" && e[0].offset === 0 && e[0].length === 8 && e[0].user.id === 456, JSON.stringify(io.sent[0]));
  check("G2 membership checked for 456", io.isMemberCalls.join() === "456");

  // Quoted foreign message: model sees it during the turn, nothing persists about Carla.
  s.fake.queue.push({ content: "ok" });
  await s.agent.handleTurn(msg(ALVARO, "qué opinas de esto", GROUP, { message_id: 9000, from: CARLA, chat: GROUP, date: 1, text: "secreto de Carla" }), fakeIO());
  const lastCall = s.fake.calls.at(-1).messages;
  check("Q1 model sees the quote during the turn", lastCall.at(-1).content.includes('"secreto de Carla"'));
  const peopleJson = JSON.parse(await readFile(join(s.dir, "people.json"), "utf8"));
  check("Q1 people.json has only speakers (123,456), not quoted Carla", Object.keys(peopleJson).sort().join() === "123,456", Object.keys(peopleJson).join());
  const raw = await readFile(join(s.dir, "chats", "-1001", "transcript.jsonl"), "utf8");
  check("Q1 quoted text not persisted in transcript", !raw.includes("secreto de Carla"));

  // ---------- 2. DM: third person not mentioned ----------
  s.fake.queue.push({ content: "[[mention:456]] no está aquí" });
  const dmio = fakeIO();
  await s.agent.handleTurn(msg(ALVARO, "dile a Humberto algo", DM), dmio);
  check("D1 DM: no text_mention entity", (dmio.sent[0]?.entities ?? []).length === 0);
  check("D1 DM: isMember not called", dmio.isMemberCalls.length === 0);
  console.log(`     D1 DM rendered text: ${JSON.stringify(dmio.sent[0]?.text)}`);
  check("D1 DM: third person rendered as plain name 'Humberto no está aquí'", dmio.sent[0]?.text === "Humberto no está aquí");

  // ---------- 3. Privacy ----------
  s.fake.queue.push({ tool_calls: [tc("p1", "memory_save", { scope: "user", text: "Alvaro busca trabajo" })] }, { content: "Anotado" });
  const pio = fakeIO();
  await s.agent.handleTurn(msg(ALVARO, "recuerda que busco trabajo", DM), pio);
  const saved = await s.memory.readEntries({ kind: "user", id: 123 });
  check("P0 DM save landed with private origin", saved.length === 1 && saved[0].origin.kind === "private" && saved[0].origin.chatId === 123);
  const savedId = saved[0]?.id;
  const callsBefore = s.fake.calls.length;
  s.fake.queue.push(
    { tool_calls: [tc("s1", "memory_search", { query: "trabajo" }), tc("s2", "memory_search", { query: "trabajo", user_id: "123" }), tc("s3", "memory_forget", { id: savedId })] },
    { content: "No sé nada de eso" },
  );
  await s.agent.handleTurn(msg(HUMBERTO, "¿qué sabes de Alvaro y su trabajo?", GROUP), fakeIO());
  const groupSys = s.fake.calls[callsBefore].messages[0].content;
  const groupCtx = contextOf(s.fake.calls[callsBefore].messages);
  check("P1 group system prompt and context message do not contain the private fact", groupCtx !== "" && ![groupSys, groupCtx].some((c) => c.includes("busca trabajo") || c.includes("buscaˆtrabajo")));
  const toolMsgs = s.fake.calls[callsBefore + 1].messages.filter((m) => m.role === "tool");
  check("P2 memory_search (all) in group finds nothing", /Noˆmatchingˆmemories[.]/.test(toolMsgs[0]?.content ?? ""), toolMsgs[0]?.content);
  check("P3 memory_search user_id=123 in group finds nothing", /Noˆmatchingˆmemories[.]/.test(toolMsgs[1]?.content ?? ""), toolMsgs[1]?.content);
  check("P4 memory_forget of private id from group refused", /^Error: no memory/.test(toolMsgs[2]?.content ?? ""), toolMsgs[2]?.content);
  check("P5 private entry still on disk", (await s.memory.readEntries({ kind: "user", id: 123 })).length === 1);
  s.fake.queue.push({ content: "Sí, buscas trabajo" });
  await s.agent.handleTurn(msg(ALVARO, "qué recuerdas de mí", DM), fakeIO());
  check("P6 positive control: DM context message does show the private fact", contextOf(s.fake.calls.at(-1).messages).includes("buscaˆtrabajo"));
}

// ---------- 4. URL fallback ----------
{
  const s = await setup(); dirs.push(s.dir);
  s.fake.queue.push({ tool_calls: [tc("m1", "memory_search", { query: "video" })] }, { content: "Qué buen video" });
  const io = fakeIO();
  const input = msg(ALVARO, "mira https://youtu.be/abc", GROUP);
  await s.agent.handleTurn(input, io);
  check("U1 memory-only tools + text -> forced download_video once", io.delivered.length === 1 && io.delivered[0].name === "download_video" && io.delivered[0].args.url === "https://youtu.be/abc", JSON.stringify(io.delivered));
  check("U1 model text discarded (nothing sent)", io.sent.length === 0, JSON.stringify(io.sent));
  const { entries } = await s.transcript.load(GROUP.id);
  const a = entries.find((x) => x.type === "assistant" && x.toolCalls?.[0]?.id === `call_url_${input.messageId}`);
  const t = entries.find((x) => x.type === "tool" && x.toolCallId === `call_url_${input.messageId}`);
  check("U1 transcript has call_url pair", Boolean(a && t));

  s.fake.queue.push({ tool_calls: [tc("v1", "download_video", { url: "https://youtu.be/xyz" })] }, { content: "Listo" });
  const io2 = fakeIO();
  await s.agent.handleTurn(msg(ALVARO, "baja https://youtu.be/xyz", GROUP), io2);
  check("U2 model called download_video itself -> exactly one delivery", io2.delivered.length === 1, JSON.stringify(io2.delivered));
}

// ---------- 5. Loop cap, bad JSON, unknown tool, length cut ----------
{
  const s = await setup(); dirs.push(s.dir);
  s.fake.queue.push(
    { tool_calls: [tc("a1", "respond", {}), tc("a2", "download_video", '{"url":')] },
    { tool_calls: [tc("b1", "download_video", { url: "https://x.y" })], finishReason: "length" },
    { tool_calls: [tc("c1", "memory_search", { query: 5 })] },
    { tool_calls: [{ type: "function", function: { name: "memory_search", arguments: { query: "x" } } }] },
    { content: "final", tool_calls: [tc("e1", "download_video", { url: "https://z" })] },
  );
  const io = fakeIO();
  await s.agent.handleTurn(msg(ALVARO, "haz cosas", GROUP), io);
  const calls = s.fake.calls;
  check("L1 exactly 5 LLM calls", calls.length === 5, String(calls.length));
  check("L2 calls 1-4 offer tools, call 5 has none", calls.slice(0, 4).every((c) => c.opts?.tools?.length) && calls[4].opts?.tools === undefined);
  const last = calls[4].messages;
  const asked = last.filter((m) => m.role === "assistant" && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
  const answered = new Set(last.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  check("L3 every tool_call_id answered", asked.length === 5 && asked.every((id) => answered.has(id)), JSON.stringify(asked));
  const content = (id) => last.find((m) => m.role === "tool" && m.tool_call_id === id)?.content ?? "";
  check("L4 unknown tool -> readable error", /^Error: unknown tool respond\. Available tools: download_video, memory_search/.test(content("a1")), content("a1"));
  check("L5 bad JSON -> readable error", /^Error: arguments were not valid JSON/.test(content("a2")), content("a2"));
  check("L6 length-cut tool call not run", /length limit/.test(content("b1")) && io.delivered.length === 0);
  check("L7 last-call tool_calls ignored, text sent", io.sent.length === 1 && io.sent[0].text === "final" && io.delivered.length === 0);
}

// ---------- 6. Serialization in one chat ----------
{
  const s = await setup(); dirs.push(s.dir);
  let inFlight = 0, maxInFlight = 0;
  const slow = (mk) => async (messages) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 40)); inFlight--; return mk(messages); };
  const userTag = (messages) => [...messages].reverse().find((m) => m.role === "user").content.split("\n").at(-1);
  for (let i = 0; i < 2; i++) {
    s.fake.queue.push(slow((m) => ({ tool_calls: [tc(`t_${userTag(m)}`, "memory_search", { query: userTag(m) })] })));
    s.fake.queue.push(slow((m) => ({ content: `done ${userTag(m)}` })));
  }
  await Promise.all([s.agent.handleTurn(msg(ALVARO, "uno", GROUP), fakeIO()), s.agent.handleTurn(msg(HUMBERTO, "dos", GROUP), fakeIO())]);
  check("S1 never two LLM calls in flight for one chat", maxInFlight === 1, String(maxInFlight));
  const { entries } = await s.transcript.load(GROUP.id);
  const shape = entries.map((e) => (e.type === "user" ? `U:${e.text}` : e.type === "tool" ? `T:${e.toolCallId}` : e.toolCalls ? `A:${e.toolCalls[0].id}` : `A:${e.text}`)).join(" | ");
  check("S2 transcript turns not interleaved", shape === "U:uno | A:t_uno | T:t_uno | A:done uno | U:dos | A:t_dos | T:t_dos | A:done dos", shape);
}

// ---------- 7. people.json full + 200 KB cap ----------
{
  const s = await setup(); dirs.push(s.dir);
  const big = { 1: { id: 1, displayName: "x", chats: {}, pad: "" } };
  const target = 200 * 1024 - 60;
  big[1].pad = "y".repeat(target - JSON.stringify(big, null, 2).length);
  await writeFile(join(s.dir, "people.json"), JSON.stringify(big, null, 2));
  s.fake.queue.push({ content: "hola nuevo" });
  const io = fakeIO();
  await s.agent.handleTurn(msg(NEWBIE, "hola", GROUP), io);
  check("F1 people.json full: turn still replies", io.sent[0]?.text === "hola nuevo");
  check("F1 FileCapError logged as warn", warns.some((w) => /people\.json is full/.test(w)));
  let capErr = null;
  try { await s.store.writeText("memory/memory.md", "z".repeat(200 * 1024 + 1)); } catch (err) { capErr = err; }
  check("F2 store refuses a 204801-byte write", capErr instanceof FileCapError);
}

// ---------- M. send_message: several separate messages in one turn ----------
{
  const s = await setup(); dirs.push(s.dir);
  const six = [1, 2, 3, 4, 5, 6].map((n) => tc(`m${n}`, "send_message", { text: String(n) }));
  s.fake.queue.push({ tool_calls: six }, { content: "" });
  const io = fakeIO();
  await s.agent.handleTurn(msg(ALVARO, "manda 5 mensajes separados", GROUP), io);
  check("M1 five separate messages sent, in order", io.sent.map((c) => c.text).join(",") === "1,2,3,4,5", io.sent.map((c) => c.text).join(","));
  const results = s.fake.calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content);
  check("M1 sixth message refused with a readable error", /already sent 5 messages/.test(results[5] ?? ""), results[5]);
  check("M1 empty final reply after send_message is not an error", s.fake.calls.length === 2);

  s.fake.queue.push({ tool_calls: [tc("d1", "send_message", { text: "Sí, estoy aquí." })] }, { content: "Sí, estoy  aquí." });
  const io2 = fakeIO();
  await s.agent.handleTurn(msg(ALVARO, "estás?", GROUP), io2);
  check("M2 final reply repeating a sent message goes out once", io2.sent.length === 1, io2.sent.map((c) => c.text).join(" | "));
}

for (const d of dirs) await rm(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
