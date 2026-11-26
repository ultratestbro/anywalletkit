/** Types of pin-status.mjs (verify:live's verdict on one chain's registry reading against its pins). */
export interface PinReading {
  id: number | string;
  chain: {newestLiveNonce: number; previousLiveNonce: number};
  current: number | null;
  previous: number | null;
  margin: number;
}
export interface PinStatus {
  tag: "ok" | "NEW" | "PIN" | "OLD" | "PREV" | "BAD";
  /** Whether a native-coin sale through the Settler in force passes the device's checks with the current pins. */
  native: boolean;
  /** Whether a token sale through it does. */
  token: boolean;
  /** What to do; empty when nothing is to be done. */
  advice: string;
}
export function pinStatus(reading: PinReading): PinStatus;
/** One chain of a verify:live run: a pinStatus tag, "BAD" (an on-chain check failed) or "unreachable" (no RPC answered). */
export interface RunChain {
  id: number | string;
  tag: PinStatus["tag"] | "unreachable";
  /** The pinStatus tag of the reading, when `tag` is "BAD" for another failed check (why a sale is refused). */
  pin?: PinStatus["tag"];
  native?: boolean;
  token?: boolean;
}
/** A live corridor that failed: through the provider ("quote") or through the server handler ("remote"). */
export interface RunQuote {
  id: number | string;
  kind: "quote" | "remote";
}
/**
 * The last lines of a run that did not pass: `Reason:` names every chain that is not ok, by verdict; `Severity: high`
 * when a sale through the Settler in force is refused today on a chain whose registry answered, naming what is refused
 * (every sale / native-coin sales) and why, per chain. Both null on a clean run.
 */
export function runSummary(run: {chains: RunChain[]; quotes?: RunQuote[]}): {reason: string | null; severity: string | null};
