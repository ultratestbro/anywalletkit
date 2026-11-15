// How the canary reads one job's run: its exit, its signal and what it printed. A job fails on a non-zero exit, warns
// on a line that says something failed without failing the job, and is ok otherwise.

/** A line that reports a failure the job itself did not fail on. */
export const SOFT_FAIL = /(^|\s)(→|->)\s*\w*Error\b|\bFAILED\b|\bError:|not found|revert/i;
/** Lines that match {@link SOFT_FAIL} but report an empty market or position, not a failure. */
const NOT_A_FAILURE = /no position|0 approval|none in the last|position \{ shares: 0n/;

/** The lines of a run that make it "warn". */
export const softLines = (lines) => lines.filter((l) => SOFT_FAIL.test(l) && !NOT_A_FAILURE.test(l));

/** A run's status: "timeout" (killed), "none" (a market with nothing listed), "fail", "warn" or "ok", with its warning lines. */
export function runStatus({code, signal, out}) {
  const lines = out.split("\n").filter(Boolean);
  const soft = softLines(lines);
  const expected = code !== 0 && /no listed Morpho (vault|market)/.test(out);
  const status = signal ? "timeout" : expected ? "none" : code !== 0 ? "fail" : soft.length ? "warn" : "ok";
  return {status, lines, soft};
}
