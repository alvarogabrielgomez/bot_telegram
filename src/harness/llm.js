// OpenAI-compatible chat-completions client. Returns the raw message plus the
// finish reason, so callers can tell a finished reply from one cut by the
// length limit.

import { withSpan } from "../tracing.js";

export function createChatCompletion({ baseUrl, model, apiKey, fetchImpl = fetch }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return (messages, { tools } = {}) =>
    withSpan("llm.call", { "llm.model": model, "llm.tools": Boolean(tools) }, async () => {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, ...(tools ? { tools } : {}) }),
      });
      const bodyText = await res.text();
      if (!res.ok) throw new Error(`LLM API error: ${res.status} ${bodyText}`);

      let data;
      try {
        data = JSON.parse(bodyText);
      } catch (err) {
        throw new Error(`LLM returned no message: body is not JSON (${err.message}): ${bodyText.slice(0, 500)}`);
      }
      const choice = data?.choices?.[0];
      if (!choice?.message) {
        throw new Error(`LLM returned no message: ${bodyText.slice(0, 500)}`);
      }
      return { message: choice.message, finishReason: choice.finish_reason ?? "unknown" };
    });
}
