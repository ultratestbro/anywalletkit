/**
 * Jupiter (Solana) — Swap API V2, Router path (`GET /swap/v2/build`): Metis on-chain routing, raw instructions, no
 * Jupiter swap fee. The transaction is assembled here and executed by the account's serialized-transaction guard
 * (simulation + balance proof), then broadcast through the wallet's own RPC — Jupiter never lands it for us.
 * Same-chain only: Solana → Solana.
 */
import {ccAsset, ccAssetByToken} from "@forgewallet/swap2-assets";

export const JUPITER_API_DEFAULT = "https://api.jup.ag/swap/v2";

/** Jupiter Aggregator v6 — the only program a swap instruction may target. */
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** Wrapped SOL: Jupiter's name for native SOL (it wraps / unwraps around the swap). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Programs the /build instructions may invoke; anything else refuses the quote before the wallet sees it. */
export const JUPITER_TX_PROGRAMS: ReadonlySet<string> = new Set([JUPITER_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM]);

/** swap2 names Solana `solana:mainnet`; wallet history uses the genesis-hash form. */
export const SOLANA_CAIP2 = "solana:mainnet";
export const SOLANA_CHAINS: ReadonlySet<string> = new Set([SOLANA_CAIP2, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NATIVE = new Set(["", "native", "sol", SYSTEM_PROGRAM, WSOL_MINT.toLowerCase(), "0x0000000000000000000000000000000000000000"]);

/** A swap2 token ref on Solana (catalog symbol, mint, or a native marker) → the mint Jupiter quotes; null when unknown. */
export function jupiterMint(token: string): string | null {
  if (NATIVE.has(token.toLowerCase()) || /^0x0+$/.test(token)) return WSOL_MINT;
  const bySymbol = ccAsset(SOLANA_CAIP2, token);
  if (bySymbol) return bySymbol.contract ?? WSOL_MINT;
  const byMint = BASE58.test(token) ? ccAssetByToken(SOLANA_CAIP2, token) : undefined;
  if (byMint) return byMint.contract ?? WSOL_MINT;
  return BASE58.test(token) ? token : null;
}

export const jupiter = {
  supportsChain: (chain: string) => chain === SOLANA_CAIP2,
  supports: (from: string, to: string) => from === SOLANA_CAIP2 && to === SOLANA_CAIP2,
};
