// What a watch.json source may declare beyond its type's own fields, checked the same way by watch.mjs (a bad value fails
// the run) and by the CI test over every real manifest (watch-2026-11-26-severity.test.mjs), so the two cannot drift: a
// typo in one module's manifest is caught at PR time, not by the 06:15 cron, where it would stop every module's watch.

/**
 * A source's optional `severity`: how much a change of it matters to the module (the 0x Settler in force: a new
 * deployment refuses native-coin sales from that day). Carried into the diff entry, the digest and Telegram so triage
 * does not have to infer it.
 */
export const SEVERITIES = Object.freeze(["high", "medium", "low"]);

/** Why `source`'s `severity` is refused (`file` names the manifest), or null when it has none or one of {@link SEVERITIES}. */
export function severityError(file, source) {
  const s = source?.severity;
  if (s === undefined || SEVERITIES.includes(s)) return null;
  return `${file}: source "${source.id}" has severity ${String(JSON.stringify(s)).slice(0, 40)} (one of ${SEVERITIES.join(", ")}, or none)`;
}
