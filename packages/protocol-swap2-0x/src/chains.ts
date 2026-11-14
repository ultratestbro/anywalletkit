/**
 * Where 0x settles, per chain. Everything a swap is held to on the device starts from this table:
 * the Settler registry (read on-chain for the Settler in force), canonical Permit2, and the wrapped
 * native token (wrap/unwrap pairs are not 0x swaps and are left to the wrap provider).
 *
 * The table is config: `zeroExChains(config.chains)` merges an integrator's entries over these.
 */
import {PERMIT2_ADDRESS} from "@anywalletkit/protocol-swap2-core/util";

/** Canonical Permit2 — the only allowance target and the only EIP-712 verifying contract this module accepts. */
export const ZEROEX_PERMIT2 = PERMIT2_ADDRESS;
/**
 * The 0x Settler deployer/registry (ERC-721: `ownerOf(feature)` is the Settler in force for that feature,
 * `prev(feature)` the instance it replaced). Same address on every chain 0x deploys to.
 */
export const ZEROEX_SETTLER_REGISTRY = "0x00000000000004533Fe15556B1E086BB1A72cEae";
/** Registry feature 2: taker-submitted Settlers — the ones a Permit2 quote is sent to by the taker itself. */
export const ZEROEX_TAKER_FEATURE = 2;
/** How the 0x API (and Settler's slippage check) names the chain's native coin. */
export const ZEROEX_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** 0x's AllowanceHolder (the flow the docs recommend today). Not used by this module; pinned so it can be told apart. */
export const ZEROEX_ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";

export interface ZeroExChain {
  /** Display name. */
  name: string;
  /** The Settler registry on this chain. */
  registry: string;
  /**
   * The newest Settler deployment (the registry's taker-feature nonce, see `zeroExSettlerAddress`) accepted on this
   * chain: the newest one live when the table was pinned plus {@link ZEROEX_SETTLER_NONCE_MARGIN}. A registry answer
   * naming a newer deployment is refused, clearly, until this pin is raised — the watch job reports every new
   * deployment (`ownerOf(2)` per chain in watch.json, `verify:live` on the canary). 1…{@link ZEROEX_SETTLER_MAX_NONCE}.
   */
  maxSettlerNonce: number;
  /** Wrapped native token; native ↔ wrapped pairs are refused up front (0x answers them with a call to this token, not a Settler). */
  wrappedNative?: string;
}

/**
 * Deployments of the taker feature accepted past the newest one live when {@link ZEROEX_CHAINS} was pinned: room for
 * 0x's next Settlers (about one a month per chain) before the pin must be raised. Kept small on purpose: within it the
 * device relies on the code check (a deployment that does not exist yet has no code) and on its RPC answering that
 * check truthfully.
 */
export const ZEROEX_SETTLER_NONCE_MARGIN = 2;
/** The highest {@link ZeroExChain.maxSettlerNonce} a chain table may pin. */
export const ZEROEX_SETTLER_MAX_NONCE = 1024;

const chain = (name: string, wrappedNative: string, liveSettler: number): ZeroExChain =>
  Object.freeze({name, registry: ZEROEX_SETTLER_REGISTRY, maxSettlerNonce: liveSettler + ZEROEX_SETTLER_NONCE_MARGIN, wrappedNative});

/**
 * The default chain table (EVM chain id → entry). The third argument is the newest taker Settler deployment live on
 * the chain when pinned (2026-11-15, `pnpm verify:live`: every deployment up to it has code, the registry names it
 * as current and the one before as previous).
 */
export const ZEROEX_CHAINS: Readonly<Record<number, ZeroExChain>> = Object.freeze({
  1: chain("Ethereum", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 21),
  10: chain("Optimism", "0x4200000000000000000000000000000000000006", 21),
  56: chain("BNB Smart Chain", "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", 23),
  137: chain("Polygon", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", 20),
  8453: chain("Base", "0x4200000000000000000000000000000000000006", 22),
  42161: chain("Arbitrum", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", 20),
  43114: chain("Avalanche", "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", 20),
});

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;

/**
 * The chain table in force: the defaults with `overrides` merged over them (an entry replaces the default for that
 * chain id, `null` removes the chain). An entry whose registry or wrapped native is not an address, or that pins no
 * newest Settler deployment, throws — a typo here would move the root of every check.
 */
export function zeroExChains(overrides?: Readonly<Record<number, ZeroExChain | null>>): Readonly<Record<number, ZeroExChain>> {
  if (!overrides) return ZEROEX_CHAINS;
  const out: Record<number, ZeroExChain> = {...ZEROEX_CHAINS};
  for (const key of Object.keys(overrides)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`zeroex: chain id ${key.slice(0, 20)} is not a positive integer`);
    const entry = overrides[id];
    if (entry === null || entry === undefined) {
      delete out[id];
      continue;
    }
    if (typeof entry.name !== "string" || !entry.name) throw new Error(`zeroex: chain ${id} has no name`);
    if (typeof entry.registry !== "string" || !ADDRESS.test(entry.registry) || ZERO_ADDRESS.test(entry.registry)) throw new Error(`zeroex: chain ${id} names no Settler registry address`);
    if (entry.wrappedNative !== undefined && (typeof entry.wrappedNative !== "string" || !ADDRESS.test(entry.wrappedNative))) throw new Error(`zeroex: chain ${id} wrapped native is not an address`);
    if (!Number.isSafeInteger(entry.maxSettlerNonce) || entry.maxSettlerNonce < 1 || entry.maxSettlerNonce > ZEROEX_SETTLER_MAX_NONCE) {
      throw new Error(`zeroex: chain ${id} pins no newest Settler deployment (maxSettlerNonce, 1 to ${ZEROEX_SETTLER_MAX_NONCE})`);
    }
    out[id] = Object.freeze({name: entry.name, registry: entry.registry, maxSettlerNonce: entry.maxSettlerNonce, ...(entry.wrappedNative ? {wrappedNative: entry.wrappedNative} : {})});
  }
  return Object.freeze(out);
}

/** The EVM chain id of a CAIP-2 `eip155:<id>` string, or `NaN`. */
export function zeroExChainId(caip2: string): number {
  return typeof caip2 === "string" && /^eip155:[1-9][0-9]{0,15}$/.test(caip2) ? Number(caip2.slice(7)) : NaN;
}

/** Own-property lookup (a chain id like `constructor` must not resolve to anything). */
export function zeroExChain(chains: Readonly<Record<number, ZeroExChain>>, chainId: number): ZeroExChain | undefined {
  return Number.isSafeInteger(chainId) && Object.prototype.hasOwnProperty.call(chains, chainId) ? chains[chainId] : undefined;
}
