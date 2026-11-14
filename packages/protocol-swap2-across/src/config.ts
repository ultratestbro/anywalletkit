// Across Protocol — the pins this module signs against. Nothing here is read from an API at run time: the Across API
// (or an app's own proxy in front of it) is untrusted, and a deposit is signed only for a SpokePool, a chain and a
// token written in this file.
//
// Sources, all read on 2026-11-15:
//  - github.com/across-protocol/contracts @ d652689f67cd9835b9c1ab0acc2f99236902e299, `broadcast/deployed-addresses.json`
//    ("the current source of truth for deployed contract addresses", deployments/README.md): `chains.<id>.contracts.
//    SpokePool.address` for every row below, `chains.1.contracts.HubPool.address` for the hub.
//  - On chain, Ethereum: `HubPool.crossChainContracts(chainId)` (selector 0x09474ae2) answers the same SpokePool for
//    every row (publicnode, block 26415696; eth.drpc.org one block later agreed on every row).
//  - On chain, each row over a public RPC: `eth_chainId` and the SpokePool's own `chainId()` are the row's id; the
//    EIP-1967 implementation slot is set (UUPS proxy, upgraded through the HubPool); `crossDomainAdmin()` is the
//    HubPool; `wrappedNativeToken()` is the value pinned below; `depositQuoteTimeBuffer()` = 3600,
//    `fillDeadlineBuffer()` = 21600 and `pausedDeposits()` = false. The implementation carries the `deposit` selector
//    as PUSH4 on every EVM-bytecode chain. zkSync Era runs EraVM bytecode, where that scan does not apply: there a real
//    deposit was traced instead (tx 0x21c702af…f0d96, `debug_traceTransaction` callTracer): a successful call into the
//    SpokePool with selector 0xad5425c6, 420 bytes (empty message), which emitted FundsDeposited.
//  - The contract: contracts/spoke-pools/SpokePool.sol and contracts/interfaces/V3SpokePoolInterface.sol at the same
//    commit (selectors, event, relay hash, fill statuses, the native-coin rules quoted where they are used).
//  - Tokens: Across's own route list (`GET /available-routes`) and token list (`GET /swap/tokens`), read 2026-11-14,
//    intersected with the SDK's asset catalog (`@anywalletkit/swap2-assets`) by address. A token is pinned only when
//    Across bridges it to the SAME asset on another pinned chain with the same decimals; routes Across lists between
//    different assets (USDC → USDC.e, USDC-BNB → USDC, USDT → USDC, USDG → USDC) are not served.
//
// Chains Across serves that are NOT pinned, and why:
//  - Scroll (534352): `pausedDeposits()` is true on chain (as on Lens, Mode and Zora, which the SDK does not carry) and
//    it is gone from Across's own chain page.
//  - BNB Chain (56): Across bridges its Binance-Peg USDC and USDT (18 decimals) only into other assets, and its ETH is an
//    ERC-20 the catalog does not list — no same-asset route is left.
//  - Lisk, Soneium, Tempo, Blast, Boba, Solana, Tron, HyperCore, Lighter: not EVM chains of the SDK's catalog.
// SDK chains Across does not serve: Gnosis, Sonic, Berachain, Celo, Mantle, Katana, Morph, Flare, Elysium, Sei, Plume,
// X Layer.

/** What a token is across chains. A deposit only ever moves an asset to the same asset. */
export type AcrossAsset = "USDC" | "USDT" | "ETH" | "WBTC";

export interface AcrossToken {
  asset: AcrossAsset;
  /** ERC-20 contract on this chain, lowercase. */
  address: string;
  /** The catalog's symbol on this chain (Tether's USDT is `USDT0` where it is issued as USDT0). */
  symbol: string;
  decimals: number;
}

export interface AcrossChain {
  caip2: string;
  chainId: number;
  /** The SDK's chain key (`@anywalletkit/swap2-assets`). */
  key: string;
  name: string;
  /** SpokePool proxy on that chain: the only contract a deposit calls and the only spender an approval names. */
  spokePool: string;
  /**
   * `wrappedNativeToken()` of that SpokePool. A deposit that sends the native coin names it as `inputToken`; a fill of
   * it is paid out as the native coin to an EOA. Null where the SpokePool reports the zero address (Arc).
   */
  wrappedNative: string | null;
  /** The chain's native coin is ether, bridged as the ETH asset. */
  nativeIsEth: boolean;
  /** ERC-20s Across bridges to the same asset on another pinned chain. ETH's ERC-20 is the wrapped native token. */
  tokens: readonly AcrossToken[];
}

const USDC = (address: string, symbol = "USDC"): AcrossToken => Object.freeze({asset: "USDC", address, symbol, decimals: 6});
const USDT = (address: string, symbol = "USDT"): AcrossToken => Object.freeze({asset: "USDT", address, symbol, decimals: 6});
const WETH = (address: string): AcrossToken => Object.freeze({asset: "ETH", address, symbol: "WETH", decimals: 18});
const WBTC = (address: string): AcrossToken => Object.freeze({asset: "WBTC", address, symbol: "WBTC", decimals: 8});

/** The OP-stack predeploy WETH9. */
const OP_WETH = "0x4200000000000000000000000000000000000006";

function chain(
  chainId: number, key: string, name: string, spokePool: string, wrappedNative: string | null, nativeIsEth: boolean, tokens: AcrossToken[],
): AcrossChain {
  return Object.freeze({caip2: `eip155:${chainId}`, chainId, key, name, spokePool, wrappedNative, nativeIsEth, tokens: Object.freeze(tokens)});
}

/** CAIP-2 → the chain as Across serves it. A null-prototype map: `ACROSS_CHAINS["constructor"]` is undefined. */
export const ACROSS_CHAINS: Readonly<Record<string, AcrossChain>> = Object.freeze(Object.assign(Object.create(null) as Record<string, AcrossChain>, Object.fromEntries([
  chain(1, "ethereum", "Ethereum", "0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", true, [
    USDC("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
    USDT("0xdac17f958d2ee523a2206206994597c13d831ec7"),
    WETH("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"),
    WBTC("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"),
  ]),
  chain(10, "optimism", "Optimism", "0x6f26bf09b1c792e3228e5467807a900a503c0281", OP_WETH, true, [
    USDC("0x0b2c639c533813f4aa9d7837caf62653d097ff85"),
    USDT("0x94b008aa00579c1307b0ef2c499ad98a8ce58e58"),
    WETH(OP_WETH),
  ]),
  chain(130, "unichain", "Unichain", "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64", OP_WETH, true, [
    USDC("0x078d782b760474a361dda0af3839290b0ef57ad6"),
    USDT("0x9151434b16b9763660705744891fa906f660ecc5", "USDT0"),
    WETH(OP_WETH),
  ]),
  chain(137, "polygon", "Polygon", "0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096", "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", false, [
    USDC("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"),
    USDT("0xc2132d05d31c914a87c6611c10748aeb04b58e8f"),
    WBTC("0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"),
  ]),
  chain(143, "monad", "Monad", "0xd2ecb3afe598b746f8123cae365a598da831a449", "0x3bd359c1119da7da1d913d1c4d2b7c461115433a", false, [
    USDC("0x754704bc059f8c67012fed69bc8a327a5aafb603"),
    USDT("0xe7cd86e13ac4309349f30b3435a9d337750fc82d", "USDT0"),
  ]),
  chain(324, "zksync", "zkSync Era", "0xe0b015e54d54fc84a6cb9b666099c46ade9335ff", "0x5aea5775959fbc2557cc8789bc1bf90a239d9a91", true, [
    USDT("0x493257fd37edb34451f62edf8d2a0c418852ba4c"),
    WETH("0x5aea5775959fbc2557cc8789bc1bf90a239d9a91"),
    WBTC("0xbbeb516fb02a01611cbbe0453fe3c580d7281011"),
  ]),
  chain(480, "worldchain", "World Chain", "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64", OP_WETH, true, [
    USDC("0x79a02482a880bce3f13e09da970dc34db4cd24d1"),
    WETH(OP_WETH),
    WBTC("0x03c7054bcb39f7b2e5b2c7acb37583e32d70cfa3"),
  ]),
  chain(999, "hyperevm", "HyperEVM", "0x35e63ea3eb0fb7a3bc543c71fb66412e1f6b0e04", "0x5555555555555555555555555555555555555555", false, [
    USDC("0xb88339cb7199b77e23db6e890353e22632ba630f"),
    USDT("0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", "USDT0"),
  ]),
  chain(4326, "megaeth", "MegaETH", "0x3db06da8f0a24a525f314eec954fc5c6a973d40e", OP_WETH, true, [
    USDT("0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", "USDT0"),
    WETH(OP_WETH),
  ]),
  chain(4663, "robinhood", "Robinhood Chain", "0xd29c85f15df544ba632c9e25829fd29d767d7978", "0x0bd7d308f8e1639fab988df18a8011f41eacad73", true, [
    WETH("0x0bd7d308f8e1639fab988df18a8011f41eacad73"),
  ]),
  // Arc's gas coin is USDC; 0x3600… is its 6-decimal ERC-20 interface, which is what Across moves. The SpokePool
  // reports no wrapped native token, so no deposit or fill on Arc involves the native coin.
  chain(5042, "arc", "Arc", "0x9b4a302a548c7e313c2b74c461db7b84d3074a84", null, false, [
    USDC("0x3600000000000000000000000000000000000000"),
  ]),
  chain(8453, "base", "Base", "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64", OP_WETH, true, [
    USDC("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    USDT("0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"),
    WETH(OP_WETH),
  ]),
  chain(9745, "plasma", "Plasma", "0x50039faefebef707cfd94d6d462fe6d10b39207a", "0x6100e367285b01f48d07953803a2d8dca5d19873", false, [
    USDT("0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", "USDT0"),
  ]),
  chain(42161, "arbitrum", "Arbitrum", "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a", "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", true, [
    USDC("0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
    USDT("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "USDT0"),
    WETH("0x82af49447d8a07e3bd95bd0d56f35241523fbab1"),
    WBTC("0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f"),
  ]),
  chain(43114, "avalanche", "Avalanche", "0xfe9d541c92e4e90437c7152a00244886de37a658", "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", false, [
    USDC("0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"),
    USDT("0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7"),
  ]),
  chain(57073, "ink", "Ink", "0xef684c38f94f48775959ecf2012d7e864ffb9dd4", OP_WETH, true, [
    USDC("0x2d270e6886d130d724215a266106e6832161eaed"),
    USDT("0x0200c29006150606b650577bbe7b6248f58470c1", "USDT0"),
    WETH(OP_WETH),
  ]),
  chain(59144, "linea", "Linea", "0x7e63a5f1a8f0b4d0934b2f2327daed3f6bb2ee75", "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f", true, [
    USDC("0x176211869ca2b568f2a7d4ee941e073a821ee1ff"),
    USDT("0xa219439258ca9da29e9cc4ce5596924745e12b93"),
    WETH("0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f"),
    WBTC("0x3aab2285ddcddad8edf438c1bab47e1a9d05a9b4"),
  ]),
].map((x) => [x.caip2, x]))));

/** The chain for a CAIP-2 id, or undefined — own keys only. */
export function acrossChain(caip2: string): AcrossChain | undefined {
  return typeof caip2 === "string" && Object.prototype.hasOwnProperty.call(ACROSS_CHAINS, caip2) ? ACROSS_CHAINS[caip2] : undefined;
}

/** The pinned token at `address` on `chain` (any casing), or undefined. */
export function acrossToken(chain: AcrossChain, address: string): AcrossToken | undefined {
  if (typeof address !== "string") return undefined;
  const a = address.toLowerCase();
  return chain.tokens.find((t) => t.address === a);
}

/**
 * The HubPool on Ethereum: `crossChainContracts(chainId)` is the registry every pinned SpokePool was checked against.
 * Not a proxy; owned by a 3-of-5 Safe that can re-point the registry and upgrade every SpokePool — a watched fact.
 */
export const ACROSS_HUB_POOL = "0xc186fa914353c44b2e33ebe05f21846f1048beda";
/** `crossChainContracts(uint256)` on the HubPool → `(address adapter, address spokePool)`. */
export const ACROSS_HUB_CROSS_CHAIN_CONTRACTS = "0x09474ae2";

/**
 * `deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount,
 * uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp,
 * uint32 fillDeadline, uint32 exclusivityParameter, bytes message)` payable — the only call this module builds or signs.
 */
export const ACROSS_DEPOSIT = "0xad5425c6";
/** `depositV3(address …)`: the address-typed wrapper of `deposit`. Read in history, never built or signed. */
export const ACROSS_DEPOSIT_V3 = "0x7b939232";
/**
 * Calls on a SpokePool that are always refused: `unsafeDeposit` (a caller-chosen deposit id that can collide),
 * `depositNow` / `depositV3Now` (the fill deadline set on chain), `speedUpDeposit` / `speedUpV3Deposit` (a depositor
 * signature that lets a relayer pay another recipient or a lower amount), and `multicall`.
 */
export const ACROSS_REFUSED_SELECTORS: Readonly<Record<string, string>> = Object.freeze({
  "0x8b15788e": "unsafeDeposit",
  "0xea86bd46": "depositNow",
  "0x7aef642c": "depositV3Now",
  "0xbabb6aac": "speedUpDeposit",
  "0x577f51f8": "speedUpV3Deposit",
  "0xac9650d8": "multicall",
});

/**
 * `UpdateDepositDetails(uint256 depositId,uint256 originChainId,uint256 updatedOutputAmount,bytes32 updatedRecipient,
 * bytes updatedMessage)` under the domain `ACROSS-V2` / `1.0.0`: the speed-up signature. It can move a deposit's
 * output to another recipient, so nothing carrying this type (or that domain) is ever signed through this module.
 */
export const ACROSS_SPEED_UP_TYPEHASH = "0x8d1994e2bbbd77564cdca06dd819e7ee2a5efa06c80dcb59a4a7b6e39edc538f";
export const ACROSS_SPEED_UP_TYPE = "UpdateDepositDetails";
export const ACROSS_SPEED_UP_DOMAIN = "ACROSS-V2";

/**
 * `FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount,
 * uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline,
 * uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)`.
 */
export const ACROSS_FUNDS_DEPOSITED = "0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3";
/** `fillStatuses(bytes32 relayHash)` → 0 unfilled, 1 slow fill requested, 2 filled. */
export const ACROSS_FILL_STATUSES = "0xc35c83fc";

/**
 * `keccak256("AcrossV5MessagePrefix.V1")`: a deposit message starting with these 32 bytes is an Across V5 witness,
 * consumable only through the Gateway's V5 fill entry points (SpokePool.sol `V5_MAGIC_PREFIX`). Refused by name —
 * this module signs empty messages only.
 */
export const ACROSS_V5_MESSAGE_PREFIX = "0x89ae4bc75915265a3f10e926c3894a29534f1d6362ee8959cb0e5be00f3527fd";

/** `depositQuoteTimeBuffer()` on every pinned SpokePool: a deposit's `quoteTimestamp` may be at most this old. */
export const ACROSS_DEPOSIT_QUOTE_TIME_BUFFER_S = 3600;
/** `fillDeadlineBuffer()` on every pinned SpokePool: a deposit's `fillDeadline` may be at most this far ahead. */
export const ACROSS_FILL_DEADLINE_BUFFER_S = 21_600;
/** SpokePool `MAX_EXCLUSIVITY_PERIOD_SECONDS`: an `exclusivityParameter` up to this is an offset, above it a timestamp. */
export const ACROSS_MAX_EXCLUSIVITY_PERIOD_S = 31_536_000;

/** The native coin in a request (and in Across's own token lists): twenty zero bytes. */
export const ACROSS_NATIVE = "0x0000000000000000000000000000000000000000";

/** Across API V5: the price source (`api.ts`), with a key from dashboard.across.to kept on a server. */
export const ACROSS_API = "https://api.across.to";

const ZERO = /^0x0{40}$/;
const isNativeRef = (token: string): boolean => ZERO.test(token);

/** One side of a route: the token as the deposit names it, and whether the user's side of it is the native coin. */
export interface AcrossRouteSide {
  chain: AcrossChain;
  /** The token the deposit names: the ERC-20, or the wrapped native token when `native`. */
  token: string;
  native: boolean;
  decimals: number;
}

export interface AcrossRoute {
  asset: AcrossAsset;
  input: AcrossRouteSide;
  output: AcrossRouteSide;
}

/** Why a pair is not served, for a refusal. */
export interface AcrossRouteMiss {
  code: "chain-unsupported" | "token-unsupported" | "pair-unsupported" | "native-unsupported" | "wrapped-native-destination";
  detail: string;
}

/**
 * The route a request names, or why it is not served. `sourceToken` / `destToken` are contracts (any casing) or the
 * zero address for the native coin. Served: two different pinned chains, the same asset on both sides, the native coin
 * only where it is ether and the SpokePool wraps it, and never the wrapped native token as a destination ERC-20 — an
 * empty-message fill of it pays an EOA the native coin, which is not what was asked for.
 */
export function acrossRouteOf(sourceChain: string, sourceToken: string, destChain: string, destToken: string): AcrossRoute | AcrossRouteMiss {
  const src = acrossChain(sourceChain);
  const dst = acrossChain(destChain);
  if (!src) return {code: "chain-unsupported", detail: `source chain ${String(sourceChain)} is not a pinned Across chain`};
  if (!dst) return {code: "chain-unsupported", detail: `destination chain ${String(destChain)} is not a pinned Across chain`};
  if (src === dst) return {code: "chain-unsupported", detail: "source and destination are the same chain"};
  if (typeof sourceToken !== "string" || typeof destToken !== "string") return {code: "token-unsupported", detail: "the tokens are not addresses"};
  let input: AcrossRouteSide;
  let asset: AcrossAsset;
  if (isNativeRef(sourceToken)) {
    if (!src.nativeIsEth || !src.wrappedNative) return {code: "native-unsupported", detail: `${src.name}'s native coin is not bridged by Across`};
    input = {chain: src, token: src.wrappedNative, native: true, decimals: 18};
    asset = "ETH";
  } else {
    const t = acrossToken(src, sourceToken);
    if (!t) return {code: "token-unsupported", detail: `${sourceToken.toLowerCase()} is not a token pinned on ${src.name}`};
    input = {chain: src, token: t.address, native: false, decimals: t.decimals};
    asset = t.asset;
  }
  let output: AcrossRouteSide;
  if (isNativeRef(destToken)) {
    if (!dst.nativeIsEth || !dst.wrappedNative) return {code: "native-unsupported", detail: `${dst.name}'s native coin is not bridged by Across`};
    if (asset !== "ETH") return {code: "pair-unsupported", detail: `${asset} on ${src.name} is not bridged to ${dst.name}'s native coin`};
    output = {chain: dst, token: dst.wrappedNative, native: true, decimals: 18};
  } else {
    const t = acrossToken(dst, destToken);
    if (!t) return {code: "token-unsupported", detail: `${destToken.toLowerCase()} is not a token pinned on ${dst.name}`};
    if (dst.wrappedNative !== null && t.address === dst.wrappedNative) {
      return {code: "wrapped-native-destination", detail: `a fill of ${t.symbol} on ${dst.name} pays an EOA the native coin, not ${t.symbol} — ask for the native coin`};
    }
    if (t.asset !== asset) return {code: "pair-unsupported", detail: `${asset} is only bridged to ${asset}, not to ${t.symbol}`};
    output = {chain: dst, token: t.address, native: false, decimals: t.decimals};
  }
  if (input.decimals !== output.decimals) return {code: "pair-unsupported", detail: "the two sides have different decimals"};
  return {asset, input, output};
}

export const across = {
  supportsChain(chain: string): boolean {
    return acrossChain(chain) !== undefined;
  },
  /** Two different pinned EVM chains. */
  supports(from: string, to: string): boolean {
    return from !== to && acrossChain(from) !== undefined && acrossChain(to) !== undefined;
  },
};
