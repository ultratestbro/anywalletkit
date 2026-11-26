// How the canary reads one job's run: its exit, its signal and what it printed. A job fails on a non-zero exit, warns
// on a line that says something failed without failing the job, and is ok otherwise. Also what the canary keeps of a
// run for people (the note in watch/canary and Telegram) and the severity a job reports for itself.

/** A line that reports a failure the job itself did not fail on. */
export const SOFT_FAIL = /(^|\s)(→|->)\s*\w*Error\b|\bFAILED\b|\bError:|not found|revert/i;
/** Lines that match {@link SOFT_FAIL} but report an empty market or position, not a failure. */
const NOT_A_FAILURE = /no position|0 approval|none in the last|position \{ shares: 0n/;
/**
 * A job's own summary of everything that is not ok (verify:live: `Reason: NEW on 1, 10; unreachable on 143`). It leads
 * the note and is never cut to make room: the note used to be the last lines cut to 300 characters, and one NEW line of
 * the 0x canary is longer than that, so on 2026-11-25 only one of seven chains was named.
 */
export const REASON_LINE = /^Reason: \S/;
/** A job's own severity: `Severity: high | medium | low …` (verify:live: high when a sale through the Settler in force is refused today). */
const SEVERITY_LINE = /^Severity: (high|medium|low)\b/i;
const SEVERITY_RANK = {low: 1, medium: 2, high: 3};
/** Lines that name the cause of a failure (viem's Details / Status lines, an error line) rather than the stack tail. */
const CAUSE_LINE = /^(\w*Error: |(Details|Status|function): )/;
/**
 * The lines a job that prints `Reason:` summarises there, by the tag they start with (verify:live: `BAD chain …`,
 * `BAD quote … (HTTP 429)`, `??? chain … no RPC answered`, `NEW chain …`, `PIN`, `OLD`, `PREV`).
 */
const FAILING_LINE = /^(\?\?\?|(BAD|NEW|PIN|OLD|PREV)\b)/;
/** A job's own count line (`FAILED (2)`): it says nothing the Reason line does not. */
const COUNT_LINE = /^FAILED \(\d+\)$/;
/**
 * The room a note has. A note without a `Reason:` part is at most this long; with one, the Reason part is kept whole up
 * to {@link REASON_MAX} and what follows it only fills what is left of this, so a note is at most
 * `Math.max(NOTE_MAX, REASON_MAX)` (600) long.
 */
export const NOTE_MAX = 300;
/** The longest the leading `Reason:` part may grow to (it is kept whole up to this). */
export const REASON_MAX = 600;

/** The lines of a run that make it "warn". */
export const softLines = (lines) => lines.filter((l) => SOFT_FAIL.test(l) && !NOT_A_FAILURE.test(l));

/** The highest severity the run's own `Severity:` lines report, or null. */
export function severityOf(lines) {
  let best = null;
  for (const l of lines) {
    const m = SEVERITY_LINE.exec(String(l).trim());
    const s = m?.[1].toLowerCase();
    if (s && (!best || SEVERITY_RANK[s] > SEVERITY_RANK[best])) best = s;
  }
  return best;
}

/**
 * A run's status: "timeout" (killed), "none" (a market with nothing listed), "fail", "warn" or "ok", with its warning
 * lines and the severity it reports (null when it reports none).
 */
export function runStatus({code, signal, out}) {
  const lines = out.split("\n").filter(Boolean);
  const soft = softLines(lines);
  const expected = code !== 0 && /no listed Morpho (vault|market)/.test(out);
  const status = signal ? "timeout" : expected ? "none" : code !== 0 ? "fail" : soft.length ? "warn" : "ok";
  return {status, lines, soft, severity: severityOf(lines)};
}

// URLs are cut: an RPC URL carries its API key, and the note goes to Telegram and the committed state file.
const clean = (s) => String(s).replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").trim();
const cut = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/**
 * The lines that say what failed in a run that prints `Reason:` (the detail its Reason line summarises): the job's own
 * failing lines ({@link FAILING_LINE}), or, with none, its last four lines that are not a Reason / Severity / count
 * line. Trimmed, not cleaned.
 */
export function failingLines(lines) {
  const trimmed = lines.map((l) => String(l).trim()).filter(Boolean);
  const failing = trimmed.filter((l) => FAILING_LINE.test(l));
  return failing.length ? failing : trimmed.filter((l) => !REASON_LINE.test(l) && !SEVERITY_LINE.test(l) && !COUNT_LINE.test(l)).slice(-4);
}

/**
 * The note kept for a run. A failure: the job's own `Reason:` lines first and whole (up to {@link REASON_MAX}), then the
 * cause lines in what room is left of {@link NOTE_MAX} — with a Reason line and no cause line, the job's failing lines
 * ({@link failingLines}: `BAD quote … API key rejected (HTTP 401)`, a BAD chain's failing checks), with neither, the last
 * four lines. Otherwise the first warning lines.
 */
export function noteOf({status, lines, soft}) {
  if (status !== "fail") return clean(soft.slice(0, 3).join(" | ")).slice(0, NOTE_MAX);
  const trimmed = lines.map((l) => l.trim());
  const reasons = [...new Set(trimmed.filter((l) => REASON_LINE.test(l)).map(clean))];
  const cause = [...new Set(trimmed.filter((l) => CAUSE_LINE.test(l)))].slice(0, 4);
  const rest = clean((cause.length ? cause : reasons.length ? failingLines(lines) : lines.slice(-4)).join(" | "));
  if (!reasons.length) return rest.slice(0, NOTE_MAX);
  const head = cut(reasons.join(" | "), REASON_MAX);
  const room = NOTE_MAX - head.length - 3;
  return rest && room > 0 ? `${head} | ${rest.slice(0, room)}` : head;
}

/**
 * The text the canary's retry wait is chosen from (retry-wait.mjs: a rate limit waits longer): the note, and for a run
 * that prints `Reason:` every one of its failing lines as well — the note has room for the first few only, and a 429
 * on the fifth corridor must still wait out the rate limit. A run without a Reason line: the note alone, as before.
 */
export function retryTextOf(run) {
  const note = noteOf(run);
  if (run.status !== "fail" || !run.lines.some((l) => REASON_LINE.test(l.trim()))) return note;
  return [note, ...failingLines(run.lines).map(clean)].join(" | ");
}

/** A note cut to `max` for one Telegram or log line; a leading `Reason:` part stays whole (the rest becomes "…"). */
export function shortNote(note, max) {
  const s = String(note ?? "");
  if (s.length <= max) return s;
  const parts = s.split(" | ");
  let lead = 0;
  while (lead < parts.length && REASON_LINE.test(parts[lead])) lead++;
  if (!lead) return s.slice(0, max);
  const head = parts.slice(0, lead).join(" | ");
  return lead < parts.length ? `${head} | …` : head;
}

/**
 * `RPC_<chainId>` for every chain whose RPC variable (`names`: chain id → env name) is set: the override a verify-live
 * that reads `RPC_<chainId>=url[,url]` takes (0x). Ours comes first; the chain's public endpoint (`fallbacks`: chain id →
 * URL) follows as the retry, so a run on a day our RPC is out of credits or rate-limited still reads the chain (the 0x
 * job ran on public endpoints alone before 2026-11-26). A chain whose variable is unset is left to the script's own
 * public endpoint. The values go only into the child's environment, never into a note or a log line.
 */
export function rpcOverrides(env, names, fallbacks = {}) {
  return Object.fromEntries(Object.entries(names).filter(([, name]) => typeof env[name] === "string" && env[name] !== "").map(([id, name]) => {
    const ours = env[name];
    const fallback = fallbacks[id];
    return [`RPC_${id}`, typeof fallback === "string" && fallback !== "" && fallback !== ours ? `${ours},${fallback}` : ours];
  }));
}
