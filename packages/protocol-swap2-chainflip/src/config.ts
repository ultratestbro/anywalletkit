/**
 * Chainflip (JIT-AMM state chain) — chains, assets and contracts as the public backend and the vault encodings name them.
 * Asset ids, chain ids and decimals are the protocol's own (`cf_environment` / networkInfo, verified 2026-10-20); the
 * contract addresses are Chainflip's mainnet deployments (docs mainnet-addresses, confirmed by live encodings).
 *
 * Only VAULT SWAPS are offered: the donor signs a transaction whose every Chainflip parameter (destination, minimum price,
 * refund address) is decoded and checked locally before signing — no off-chain deposit channel to trust, and on Tron no
 * 3.4 USDT ingress fee. Sources: EVM (Ethereum, Arbitrum) and Tron in this release; Solana / Bitcoin vault swaps need an
 * instruction / OP_RETURN builder and come next. Destinations: every live chain.
 */
export type CfChain = "Ethereum" | "Bitcoin" | "Arbitrum" | "Solana" | "Tron";

export interface CfAsset {
  chain: CfChain;
  /** the API's asset symbol */
  asset: string;
  /** the u32 asset id inside vault encodings */
  id: number;
  decimals: number;
  /** token contract / mint on its chain, null for the native coin */
  token: string | null;
  /** smallest deposit the state chain accepts (base units) */
  minDeposit: bigint;
}

/**
 * CAIP-2 → Chainflip chain: `id` = the ForeignChain number an EVM vault call names (`dstChain`), `addrTag` = the
 * EncodedAddress variant a Tron note names (Eth 0, Dot 1, Btc 2, Arb 3, Sol 4, Hub 5, Tron 6) — two different enums.
 */
export const CF_CHAINS: Readonly<Record<string, {name: CfChain; id: number; addrTag: number}>> = {
  "eip155:1": {name: "Ethereum", id: 1, addrTag: 0},
  "bitcoin:mainnet": {name: "Bitcoin", id: 3, addrTag: 2},
  "eip155:42161": {name: "Arbitrum", id: 4, addrTag: 3},
  "solana:mainnet": {name: "Solana", id: 5, addrTag: 4},
  "tron:728126428": {name: "Tron", id: 7, addrTag: 6},
};

export const CF_ASSETS: readonly CfAsset[] = [
  {chain: "Ethereum", asset: "ETH", id: 1, decimals: 18, token: null, minDeposit: 10n ** 16n},
  {chain: "Ethereum", asset: "USDC", id: 3, decimals: 6, token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", minDeposit: 20_000_000n},
  {chain: "Ethereum", asset: "USDT", id: 8, decimals: 6, token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", minDeposit: 20_000_000n},
  {chain: "Ethereum", asset: "WBTC", id: 14, decimals: 8, token: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", minDeposit: 40_000n},
  {chain: "Bitcoin", asset: "BTC", id: 5, decimals: 8, token: null, minDeposit: 40_000n},
  {chain: "Arbitrum", asset: "ETH", id: 6, decimals: 18, token: null, minDeposit: 3_900_000_000_000_000n},
  {chain: "Arbitrum", asset: "USDC", id: 7, decimals: 6, token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", minDeposit: 10_000_000n},
  {chain: "Arbitrum", asset: "USDT", id: 15, decimals: 6, token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", minDeposit: 10_000_000n},
  {chain: "Solana", asset: "SOL", id: 9, decimals: 9, token: null, minDeposit: 68_000_000n},
  {chain: "Solana", asset: "USDC", id: 10, decimals: 6, token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", minDeposit: 10_000_000n},
  {chain: "Solana", asset: "USDT", id: 16, decimals: 6, token: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", minDeposit: 10_000_000n},
  {chain: "Tron", asset: "TRX", id: 17, decimals: 6, token: null, minDeposit: 30_000_000n},
  {chain: "Tron", asset: "USDT", id: 18, decimals: 6, token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", minDeposit: 10_000_000n},
];

/** Vault contracts that receive vault swaps (the deposit transaction's target). */
export const CF_VAULTS: Readonly<Record<string, string>> = {
  "eip155:1": "0xF5e10380213880111522dd0efD3dbb45b9f62Bcc",
  "eip155:42161": "0x79001a5e762f3bEFC8e5871b42F6734e00498920",
  "tron:728126428": "TEcDijvKSXcfWT7S6rd44H5vNgufm7Y4XC",
};

/** Sources this release signs (vault swaps the engine can execute and the verifier can decode). */
export const CF_SOURCE_CHAINS = new Set(["eip155:1", "eip155:42161", "tron:728126428"]);

export const CF_API_DEFAULT = "https://chainflip-swap.chainflip.io";

const sameToken = (chain: string, a: string, b: string) => (chain.startsWith("eip155:") ? a.toLowerCase() === b.toLowerCase() : a === b);
const NATIVE = new Set(["", "native", "0x0000000000000000000000000000000000000000"]);

/** The Chainflip asset for a CAIP-2 chain + token (contract / mint, a native marker, or the asset symbol). */
export function cfAsset(chain: string, token: string): CfAsset | undefined {
  const c = CF_CHAINS[chain];
  if (!c) return undefined;
  const on = CF_ASSETS.filter((a) => a.chain === c.name);
  if (NATIVE.has(token.toLowerCase())) return on.find((a) => a.token === null);
  return on.find((a) => (a.token !== null && sameToken(chain, a.token, token)) || a.asset === token.toUpperCase());
}

export const chainflip = {
  supportsChain: (chain: string) => !!CF_CHAINS[chain],
  supports: (from: string, to: string) => CF_SOURCE_CHAINS.has(from) && !!CF_CHAINS[to] && from !== to,
};
