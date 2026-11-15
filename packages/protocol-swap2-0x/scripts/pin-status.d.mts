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
