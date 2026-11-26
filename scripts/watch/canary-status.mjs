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
/** The longest note the canary stores. */
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
 * The note kept for a run. A failure: the job's own `Reason:` lines first and whole (up to {@link REASON_MAX}), then the
 * cause lines (or, with neither, the last four lines) in what room is left of {@link NOTE_MAX}. Otherwise the first
 * warning lines.
 */
export function noteOf({status, lines, soft}) {
  if (status !== "fail") return clean(soft.slice(0, 3).join(" | ")).slice(0, NOTE_MAX);
  const trimmed = lines.map((l) => l.trim());
  const reasons = [...new Set(trimmed.filter((l) => REASON_LINE.test(l)).map(clean))];
  const cause = [...new Set(trimmed.filter((l) => CAUSE_LINE.test(l)))].slice(0, 4);
  const rest = clean((cause.length ? cause : reasons.length ? [] : lines.slice(-4)).join(" | "));
  if (!reasons.length) return rest.slice(0, NOTE_MAX);
  const head = cut(reasons.join(" | "), REASON_MAX);
  const room = NOTE_MAX - head.length - 3;
  return rest && room > 0 ? `${head} | ${rest.slice(0, room)}` : head;
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
 * that reads `RPC_<chainId>` takes (0x). A chain whose variable is unset is left to the script's own public endpoint.
 * The values go only into the child's environment, never into a note or a log line.
 */
export function rpcOverrides(env, names) {
  return Object.fromEntries(Object.entries(names).filter(([, name]) => typeof env[name] === "string" && env[name] !== "").map(([id, name]) => [`RPC_${id}`, env[name]]));
}
