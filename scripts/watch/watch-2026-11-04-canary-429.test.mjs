// node --test scripts/watch/watch-2026-11-04-canary-429.test.mjs — watch 2026-11-04: native-monad failed 4/4 canary
// attempts on "Status: 429 | … | Details: Too Many Requests"; the 20 s retry landed inside the same burst.
import {test} from "node:test";
import assert from "node:assert/strict";
import {RATE_LIMIT_WAIT_MS, RETRY_WAIT_MS, isRateLimitNote, retryWaitMs} from "./retry-wait.mjs";

test("a rate-limited note waits 60 s before the retry", () => {
  for (const note of [
    "Status: 429 | function: getValidator(uint64 validatorId) | Details: Too Many Requests",
    "HTTP request failed. | Status: 429",
    "Details: Too Many Requests",
    "429",
    "Details: rate limit exceeded",
    "HTTP 429.",
    "Status: 429. Retry later",
    "(429)",
  ]) {
    assert.equal(isRateLimitNote(note), true, note);
    assert.equal(retryWaitMs(note), RATE_LIMIT_WAIT_MS, note);
  }
  assert.equal(RATE_LIMIT_WAIT_MS, 60_000);
});

test("other failures keep the 20 s retry", () => {
  for (const note of ["", undefined, null, "TimeoutError: The request took too long", "apr 0.429 %", "block 14290 not found", "apr 429.5 %", "v1.429.", "id 4429.", "execution reverted", "Status: 500"]) {
    assert.equal(isRateLimitNote(note), false, String(note));
    assert.equal(retryWaitMs(note), RETRY_WAIT_MS, String(note));
  }
  assert.equal(RETRY_WAIT_MS, 20_000);
});
