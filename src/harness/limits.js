// Size and count limits shared by the agent harness. Every cap lives here so
// the numbers can be tuned in one place.

// Hard cap per stored file (soul, system, memory partitions, people,
// transcripts, summaries), measured in UTF-8 bytes.
export const MAX_FILE_BYTES = 200 * 1024;

// A memory partition larger than this gets compacted.
export const MEMORY_COMPACT_BYTES = 48 * 1024;
// Growth needed before retrying a compaction that didn't shrink the file.
export const MEMORY_COMPACT_RETRY_BYTES = 8 * 1024;
// A transcript larger than this gets summarized and trimmed.
export const TRANSCRIPT_COMPACT_BYTES = 64 * 1024;

// Prompt budgets, in characters.
export const HISTORY_PROMPT_CHARS = 24_000;
export const MEMORY_PROMPT_CHARS = 3_000; // per partition in the prompt snapshot
export const SUMMARY_MAX_CHARS = 8_000;
export const TOOL_RESULT_PROMPT_CHARS = 8_000;
export const TOOL_RESULT_STORED_CHARS = 1_000;
export const KEEP_TOOL_RESULTS = 3;
export const MAX_MEMORY_ENTRY_CHARS = 500;
export const SEARCH_RESULTS = 8;
export const TELEGRAM_CHUNK_CHARS = 4_000;

// Warn when the prompt files (soul + system) together exceed this.
export const PROMPT_FILES_WARN_BYTES = 32 * 1024;

export const DEFAULT_MAX_LLM_CALLS = 5;

// A hung LLM call must not hold a chat lock forever.
export const LLM_TIMEOUT_MS = 120_000;

// Cut `text` to `max` characters and tell the model how much was dropped and
// what to do about it (`note`), so it can ask for a narrower result.
export function truncate(text, max, note) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: ${text.length - max} more chars. ${note}]`;
}
