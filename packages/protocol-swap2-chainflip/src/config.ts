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
import type {Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {decodeEvmVaultCall, decodeTronNote, destAddressBytes, fromHex, minOutOf, sameBytes, type CfParameters} from "./codec.js";

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

/**
 * The provider's own decode of a vault swap, run on the client against the app's request (scan 2026-10-28, F9): an
 * EVM source is a vault call (`xSwapNative` / `xSwapToken`) on the pinned Vault, a Tron source a send to the pinned
 * Tron Vault whose note carries the swap; either way the destination chain, asset and address, the source token and
 * amount, the refund address and a minimum price that guarantees the quoted minimum must be the app's, with no DCA,
 * boost, broker fee or affiliates. The reason it fails, or null.
 */
export function chainflipVerifyQuote(params: QuoteParams, quote: Quote): string | null {
  try {
    const src = cfAsset(params.sourceChain, params.sourceToken);
    const dst = cfAsset(params.destChain, params.destToken);
    const dstChain = CF_CHAINS[params.destChain];
    const vault = Object.prototype.hasOwnProperty.call(CF_VAULTS, params.sourceChain) ? CF_VAULTS[params.sourceChain] : undefined;
    if (!src || !dst || !dstChain || !vault || !CF_SOURCE_CHAINS.has(params.sourceChain)) return "not a vault swap this release signs";
    // A dry quote lists a route and pays nobody; execution re-quotes live.
    if (!quote.txRequest && !quote.depositAddress) return null;
    if (!params.refundAddress) return "a live quote needs the refund address";
    const amountIn = BigInt(params.amountIn);
    const dest = destAddressBytes(params.destChain, params.destAddress);
    const refund = destAddressBytes(params.sourceChain, params.refundAddress);
    const checkParams = (p: CfParameters): string | null => {
      if (!sameBytes(fromHex(p.refundAddress), refund)) return "the refund address is not the sender";
      if (minOutOf(amountIn, p.minPriceX128) < BigInt(quote.minDestAmount)) return "the minimum price does not guarantee the quoted minimum";
      if (p.dca !== null || p.boostFeeBps !== 0 || p.broker.feeBps !== 0 || p.affiliates.length) return "DCA, boost, a broker fee or affiliates";
      return null;
    };
    if (params.sourceChain.startsWith("eip155:")) {
      const tx = quote.txRequest;
      if (quote.depositAddress || !tx?.data || tx.serializedTx !== undefined) return "an EVM vault swap is a vault call, not a deposit";
      if (!tx.to || tx.to.toLowerCase() !== vault.toLowerCase()) return `the call targets ${tx.to}, not the Vault`;
      const v = decodeEvmVaultCall(tx.data);
      if (v.dstChain !== dstChain.id || v.dstToken !== dst.id || !sameBytes(v.dstAddress, dest)) return "the vault call names another destination";
      if (src.token === null) {
        if (!v.native || BigInt(tx.value ?? "0") !== amountIn || tx.approvalAddress) return "the native vault call moves another amount";
      } else if (v.native || v.srcToken?.toLowerCase() !== src.token.toLowerCase() || v.amount !== amountIn || BigInt(tx.value ?? "0") !== 0n ||
        tx.approvalAddress?.toLowerCase() !== vault.toLowerCase()) {
        return "the token vault call moves another token or amount";
      }
      return checkParams(v.params);
    }
    // Tron: the deposit is a send of the input to the Vault, the swap riding in the note.
    if (quote.txRequest || quote.depositAddress !== vault || !quote.depositMemo) return "a Tron vault swap is a send to the Tron Vault with its note";
    const n = decodeTronNote(quote.depositMemo);
    if (n.outputAsset !== dst.id || n.destTag !== dstChain.addrTag || !sameBytes(n.destAddress, dest)) return "the note names another destination";
    return checkParams(n.params);
  } catch (e) {
    return `the vault swap does not decode (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`;
  }
}

/**
 * The Chainflip Vault a vault swap calls and approves on an EVM chain ({@link CF_VAULTS}), and
 * {@link chainflipVerifyQuote} — the app's pins for `remoteProvider({name: "chainflip", baseUrl, ...chainflipPins})`
 * (scan 2026-10-27 modules, F8/F16). A Tron vault swap is a send to the Tron Vault the verifier pins, so the stub is
 * opened to that deposit route (`depositAddressRoutes`, scan 2026-10-28 F9); its note must ride as hex bytes.
 */
export const chainflipPins: RemotePins = Object.freeze({
  callTargets: (chain: string): readonly string[] => chainflipVaultFor(chain),
  spenders: (chain: string): readonly string[] => chainflipVaultFor(chain),
  verifyQuote: chainflipVerifyQuote,
  verifyBuild: (quote: Quote, tx: UnsignedTx): string | null =>
    quote.depositMemo && tx.memoEncoding !== "hex" ? "the Tron note is not sent as hex bytes" : null,
  depositAddressRoutes: true,
});
function chainflipVaultFor(chain: string): readonly string[] {
  const vault = chain.startsWith("eip155:") && Object.prototype.hasOwnProperty.call(CF_VAULTS, chain) ? CF_VAULTS[chain] : undefined;
  return vault ? [vault] : [];
}
