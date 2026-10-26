// Bounded tool-calling loop: at most `maxCalls` LLM calls per directed message,
// and the last one goes out without tools so it has to answer in text.

import { DEFAULT_MAX_LLM_CALLS, TOOL_RESULT_PROMPT_CHARS, truncate } from "./limits.js";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const RESULT_NOTE = "Ask for a narrower query if you need the rest.";

const LENGTH_ERROR =
  "Error: your reply hit the length limit, so this tool call was not run. Retry with shorter arguments.";

// Models send arguments as a JSON string (OpenAI) or as an object (some Ollama
// versions). Either way the tool gets a plain object or a readable error.
export function parseToolArguments(raw) {
  if (raw === null || raw === undefined) return { ok: true, args: {} };
  if (typeof raw === "string") {
    if (raw.trim() === "") return { ok: true, args: {} };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (!isPlainObject(parsed)) return { ok: false, error: "expected a JSON object" };
    return { ok: true, args: parsed };
  }
  if (isPlainObject(raw)) return { ok: true, args: raw };
  return { ok: false, error: "expected a JSON object" };
}

// Small models often send "123" for an integer or 5 for a string. Fix the
// common mismatches against the tool's schema; leave everything else alone.
export function coerceArguments(args, parameters) {
  const props = parameters?.properties;
  if (!isPlainObject(args) || !isPlainObject(props)) return args;
  const out = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const type = props[key]?.type;
    if ((type === "integer" || type === "number") && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      out[key] = Number(value);
    } else if (type === "string" && typeof value === "number") {
      out[key] = String(value);
    } else if (type === "boolean" && (value === "true" || value === "false")) {
      out[key] = value === "true";
    }
  }
  return out;
}

const argumentsAsString = (raw) => {
  if (typeof raw === "string") return raw;
  if (raw === null || raw === undefined) return "";
  return JSON.stringify(raw);
};

export async function runLoop({ messages, tools, complete, executeTool, maxCalls = DEFAULT_MAX_LLM_CALLS }) {
  const convo = [...messages];
  const added = [];
  const toolCalls = [];
  const schemas = new Map((tools ?? []).map((t) => [t.function.name, t.function.parameters]));
  let calls = 0;
  let text = "";

  while (calls < maxCalls) {
    calls += 1;
    const isLast = calls === maxCalls;
    const opts = isLast || !tools?.length ? {} : { tools };
    const { message, finishReason } = await complete(convo, opts);
    const content = typeof message.content === "string" ? message.content : "";
    // The last call has no tools to offer, so tool_calls it still carries are ignored.
    const requested = !isLast && Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (requested.length === 0) {
      added.push({ role: "assistant", content });
      text = content;
      break;
    }

    const assistant = {
      role: "assistant",
      content,
      tool_calls: requested.map((c, index) => ({
        id: c.id || `call_${calls}_${index}`,
        type: "function",
        function: { name: c.function?.name ?? "", arguments: argumentsAsString(c.function?.arguments) },
      })),
    };
    convo.push(assistant);
    added.push(assistant);

    for (const call of assistant.tool_calls) {
      const { name } = call.function;
      let result;
      let ran = null; // args of a call that reached executeTool
      if (finishReason === "length") {
        // The arguments are probably cut mid-JSON; running them would be a guess.
        result = LENGTH_ERROR;
      } else {
        const parsed = parseToolArguments(call.function.arguments);
        if (!parsed.ok) {
          result = `Error: arguments were not valid JSON (${parsed.error}). Send a JSON object.`;
        } else {
          ran = coerceArguments(parsed.args, schemas.get(name));
          try {
            result = await executeTool(name, ran);
          } catch (err) {
            result = `Error: ${err.message}`;
          }
        }
      }
      const output = truncate(typeof result === "string" ? result : String(result ?? ""), TOOL_RESULT_PROMPT_CHARS, RESULT_NOTE);
      // Only calls that reached executeTool are reported, so callers can tell
      // "the model tried a tool" from "the call never ran".
      if (ran) toolCalls.push({ id: call.id, name, args: ran, result: output });
      const toolMessage = { role: "tool", tool_call_id: call.id, content: output };
      convo.push(toolMessage);
      added.push(toolMessage);
    }
  }

  return { text, added, calls, toolCalls };
}
