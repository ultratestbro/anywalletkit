import {decodeFunctionData, getAddress, parseAbi, type Hex} from "viem";
import {sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import type {Quote, QuoteParams, RemotePins} from "@anywalletkit/protocol-swap2-core/types";

/**
 * Uniswap v3 deployments this module trusts. Every entry was checked on-chain
 * (2026-10-12): SwapRouter02.factory() and QuoterV2.factory() both return
 * `factory`, and both report `weth` as WETH9. The provider re-checks the same
 * facts once per chain at runtime before quoting (see `verifyDeployment`).
 */
export interface UniswapDeployment {
  factory: `0x${string}`;
  quoter: `0x${string}`;
  router: `0x${string}`;
  /** The chain's wrapped native token (WETH, WBNB, WPOL, WAVAX) — on a chain
   *  without one (Celo), the hop token used for two-hop routes instead. */
  weth: `0x${string}`;
  /** false: the router has no WETH9 (reports 0x0) — no native in/out, the coin is an ERC-20 there. */
  nativeWrap?: false;
  /** false: a newer QuoterV2 build without WETH9() — only its factory is checked. */
  quoterWeth?: false;
}

export const UNISWAP_V3: Readonly<Record<number, UniswapDeployment>> = Object.freeze({
  1: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"},
  10: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0x4200000000000000000000000000000000000006"},
  56: {factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7", quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077", router: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2", weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"},
  137: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"},
  8453: {factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", router: "0x2626664c2603336E57B271c5C0b26F421741e481", weth: "0x4200000000000000000000000000000000000006"},
  42161: {factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"},
  // zkSync Era and Celo: addresses from cp0x pi-uniswap-interface, verified on-chain 2026-10-12.
  324: {factory: "0x8FdA5a7a8dCA67BBcDd10F02Fa0649A937215422", quoter: "0x8Cb537fc92E26d8EBBb760E632c95484b6Ea3e28", router: "0x99c56385daBCE3E81d8499d0b8d0257aBC07E8A3", weth: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91"},
  42220: {factory: "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc", quoter: "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8", router: "0x5615CDAb10dc425a742d643d949a7F474C01abc4", weth: "0x471EcE3750Da237f93B8E339c536989b8978a438", nativeWrap: false},
  // Unichain, Monad, Linea: Uniswap's sdk-core CHAIN_TO_ADDRESSES_MAP, verified on-chain 2026-10-13
  // (router + quoter report the factory; these quoters have no WETH9()).
  130: {factory: "0x1F98400000000000000000000000000000000003", quoter: "0x565AC8C7863D9bb16d07E809ff49Fe5cD467634C", router: "0x73855d06DE49d0fe4A9c42636Ba96c62da12FF9C", weth: "0x4200000000000000000000000000000000000006", quoterWeth: false},
  143: {factory: "0x204FAca1764B154221e35c0d20aBb3c525710498", quoter: "0x2d01411773c8C24805306e89a41f7855c3C4fE65", router: "0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900", weth: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", quoterWeth: false},
  59144: {factory: "0x31FAfd4889FA1269F7a13A66eE0fB458f27D72A9", quoter: "0x58EaD433eA99708604c4dD7C9b7E80c70976E202", router: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", weth: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", quoterWeth: false},
  // World Chain, Ink, X Layer: Uniswap's sdk-core CHAIN_TO_ADDRESSES_MAP, verified on-chain 2026-10-13
  // (router + quoter report the factory; X Layer's quoter has no WETH9(), its router wraps WOKB).
  480: {factory: "0x7a5028BDa40e7B173C278C5342087826455ea25a", quoter: "0x10158D43e6cc414deE1Bd1eB0EfC6a5cBCfF244c", router: "0x091AD9e2e6e5eD44c1c66dB50e49A601F9f36cF6", weth: "0x4200000000000000000000000000000000000006"},
  57073: {factory: "0x640887A9ba3A9C53Ed27D0F7e8246A4F933f3424", quoter: "0x96b572D2d880cf2Fa2563651BD23ADE6f5516652", router: "0x177778F19E89dD1012BdBe603F144088A95C4B53", weth: "0x4200000000000000000000000000000000000006"},
  196: {factory: "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804", quoter: "0x976183AC3d09840D243A88c0268BADb3B3e3259f", router: "0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA", weth: "0xe538905cf8410324e03A5A23C1c177a474D59b2b", quoterWeth: false},
  // Robinhood Chain: addresses from cp0x pi-uniswap-interface (constants/addresses.ts), verified on-chain 2026-10-12.
  4663: {factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA", quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7", router: "0xCaf681a66D020601342297493863E78C959E5cb2", weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"},
  43114: {factory: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD", quoter: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F", router: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE", weth: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"},
});

/** Pool fee tiers probed for every hop (0.01%, 0.05%, 0.3%, 1%). */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
/** Two-hop routes go through these (when the catalog knows them on the chain). */
export const HOP_SYMBOLS = ["WETH", "USDC", "USDT"] as const;
/** SwapRouter02 recipient sentinel: "keep the output in the router" (then unwrapWETH9). */
export const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

/** The SwapRouter02 entry points this module writes (and the deployment probes). */
export const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
]);
/** Most pools one `exactInput` path may cross: the provider builds direct and one-hop (two-pool) routes only. */
const MAX_PATH_POOLS = 2;

/**
 * The swap a Uniswap quote's router call makes, opened on the client against the app's own request (scan 2026-10-28,
 * F1): one `multicall(deadline, legs)` on the chain's pinned SwapRouter02 whose legs are exactly one `exactInputSingle`
 * or `exactInput` — then `unwrapWETH9` for a native output — selling exactly the input of the source token (WETH for a
 * native input, paid as `value`) for the destination token, with `amountOutMinimum` the quote's minimum, paid to the
 * recipient (or kept in the router and unwrapped to the recipient for that same minimum). `pull`, `sweepToken` and
 * every other router call are refused. The reason it fails, or null.
 */
export function uniswapVerifyQuote(params: QuoteParams, quote: Quote): string | null {
  const id = /^eip155:[0-9]+$/.test(params.sourceChain) ? Number(params.sourceChain.slice(7)) : NaN;
  const d = Object.prototype.hasOwnProperty.call(UNISWAP_V3, id) ? UNISWAP_V3[id] : undefined;
  if (!d || params.destChain !== params.sourceChain) return "not a same-chain swap on a pinned Uniswap deployment";
  const tx = quote.txRequest;
  if (!tx?.data || !tx.to || tx.serializedTx !== undefined) return "the quote carries no router call";
  if (getAddress(tx.to) !== getAddress(d.router)) return `the call targets ${tx.to}, not the SwapRouter`;
  const src = sourceAssetOf(params);
  if (!src) return `unknown source token ${params.sourceToken}`;
  const nativeIn = !src.contract;
  const nativeOut = /^0x0+$/.test(params.destToken);
  if ((nativeIn || nativeOut) && d.nativeWrap === false) return "this chain's router has no wrapped native";
  let tokenIn: string, tokenOut: string, recipient: string, amountIn: bigint, minOut: bigint;
  try {
    tokenIn = getAddress(nativeIn ? d.weth : src.contract!);
    tokenOut = getAddress(nativeOut ? d.weth : params.destToken);
    recipient = getAddress(params.destAddress);
    amountIn = BigInt(params.amountIn);
    minOut = BigInt(quote.minDestAmount);
  } catch {
    return "the request does not name EVM tokens, a recipient and amounts";
  }
  if (nativeIn ? BigInt(tx.value ?? "0") !== amountIn || tx.approvalAddress !== undefined
    : BigInt(tx.value ?? "0") !== 0n || !tx.approvalAddress || getAddress(tx.approvalAddress) !== getAddress(d.router)) {
    return nativeIn ? "a native input is paid as exactly the input in value, with no approval" : "a token input attaches no value and approves the SwapRouter";
  }
  let legs: readonly Hex[];
  try {
    const outer = decodeFunctionData({abi: ROUTER_ABI, data: tx.data as Hex});
    if (outer.functionName !== "multicall") return `${outer.functionName} is not multicall(deadline, legs)`;
    legs = outer.args[1];
  } catch {
    return "the router call is not multicall(deadline, legs)";
  }
  if (legs.length !== (nativeOut ? 2 : 1)) return `the multicall has ${legs.length} legs, not a swap${nativeOut ? " and an unwrap" : ""}`;
  const decode = (leg: Hex) => { try { return decodeFunctionData({abi: ROUTER_ABI, data: leg}); } catch { return null; } };
  const swap = decode(legs[0]!);
  const swapTo = nativeOut ? ADDRESS_THIS : recipient;
  if (swap?.functionName === "exactInputSingle") {
    const a = swap.args[0];
    if (getAddress(a.tokenIn) !== tokenIn || getAddress(a.tokenOut) !== tokenOut) return "the swap trades other tokens";
    if (a.amountIn !== amountIn || a.amountOutMinimum !== minOut || a.sqrtPriceLimitX96 !== 0n) return "the swap's input, minimum or price limit is not the quote's";
    if (getAddress(a.recipient) !== getAddress(swapTo)) return `the swap pays ${a.recipient}, not the recipient`;
  } else if (swap?.functionName === "exactInput") {
    const a = swap.args[0];
    const path = a.path.slice(2);
    const pools = (path.length / 2 - 20) / 23;
    if (!/^[0-9a-fA-F]*$/.test(path) || !Number.isInteger(pools) || pools < 1 || pools > MAX_PATH_POOLS) return "the swap path is not 1–2 pools";
    if (getAddress(`0x${path.slice(0, 40)}`) !== tokenIn || getAddress(`0x${path.slice(-40)}`) !== tokenOut) return "the swap path trades other tokens";
    if (a.amountIn !== amountIn || a.amountOutMinimum !== minOut) return "the swap's input or minimum is not the quote's";
    if (getAddress(a.recipient) !== getAddress(swapTo)) return `the swap pays ${a.recipient}, not the recipient`;
  } else {
    return `${swap?.functionName ?? "an unknown call"} is not exactInputSingle / exactInput`;
  }
  if (nativeOut) {
    const unwrap = decode(legs[1]!);
    if (unwrap?.functionName !== "unwrapWETH9") return `${unwrap?.functionName ?? "an unknown call"} is not unwrapWETH9`;
    if (unwrap.args[0] !== minOut || getAddress(unwrap.args[1]) !== recipient) return "the unwrap pays someone else or less than the minimum";
  }
  return null;
}

/**
 * The SwapRouter a Uniswap swap calls and approves on a chain (the shipped {@link UNISWAP_V3} table), and
 * {@link uniswapVerifyQuote} — the app's pins for `remoteProvider({name: "uniswap", baseUrl, ...uniswapPins})` (scan
 * 2026-10-27 modules, F9; scan 2026-10-28, F1).
 */
export const uniswapPins: RemotePins = Object.freeze({
  callTargets: (chain: string): readonly string[] => uniswapRouterFor(chain),
  spenders: (chain: string): readonly string[] => uniswapRouterFor(chain),
  verifyQuote: uniswapVerifyQuote,
});
function uniswapRouterFor(chain: string): readonly string[] {
  const id = /^eip155:[0-9]+$/.test(chain) ? Number(chain.slice(7)) : NaN;
  const d = Object.prototype.hasOwnProperty.call(UNISWAP_V3, id) ? UNISWAP_V3[id] : undefined;
  return d ? [d.router] : [];
}
