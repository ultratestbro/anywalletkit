/**
 * Solana addresses as the bridge checks read them: base58 ↔ the raw 32-byte key, and the associated token account of an
 * owner for a mint, derived the way the Associated Token Account program derives it (`findProgramAddress` over
 * [owner, token program, mint] under ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL; spl.solana.com/associated-token-account).
 * Pure functions over bytes: no RPC, no Node API, no global TextEncoder.
 */
import {ed25519} from "@noble/curves/ed25519.js";
import {sha256} from "@noble/hashes/sha2.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The classic SPL Token program: USDC and USDT on Solana live under it. */
export const SOLANA_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PDA_MARKER = Uint8Array.from("ProgramDerivedAddress", (c) => c.charCodeAt(0));

/** Base58 of raw bytes (leading zero bytes as "1"). */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)]! + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}

/** The 32 raw bytes of a base58 Solana address, or null when it is not exactly one. */
export function solanaKey(address: string): Uint8Array | null {
  if (!BASE58.test(address)) return null;
  let n = 0n;
  for (const ch of address) n = n * 58n + BigInt(ALPHABET.indexOf(ch));
  let zeros = 0;
  while (address[zeros] === "1") zeros++;
  const body: number[] = [];
  while (n > 0n) { body.unshift(Number(n & 0xffn)); n >>= 8n; }
  if (zeros + body.length !== 32) return null;
  const out = new Uint8Array(32);
  out.set(body, zeros);
  return out;
}

const onCurve = (bytes: Uint8Array): boolean => {
  try { ed25519.Point.fromBytes(bytes); return true; } catch { return false; }
};

/** `findProgramAddress`: the first off-curve `sha256(seeds ‖ bump ‖ program ‖ "ProgramDerivedAddress")`, bump 255 → 0. */
function programAddress(seeds: readonly Uint8Array[], program: Uint8Array): Uint8Array {
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, PDA_MARKER];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { buf.set(p, at); at += p.length; }
    const hash = sha256(buf);
    if (!onCurve(hash)) return hash;
  }
  throw new Error("no program address for these seeds");
}

/** The associated token account of `owner` for `mint` under `tokenProgram` (all raw 32-byte keys). */
export function associatedTokenAccount(owner: Uint8Array, mint: Uint8Array, tokenProgram: Uint8Array = solanaKey(SOLANA_TOKEN_PROGRAM)!): Uint8Array {
  return programAddress([owner, tokenProgram, mint], solanaKey(ASSOCIATED_TOKEN_PROGRAM)!);
}
