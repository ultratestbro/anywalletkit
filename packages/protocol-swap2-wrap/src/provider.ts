import type {RemotePins} from "@anywalletkit/protocol-swap2-core/types";
import {decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Hex} from "viem";
import {describeWrapActivity} from "./activity.js";
import {ccAsset} from "@anywalletkit/swap2-assets";
import {evmRef, isEvm, timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import {httpRefusal, refusal, refusalNotes, refusalOf, withReason, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";

/**
 * The chain's canonical wrapped native token (WETH9-style `deposit()` /
 * `withdraw(uint256)`). Every entry was checked on-chain 2026-10-12: symbol,
 * 18 decimals, non-zero supply, and `deposit()` succeeding for a funded sender.
 * The provider re-checks symbol + decimals once per chain before quoting.
 */
export const WRAPPED_NATIVE: Readonly<Record<number, {address: `0x${string}`; symbol: string}>> = Object.freeze({
  1: {address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH"},
  10: {address: "0x4200000000000000000000000000000000000006", symbol: "WETH"},
  56: {address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB"},
  100: {address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", symbol: "WXDAI"},
  130: {address: "0x4200000000000000000000000000000000000006", symbol: "WETH"},
  137: {address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", symbol: "WPOL"},
  143: {address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", symbol: "WMON"},
  999: {address: "0x5555555555555555555555555555555555555555", symbol: "WHYPE"},
  324: {address: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91", symbol: "WETH"},
  4326: {address: "0x4200000000000000000000000000000000000006", symbol: "WETH"},
  9745: {address: "0x6100E367285b01F48D07953803A2d8dCA5D19873", symbol: "WXPL"},
  146: {address: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", symbol: "wS"},
  59144: {address: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", symbol: "WETH"},
  8453: {address: "0x4200000000000000000000000000000000000006", symbol: "WETH"},
  42161: {address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH"},
  43114: {address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", symbol: "WAVAX"},
  80094: {address: "0x6969696969696969696969696969696969696969", symbol: "WBERA"},
  534352: {address: "0x5300000000000000000000000000000000000004", symbol: "WETH"},
  // 2026-10-13: World Chain, Sei, Ink, Plume, X Layer — verified on-chain (symbol, decimals, supply, deposit()).
  480: {address: "0x4200000000000000000000000000000000000006", symbol: "WETH"},
  1329: {address: "0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7", symbol: "WSEI"},
  57073: {address: "0x4200000000000000000000000000000000000006", symbol: "WETH"},
  98866: {address: "0xEa237441c92CAe6FC17Caaf9a7acB3f953be4bd1", symbol: "WPLUME"},
  196: {address: "0xe538905cf8410324e03A5A23C1c177a474D59b2b", symbol: "WOKB"},
  // 2026-10-14: Mantle, Katana, Morph, Flare — symbol, 18 decimals, supply, deposit()/withdraw() selectors in the
  // bytecode and eth_estimateGas of deposit() with value from a funded sender, all checked on-chain. Katana's WETH9 is
  // Vault Bridge's vbETH (the on-chain symbol the verify step compares against; the catalog shows it as WETH).
  // Arc has no wrapper by design: its native USDC already exposes an ERC-20 interface (docs.arc.network).
  5000: {address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", symbol: "WMNT"},
  747474: {address: "0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62", symbol: "vbETH"},
  2818: {address: "0x5300000000000000000000000000000000000011", symbol: "WETH"},
  14: {address: "0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d", symbol: "WFLR"},
  // 2026-11-10: Elysium (Kinetiq, Arbitrum Orbit on HyperEVM). WHYPE is the chain's aeWETH behind a transparent proxy
  // (implementation 0xf098…0542): symbol "WHYPE", 18 decimals, native balance == totalSupply() (read 2026-11-10),
  // deposit() / withdraw(uint256) in the implementation's bytecode, eth_estimateGas of deposit() with value from a
  // funded sender and of withdraw(1e15) from a holder both pass, withdraw from an empty account reverts "burn amount
  // exceeds balance". It emits Transfer mint / burn, not WETH9's Deposit / Withdrawal — activity reads the call.
  99901: {address: "0xbA876237B0F021A6c6D852d6c26E107997cC5E81", symbol: "WHYPE"},
});

const WETH_ABI = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
/** deposit/withdraw on WETH9 cost ~30-45k; a generous cap, the account still estimates. */
const GAS_LIMIT = "90000";

export interface WrapProviderConfig {
  enabled?: boolean;
  /** JSON-RPC endpoints per EVM chain id (on-chain token check + receipt tracking). */
  rpcUrls: Readonly<Record<number, readonly string[]>>;
  /** Override the wrapped tokens (tests, new chains). Still verified on-chain before use. */
  wrapped?: Readonly<Record<number, {address: `0x${string}`; symbol: string}>>;
}

/**
 * Native ↔ wrapped native as a swap2 venue: `deposit()` with value to wrap,
 * `withdraw(amount)` to unwrap. 1:1, no pool, no slippage, no approval. WETH9
 * credits and pays `msg.sender`, so the recipient must be the sender — a wrap
 * "to someone else" is refused rather than silently paid to the wrong place.
 */
export function wrapProvider(config: WrapProviderConfig): CrossChainProvider {
  const wrapped = config.wrapped ?? WRAPPED_NATIVE;
  const verified = new Map<number, Promise<void>>();

  const chainIdOf = (caip2: string): number | null => {
    if (!isEvm(caip2)) return null;
    const id = evmRef(caip2);
    return wrapped[id] && config.rpcUrls[id]?.length ? id : null;
  };

  async function rpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    let lastErr: unknown;
    for (const url of config.rpcUrls[chainId] ?? []) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
          signal: timeoutSignal(10_000),
        });
        // 429 rate_limited (Retry-After), 401 / 403 key_rejected, anything else the node failing.
        if (!res.ok) throw withReason(new Error(`HTTP ${res.status}`), httpRefusal(res.status, res.headers?.get?.("retry-after")) ?? {reason: "upstream_unavailable", httpStatus: res.status});
        const body = (await res.json()) as {result?: unknown; error?: {code?: number; message?: string}};
        // A node's throttling answer (-32005 "limit exceeded", or a 429 code in the body): rate_limited; any other RPC error: upstream_unavailable.
        if (body.error) throw refusal(body.error.code === -32005 || body.error.code === 429 ? "rate_limited" : "upstream_unavailable", body.error.message ?? "rpc error");
        return body.result ?? null;
      } catch (e) {
        lastErr = e;
      }
    }
    // The last endpoint's classification (its HTTP status); a network failure, a timeout or malformed JSON: upstream_unavailable.
    throw withReason(new Error(`wrap: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`), refusalOf(lastErr) ?? {reason: "upstream_unavailable"});
  }

  function verify(chainId: number): Promise<void> {
    let p = verified.get(chainId);
    if (!p) {
      const w = wrapped[chainId]!;
      p = (async () => {
        const read = async (fn: "symbol" | "decimals") =>
          decodeFunctionResult({abi: WETH_ABI, functionName: fn, data: (await rpc(chainId, "eth_call", [{to: w.address, data: encodeFunctionData({abi: WETH_ABI, functionName: fn})}, "latest"])) as Hex});
        const [symbol, decimals] = await Promise.all([read("symbol"), read("decimals")]);
        if (symbol !== w.symbol || Number(decimals) !== 18) throw refusal("vault_mismatch", `wrap: ${w.address} on chain ${chainId} is not ${w.symbol} — refusing`);
      })();
      p.catch(() => verified.delete(chainId));
      verified.set(chainId, p);
    }
    return p;
  }

  return {
    name: "wrap",
    describeActivity: (tx, ctx) => describeWrapActivity(tx, ctx, wrapped),
    supportsSameChain: true,
    enabled: () => config.enabled ?? true,
    supportsChain: (caip2: string) => chainIdOf(caip2) !== null,
    supportsChainPair: (from: string, to: string) => from === to && chainIdOf(from) !== null,
    supportsRoute(from: Asset, to: Asset): boolean {
      return from.chain === to.chain && chainIdOf(from.chain) !== null;
    },

    async getQuote(params: QuoteParams): Promise<Quote | null> {
      // The reason goes to onRefusal next to the text; an unclassified refusal (a developer's bad argument) has none.
      const refuse = (why: string, reason?: Swap2RefusalReason | Swap2RefusalInfo): null => {
        const info = typeof reason === "string" ? {reason} : reason;
        if (info) params.onRefusal?.(`wrap: ${why}`, info);
        else params.onRefusal?.(`wrap: ${why}`);
        return null;
      };
      if (params.flex) return refuse("amount-flexible deposits are not supported", "unsupported_pair");
      if (params.sourceChain !== params.destChain) return refuse("same-chain only", "unsupported_pair");
      const chainId = chainIdOf(params.sourceChain);
      if (chainId === null) return refuse(`no wrapped native token or RPC for ${params.sourceChain}`, "unsupported_pair");
      const w = wrapped[chainId]!;
      const src = ccAsset(params.sourceChain, params.sourceToken);
      if (!src) return refuse(`unknown source token ${params.sourceToken}`, "unsupported_pair");
      const nativeIn = !src.contract;
      const srcIsWrapped = !!src.contract && /^0x[0-9a-fA-F]{40}$/.test(src.contract) && getAddress(src.contract) === getAddress(w.address);
      const nativeOut = /^0x0+$/.test(params.destToken);
      const destIsWrapped = /^0x[0-9a-fA-F]{40}$/.test(params.destToken) && !nativeOut && getAddress(params.destToken) === getAddress(w.address);
      const wrap = nativeIn && destIsWrapped;
      const unwrap = srcIsWrapped && nativeOut;
      if (!wrap && !unwrap) return refuse(`only ${w.symbol.slice(1)} ↔ ${w.symbol}`, "unsupported_pair");
      // WETH9 credits / pays msg.sender: the recipient can only be the sender.
      if (params.refundAddress && /^0x[0-9a-fA-F]{40}$/.test(params.refundAddress) && getAddress(params.refundAddress) !== getAddress(params.destAddress)) {
        return refuse("wrapping pays the sender's own address — send the result separately", "recipient_mismatch");
      }
      let amount: bigint;
      try {
        amount = BigInt(params.amountIn);
      } catch {
        return refuse("amount is not an integer");
      }
      if (amount <= 0n) return refuse("amount must be positive", "amount_too_small");
      if (params.minAmountOut !== undefined && amount < BigInt(params.minAmountOut)) return refuse(`floor breach (min=${amount} < floor=${params.minAmountOut})`, "price_check_failed");
      try {
        await verify(chainId);
      } catch (e) {
        // vault_mismatch for a contract that is not the pinned wrapper; the RPC's own failure; an undecodable answer: upstream_unavailable.
        return refuse(e instanceof Error ? e.message.replace(/^wrap: /, "") : String(e), refusalOf(e) ?? "upstream_unavailable");
      }
      const data = wrap ? encodeFunctionData({abi: WETH_ABI, functionName: "deposit"}) : encodeFunctionData({abi: WETH_ABI, functionName: "withdraw", args: [amount]});
      return {
        provider: "wrap",
        intentId: `wrap:${chainId}`,
        depositAddress: "",
        depositMemo: null,
        txRequest: {to: w.address, data, value: wrap ? amount.toString() : "0", chainId, gasLimit: GAS_LIMIT},
        sourceAmount: amount.toString(),
        destAmount: amount.toString(),
        minDestAmount: amount.toString(),
        feeUsd: 0,
        etaSeconds: 15,
        reliability: 0.995,
        validUntilMs: Date.now() + 5 * 60_000,
        providerData: {action: wrap ? "wrap" : "unwrap", token: w.address},
      };
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx?.to || !tx.data) throw refusal("policy_refused", "swap2: wrap quote has no transaction request");
      return {chain: "", to: tx.to, value: tx.value ?? "0", data: tx.data, ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}), ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {})};
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash) return {state: "pending"};
      const chainId = Number(ref.intentId.split(":")[1]);
      if (!wrapped[chainId] || !config.rpcUrls[chainId]?.length) return {state: "pending"};
      try {
        const receipt = (await rpc(chainId, "eth_getTransactionReceipt", [ref.sourceTxHash])) as {status?: string} | null;
        if (!receipt) return {state: "pending"};
        return receipt.status === "0x1" ? {state: "completed", destTxHash: ref.sourceTxHash} : {state: "failed"};
      } catch {
        return {state: "pending"};
      }
    },
  };
}

/**
 * The reason behind each text {@link wrapVerifyQuote} returns, read back by `wrapPins.reasonOf` so a remote stub's
 * refusal carries it: a pair or route this venue does not serve (`unsupported_pair`), a recipient other than the
 * sender (`recipient_mismatch`), another contract or an approval (`vault_mismatch`), amounts that are not integers
 * (`upstream_unavailable`), any other call, chain, amount or value (`policy_refused`).
 */
const notes = refusalNotes();
const note = notes.note;

/**
 * `read(value)` over a field of the backend's quote. What it throws (an amount that is not an integer, a target that is
 * not an address) is thrown as before; its text is noted (`upstream_unavailable`: an answer of another shape), so the
 * stub's "fails this app's own check" carries the reason.
 */
function shaped<A, R>(read: (value: A) => R, value: A): R {
  try {
    return read(value);
  } catch (e) {
    if (e instanceof Error) note(e.message, "upstream_unavailable");
    throw e;
  }
}

function wrappedFor(chain: string): {address: `0x${string}`; symbol: string} | undefined {
  const id = /^eip155:[0-9]+$/.test(chain) ? Number(chain.slice(7)) : NaN;
  return Object.prototype.hasOwnProperty.call(WRAPPED_NATIVE, id) ? WRAPPED_NATIVE[id] : undefined;
}

/**
 * A remote wrap / unwrap quote, decoded on the device against the app's own request (scan 2026-10-30, F3): native →
 * wrapped is exactly `deposit()` with the input as value; wrapped → native is exactly `withdraw(input)` with no value;
 * on the chain's wrapped native, no approval, and (as WETH9 pays `msg.sender`) a recipient that is the sender. The
 * reason it fails, or null.
 */
export function wrapVerifyQuote(params: QuoteParams, quote: Quote): string | null {
  const w = wrappedFor(params.sourceChain);
  if (!w || params.destChain !== params.sourceChain) return note("not a same-chain wrap on a pinned wrapped native", "unsupported_pair");
  const src = ccAsset(params.sourceChain, params.sourceToken);
  if (!src) return note(`unknown source token ${params.sourceToken}`, "unsupported_pair");
  const nativeIn = !src.contract;
  const srcIsWrapped = !!src.contract && /^0x[0-9a-fA-F]{40}$/.test(src.contract) && getAddress(src.contract) === getAddress(w.address);
  const nativeOut = /^0x0+$/.test(params.destToken);
  const destIsWrapped = /^0x[0-9a-fA-F]{40}$/.test(params.destToken) && !nativeOut && getAddress(params.destToken) === getAddress(w.address);
  const wrap = nativeIn && destIsWrapped;
  if (!wrap && !(srcIsWrapped && nativeOut)) return note(`only ${w.symbol.slice(1)} ↔ ${w.symbol}`, "unsupported_pair");
  if (params.refundAddress && /^0x[0-9a-fA-F]{40}$/.test(params.refundAddress) && (!/^0x[0-9a-fA-F]{40}$/.test(params.destAddress) || getAddress(params.refundAddress) !== getAddress(params.destAddress))) {
    return note("wrapping pays the sender's own address", "recipient_mismatch");
  }
  const tx = quote.txRequest;
  if (!tx?.data || !tx.to || tx.serializedTx !== undefined) return note("the quote carries no wrapped-native call", "policy_refused");
  if (shaped(getAddress, tx.to) !== getAddress(w.address)) return note(`the call targets ${tx.to}, not ${w.symbol}`, "vault_mismatch");
  if (tx.approvalAddress !== undefined) return note("a wrap approves nothing", "vault_mismatch");
  if (tx.chainId !== undefined && `eip155:${tx.chainId}` !== params.sourceChain) return note(`the call is for chain ${tx.chainId}`, "policy_refused");
  let amount: bigint, value: bigint;
  try {
    amount = BigInt(params.amountIn);
    value = BigInt(tx.value ?? "0");
  } catch {
    return note("the request does not name amounts", "upstream_unavailable");
  }
  if (shaped(BigInt, quote.sourceAmount) !== amount) return note(`the quote moves ${quote.sourceAmount}, not the ${amount} input`, "policy_refused");
  let call: {functionName: string; args?: readonly unknown[]};
  try {
    call = decodeFunctionData({abi: WETH_ABI, data: tx.data as Hex});
  } catch {
    return note("the call is neither deposit() nor withdraw(amount)", "policy_refused");
  }
  if (wrap) {
    if (call.functionName !== "deposit" || tx.data.length !== 10) return note(`${call.functionName} is not deposit()`, "policy_refused");
    if (value !== amount) return note(`deposit() attaches ${value}, not the ${amount} input`, "policy_refused");
  } else {
    if (call.functionName !== "withdraw") return note(`${call.functionName} is not withdraw(amount)`, "policy_refused");
    if (call.args?.[0] !== amount) return note(`withdraw(${String(call.args?.[0])}) is not the ${amount} input`, "policy_refused");
    if (value !== 0n) return note("withdraw attaches no value", "policy_refused");
  }
  return null;
}

/**
 * The wrapped-native contract a wrap / unwrap calls on a chain (no spender: neither approves), and
 * {@link wrapVerifyQuote} — the app's pins for `remoteProvider({name: "wrap", baseUrl, ...wrapPins})` (scan
 * 2026-10-27 modules, F8/F16; the call itself since scan 2026-10-30, F3).
 */
export const wrapPins: RemotePins = Object.freeze({
  callTargets: (chain: string): readonly string[] => {
    const w = wrappedFor(chain);
    return w ? [w.address] : [];
  },
  spenders: (): readonly string[] => [],
  verifyQuote: wrapVerifyQuote,
  reasonOf: notes.reasonOf,
});
