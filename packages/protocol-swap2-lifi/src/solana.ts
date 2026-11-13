/**
 * A first look at LI.FI's Solana bridge transaction, from its bytes alone (no RPC: accounts loaded from lookup tables
 * stay unknown). It must be paid by the sender. A Mayan route (it calls Mayan's CPI proxy or an order program) must
 * also pay SOL directly to no wallet other than the sender or LI.FI's fee wallet: the account's guard proves its order
 * pays the reviewed recipient (`bridgeOut`). LI.FI's other Solana bridges (Relay, LayerSwap, NEAR Intents, LI.FI
 * Intents, …) deposit to an address, an order id or a program whose recipient lives off chain or in data the device
 * does not read; they pass here as they are and are held by the account to its SOL and token ceilings only.
 */

import {base64Bytes} from "@anywalletkit/protocol-swap2-core/util";
import {base58} from "./solana-address.js";

/** Mayan's CPI proxy and order programs (swap-sdk `src/addresses.ts`). */
const MAYAN_ENTRY_PROGRAMS = new Set([
  "D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa", // CPI_PROXY_PROGRAM_ID
  "BLZRi6frs4X4DNLw56V4EXai1b6QVESN1BhHBTYM9VcY", // SWIFT_PROGRAM_ID
  "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny", // SWIFT_V2_PROGRAM_ID
  "dkpZqrxHFrhziEMQ931GLtfy11nFkCsfMftH9u6QwBU", // MCTP_PROGRAM_ID
  "Gx9rivpS3YR8pBFwMuP6omYqVxunpLvLkNn7ubNyuZZ5", // FAST_MCTP_PROGRAM_ID
]);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** LI.FI's fee wallet on Solana (its `feeCollection` step pays SOL here, tokens to its token accounts). */
export const LIFI_SOLANA_FEE_WALLET = "34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm";

class Cursor {
  at = 0;
  constructor(private readonly b: Uint8Array) {}
  byte(): number {
    if (this.at >= this.b.length) throw new Error("truncated");
    return this.b[this.at++]!;
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.at + n > this.b.length) throw new Error("truncated");
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  /** compact-u16 */
  short(): number {
    let v = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = this.byte();
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
    }
    throw new Error("bad length");
  }
}

/** Why the transaction is visibly wrong for `sender` (see the module note), or null when its static part is consistent with a bridge. */
export function solanaBridgeTxMismatch(base64: string, sender: string): string | null {
  const bytes = base64Bytes(base64);
  if (!bytes) return "the Solana transaction is not base64";
  const c = new Cursor(bytes);
  try {
    c.bytes(64 * c.short()); // signatures
    const first = c.byte();
    if ((first & 0x80) === 0) c.at--; // legacy message: no version prefix
    c.bytes(3); // header
    const keys = Array.from({length: c.short()}, () => base58(c.bytes(32)));
    if (keys[0] !== sender) return `the Solana transaction is paid by ${keys[0] ?? "nobody"}, not the sender ${sender}`;
    c.bytes(32); // recent blockhash
    let mayan = false;
    const payees: string[] = [];
    const n = c.short();
    for (let i = 0; i < n; i++) {
      const program = keys[c.byte()];
      const accounts = Array.from(c.bytes(c.short()));
      const data = c.bytes(c.short());
      if (program !== undefined && MAYAN_ENTRY_PROGRAMS.has(program)) mayan = true;
      // System Transfer: u32 tag 2, u64 lamports; [from, to]. A destination in a lookup table is left to the account.
      if (program === SYSTEM_PROGRAM && data.length === 12 && data[0] === 2 && data[1] === 0 && data[2] === 0 && data[3] === 0) {
        const to = keys[accounts[1] ?? -1];
        if (to !== undefined && to !== sender && to !== LIFI_SOLANA_FEE_WALLET) payees.push(to);
      }
    }
    // A deposit to an address is how the other bridges are paid; a Mayan route moves its funds through its order.
    return mayan && payees.length ? `the Solana transaction transfers SOL to ${payees[0]}, which is neither the sender nor LI.FI's fee wallet` : null;
  } catch (err) {
    return `the Solana transaction does not decode (${err instanceof Error ? err.message : String(err)})`;
  }
}
