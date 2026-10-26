// test/toolGuards.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMediaUrl } from "../src/harness/toolGuards.js";

test("public http(s) links pass", () => {
  assert.deepEqual(checkMediaUrl("https://youtu.be/abc"), { ok: true, url: "https://youtu.be/abc" });
});

test("internal, loopback and non-http targets are refused", () => {
  for (const url of ["file:///etc/passwd", "http://127.0.0.1:8000/admin", "http://localhost/x", "http://10.0.0.5/",
    "http://192.168.1.10/", "http://169.254.169.254/latest", "http://[::1]/", "http://ytdlp-backend.internal:8000", "javascript:alert(1)", "no es un link"]) {
    assert.equal(checkMediaUrl(url).ok, false, url);
  }
});
