// How long the canary waits before its one retry of a failed check (watch 2026-11-04).
// A rate-limited RPC (HTTP 429 / Too Many Requests) needs longer than a lagging one: the four
// workers share the RPC accounts, and 20 s later the same burst is often still running.

/** Wait before the retry, ms. */
export const RETRY_WAIT_MS = 20_000;
/** Wait before the retry after a rate limit, ms. */
export const RATE_LIMIT_WAIT_MS = 60_000;

/** Whether a failure note names a rate limit. A bare 429 counts, not one inside a number (0.429, 4290). */
export const isRateLimitNote = (note) => /(^|[^\d.])429(?![\d.])|too many requests|rate limit/i.test(String(note ?? ""));

/** The wait before re-running a check whose first run left `note`. */
export const retryWaitMs = (note) => (isRateLimitNote(note) ? RATE_LIMIT_WAIT_MS : RETRY_WAIT_MS);
