import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pino-like logger whose methods do nothing, for tests that don't assert on logs.
export const silentLog = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
};

// Fresh empty directory per call, so tests never share on-disk state.
export function tmpDir() {
  return mkdtemp(join(tmpdir(), "harness-test-"));
}
