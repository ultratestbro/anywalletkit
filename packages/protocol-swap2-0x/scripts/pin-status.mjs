// How one chain's live registry reading compares with its pins in src/chains.ts — the verdict verify:live prints (and
// the canary fails on). Pure: no network. `current` / `previous` are the deployment nonces the registry names now
// (ownerOf(2) / prev(2); null when it names none, or nothing this module can tell is a Settler).
//
//   ok    the registry names exactly the pinned current and previous deployments (or no previous).
//   NEW   0x deployed a Settler past the pinned newest. Native-coin sales to it are refused; token sales still go to it
//         inside the margin. Check the deployment, then raise newestLiveNonce / previousLiveNonce.
//   PIN   past the margin too: every sale through it is refused until the pins are raised.
//   OLD   the registry rolled back below the pinned newest (refused outright below the pinned previous).
//   PREV  the current Settler is the pinned one, but the previous one is not the pinned previous.
//   BAD   the registry names no Settler this module can tell.

/**
 * @param {{id: number | string, chain: {newestLiveNonce: number, previousLiveNonce: number}, current: number | null, previous: number | null, margin: number}} reading
 * @returns {{tag: "ok" | "NEW" | "PIN" | "OLD" | "PREV" | "BAD", native: boolean, token: boolean, advice: string}}
 */
export function pinStatus({id, chain, current, previous, margin}) {
  const newest = chain.newestLiveNonce;
  const oldest = chain.previousLiveNonce;
  const pins = `newestLiveNonce / previousLiveNonce for chain ${id}`;
  if (current === null) return {tag: "BAD", native: false, token: false, advice: ""};
  // Whether a sale through the Settler in force passes the device's checks with the current pins.
  const native = current === newest || current === oldest;
  const token = current >= oldest && current <= newest + margin;
  if (current > newest + margin) return {tag: "PIN", native, token, advice: `0x deployed Settler ${current}: every sale through it is refused until ${pins} are raised in src/chains.ts`};
  if (current > newest) return {tag: "NEW", native, token, advice: `0x deployed Settler ${current}: native-coin sales to it are refused until ${pins} are raised in src/chains.ts (token sales use it inside the margin) — check it, then raise them`};
  if (current < newest) {
    return {tag: "OLD", native, token, advice: `the registry rolled back to Settler ${current}${token ? "" : ", older than the pinned previous: every sale through it is refused"} — check it, then update ${pins} in src/chains.ts`};
  }
  if (previous !== null && previous !== oldest) return {tag: "PREV", native, token, advice: `the registry names Settler ${previous} as the previous one, not the pinned ${oldest} — check it, then update ${pins} in src/chains.ts`};
  return {tag: "ok", native, token, advice: ""};
}

// The order the Reason line names its groups in: what refuses the most first.
const GROUPS = ["PIN", "NEW", "OLD", "PREV", "BAD", "unreachable", "BAD quote", "BAD remote"];
// Why a sale through the Settler in force is refused today, by the pinStatus tag of the chain's reading.
const WHY = {PIN: "a new deployment past the margin", NEW: "a new deployment", OLD: "a rollback", BAD: "the registry names no Settler this module can tell"};
// The tags a pin raise (or a pin update) answers; a registry that names no Settler is not fixed by the pins.
const PIN_MOVES = new Set(["PIN", "NEW", "OLD", "PREV"]);

/**
 * The last lines of a verify:live run that did not pass: one `Reason:` line that names every chain that is not ok, by
 * verdict (`Reason: NEW on 1, 10; unreachable on 143`), so a reader that keeps only the end of the output — the
 * canary note, a Telegram line — still has every chain; and a `Severity: high` line when a sale through the Settler in
 * force is refused today on a chain whose registry answered, naming what is refused and why, per chain
 * (`… refused today: every sale on 1 (a new deployment past the margin); native-coin sales on 143, 8453 (a new
 * deployment): …`). A new deployment on a pinned chain refuses native-coin sales from that day; past the margin, or a
 * rollback below the pinned previous, every sale; a registry with no Settler this module can tell, everything. An
 * unreachable chain carries no severity: verify-live retries a read the RPC did not answer and ends a chain whose reads
 * all failed as unreachable, so every other verdict is the registry's own word. Pure.
 *
 * @param {{chains: {id: number | string, tag: string, pin?: string, native?: boolean, token?: boolean}[], quotes?: {id: number | string, kind: "quote" | "remote"}[]}} run
 *   `tag` is a pinStatus tag, "BAD" when an on-chain check failed, or "unreachable" when no RPC answered; `pin` is the
 *   pinStatus tag of the reading when `tag` is "BAD" for another check (it says why a sale is refused; `tag` otherwise).
 * @returns {{reason: string | null, severity: string | null}}
 */
export function runSummary({chains, quotes = []}) {
  const groups = new Map(GROUPS.map((g) => [g, new Set()]));
  /** "every sale" / "native-coin sales" and why → chain ids */
  const high = new Map();
  let moved = false;
  for (const c of chains) {
    if (c.tag === "ok") continue;
    const group = groups.get(c.tag) ?? groups.get("BAD");
    group.add(String(c.id));
    // pinStatus's own word on the Settler in force: a sale it refuses today (a check that failed with the pins in step —
    // an owner() that reverted, a Permit2 with no code — is BAD, but refuses no sale through the Settler)
    if (c.tag === "unreachable" || (c.native !== false && c.token !== false)) continue;
    const pin = c.pin ?? c.tag;
    const every = c.token === false;
    const why = pin === "OLD" && every ? "a rollback below the pinned previous" : WHY[pin] ?? WHY.BAD;
    if (PIN_MOVES.has(pin)) moved = true;
    const key = JSON.stringify([every ? 0 : 1, Math.max(0, GROUPS.indexOf(pin)), every ? "every sale" : "native-coin sales", why]);
    if (!high.has(key)) high.set(key, new Set());
    high.get(key).add(String(c.id));
  }
  for (const q of quotes) groups.get(q.kind === "remote" ? "BAD remote" : "BAD quote").add(String(q.id));
  const ids = (set) => [...set].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)).join(", ");
  const parts = [...groups].filter(([, set]) => set.size).map(([g, set]) => `${g} on ${ids(set)}`);
  // every sale first, then in the order of GROUPS
  const refused = [...high].map(([key, set]) => [JSON.parse(key), set]).sort(([a], [b]) => a[0] - b[0] || a[1] - b[1] || a[3].localeCompare(b[3]));
  const what = refused.map(([[, , scope, why], set]) => `${scope} on ${ids(set)} (${why})`).join("; ");
  const advice = moved ? "check it, then update the pins in src/chains.ts" : "check the registry and the Settler it names (no pin raise fixes it)";
  return {
    reason: parts.length ? `Reason: ${parts.join("; ")}` : null,
    severity: high.size ? `Severity: high — sales through the Settler in force are refused today: ${what}: ${advice}` : null,
  };
}
