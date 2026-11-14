/**
 * Self-built fixtures in the shape of the 0x Swap API v2 (Permit2 flow) and of Settler calldata, matching the real
 * answers recorded in fixtures/quotes/ (allowanceTarget = Permit2 on every answer, native sales opening with
 * NATIVE_CHECK). Nothing here was recorded with a key; the key the stubs see is the placeholder below.
 */
import {hashTypedData} from "viem";
import {vi} from "vitest";
import {ZEROEX_NATIVE, ZEROEX_PERMIT2, ZEROEX_SETTLER_REGISTRY} from "../src/chains.js";
import {REGISTRY_OWNER_OF_SELECTOR, REGISTRY_PREV_SELECTOR, SETTLER_EXECUTE_SELECTOR, SETTLER_NATIVE_CHECK_SELECTOR, zeroExSettlerAddress} from "../src/settler.js";

export const ZERO = "0x0000000000000000000000000000000000000000";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base
export const DAI = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"; // Base
export const WETH = "0x4200000000000000000000000000000000000006";
export const ME = "0x4444444444444444444444444444444444444444";
export const OTHER = "0x9999999999999999999999999999999999999999";
/**
 * What the registry answers on Base: deployments 22 (in force on 2026-11-15), 21 (the one it replaced) and 23 (the next
 * one). Real Settlers rotate and none is pinned, but every one is an address the registry deploys to.
 */
export const SETTLER = zeroExSettlerAddress(8453, 22);
export const PREV_SETTLER = zeroExSettlerAddress(8453, 21);
export const NEW_SETTLER = zeroExSettlerAddress(8453, 23);
export const RPC = {8453: ["https://rpc.test"]};
/** A placeholder, not a key. */
export const KEY = "placeholder-key-for-tests";
export const getKey = (): string => KEY;
export const NONCE = 2241959297937691820908574931991575n;
export const AMOUNT = 1_000_000n;
export const OUT = 400_000_000_000_000n;

export const word = (v: bigint | number | string): string => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase() : v.toString(16)).padStart(64, "0");
const padded = (hex: string): string => hex + "0".repeat((64 - (hex.length % 64)) % 64);
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const TRANSFER_FROM = "0xc1fb425e";
export const UNISWAPV3_VIP = "0x3036d6a6";
export const BASIC = "0x38c9c147";

export interface Permit {token: string; amount: bigint; nonce: bigint; deadline: bigint}

/** `TRANSFER_FROM(recipient, permit, sig)` with the signature slot pointing just past its own head — where the signature is appended. */
export function transferFromAction(permit: Permit, over: {recipient?: string; sigOffset?: number} = {}): string {
  return TRANSFER_FROM.slice(2) + word(over.recipient ?? SETTLER) + word(permit.token) + word(permit.amount) + word(permit.nonce) + word(permit.deadline) + word(over.sigOffset ?? 0xc0);
}
/** `UNISWAPV3_VIP(recipient, permit, path, sig, amountOutMin)`: the path sits before the appended signature. */
export function uniswapV3VipAction(permit: Permit, path = "ab".repeat(43)): string {
  const tail = word(path.length / 2) + padded(path);
  return UNISWAPV3_VIP.slice(2) + word(SETTLER) + word(permit.token) + word(permit.amount) + word(permit.nonce) + word(permit.deadline) + word(0x100) + word(0x100 + tail.length / 2) + word(0) + tail;
}
/** Any later action: a selector and opaque arguments. */
export const opaqueAction = (selector = BASIC, words = 3): string => selector.slice(2) + "11".repeat(32 * words);
/** `NATIVE_CHECK(deadline, msgValue)`: action 0 of every native-coin sale. */
export const nativeCheckAction = (deadline: bigint, msgValue: bigint): string => SETTLER_NATIVE_CHECK_SELECTOR.slice(2) + word(deadline) + word(msgValue);

export interface Execute {
  recipient: string;
  buyToken: string;
  min: bigint;
  /** Action 0, hex without 0x. Laid out last, as 0x does, so a signature can be appended to it. */
  first: string;
  /** Declared length of action 0; 0x declares more than is there for a Permit2 payment. */
  firstLength?: number;
  later?: string[];
  zid?: string;
}
/** `Settler.execute(slippage, actions, zidAndAffiliate)` in 0x's own layout: later actions first, action 0 at the end. */
export function executeData(e: Execute): string {
  const later = e.later ?? [opaqueAction()];
  const count = 1 + later.length;
  let tail = "";
  const offsets: number[] = [];
  for (const action of later) {
    offsets.push(32 * count + tail.length / 2);
    tail += word(action.length / 2) + padded(action);
  }
  const firstOffset = 32 * count + tail.length / 2;
  tail += word(e.firstLength ?? e.first.length / 2) + e.first;
  return SETTLER_EXECUTE_SELECTOR + word(e.recipient) + word(e.buyToken) + word(e.min) + word(0xa0) + word(e.zid ?? "ab".repeat(16)) + word(count) + word(firstOffset) + offsets.map(word).join("") + tail;
}

export function permit2Typed(o: {chainId?: number; token?: string; amount?: bigint; spender?: string; nonce?: bigint; deadline?: bigint} = {}) {
  return {
    types: {
      EIP712Domain: [{name: "name", type: "string"}, {name: "chainId", type: "uint256"}, {name: "verifyingContract", type: "address"}],
      PermitTransferFrom: [{name: "permitted", type: "TokenPermissions"}, {name: "spender", type: "address"}, {name: "nonce", type: "uint256"}, {name: "deadline", type: "uint256"}],
      TokenPermissions: [{name: "token", type: "address"}, {name: "amount", type: "uint256"}],
    },
    domain: {name: "Permit2", chainId: o.chainId ?? 8453, verifyingContract: ZEROEX_PERMIT2 as string},
    message: {
      permitted: {token: (o.token ?? USDC).toLowerCase(), amount: (o.amount ?? AMOUNT).toString()},
      spender: (o.spender ?? SETTLER).toLowerCase(),
      nonce: (o.nonce ?? NONCE).toString(),
      deadline: (o.deadline ?? BigInt(nowSeconds() + 300)).toString(),
    },
    primaryType: "PermitTransferFrom",
  };
}
export type Typed = ReturnType<typeof permit2Typed>;
export function permit2Hash(t: Typed): string {
  return hashTypedData({
    domain: {...t.domain, verifyingContract: t.domain.verifyingContract as `0x${string}`},
    types: {PermitTransferFrom: t.types.PermitTransferFrom, TokenPermissions: t.types.TokenPermissions},
    primaryType: "PermitTransferFrom",
    message: {permitted: {token: t.message.permitted.token as `0x${string}`, amount: BigInt(t.message.permitted.amount)}, spender: t.message.spender as `0x${string}`, nonce: BigInt(t.message.nonce), deadline: BigInt(t.message.deadline)},
  });
}

export interface ApiStub {
  /** `buyAmount` the "API" answers. */
  out?: bigint;
  /** The Settler the "API" quotes. */
  settler?: string;
  /** What the registry answers for `ownerOf(2)` / `prev(2)`; `null` = the call reverts. */
  registry?: {current?: string | null; prev?: string | null};
  /** Called once per registry `ownerOf` read; lets a test rotate the Settler between reads. */
  onRegistryRead?: (read: number) => {current?: string | null; prev?: string | null} | undefined;
  http?: number;
  /** Body for a non-2xx answer. */
  error?: unknown;
  /** Rewrite the answer (a compromised or buggy endpoint). */
  tamper?: (body: Record<string, any>, ctx: {query: URLSearchParams; path: string}) => unknown;
  /** Raw text instead of a JSON body. */
  raw?: string;
  zeroExFee?: {amount: string; token: string; type?: string} | null;
  first?: "transferFrom" | "uniswapV3";
  receipt?: unknown;
  calls?: {url: string; method: string; headers: Record<string, string>; body?: unknown}[];
  rpcDown?: boolean;
}

/** The body 0x would answer for this request, in the documented shape. */
export function apiAnswer(path: string, query: URLSearchParams, o: ApiStub = {}): Record<string, any> {
  const sellToken = query.get("sellToken")!;
  const buyToken = query.get("buyToken")!;
  const sellAmount = BigInt(query.get("sellAmount")!);
  const bps = BigInt(query.get("slippageBps") ?? "100");
  const taker = query.get("taker");
  const recipient = query.get("recipient") ?? taker ?? ZERO;
  const buyAmount = o.out ?? OUT;
  const min = (buyAmount * (10_000n - bps)) / 10_000n;
  const nativeSell = sellToken.toLowerCase() === ZEROEX_NATIVE.toLowerCase();
  const settler = o.settler ?? SETTLER;
  const common = {
    allowanceTarget: ZEROEX_PERMIT2,
    blockNumber: "38000000",
    buyAmount: buyAmount.toString(),
    buyToken: buyToken.toLowerCase(),
    fees: {integratorFee: null, integratorFees: null, zeroExFee: o.zeroExFee === undefined ? {amount: "600000000000", token: buyToken.toLowerCase(), type: "volume"} : o.zeroExFee, gasFee: null},
    issues: {allowance: nativeSell ? null : {actual: "0", spender: ZEROEX_PERMIT2}, balance: null, simulationIncomplete: false, invalidSourcesPassed: []},
    liquidityAvailable: true,
    minBuyAmount: min.toString(),
    mode: "exact-in",
    route: {fills: [{from: sellToken, to: buyToken, source: "Uniswap_V3", proportionBps: "7000"}, {from: sellToken, to: buyToken, source: "Aerodrome_V3", proportionBps: "3000"}], tokens: []},
    sellAmount: sellAmount.toString(),
    sellToken: sellToken.toLowerCase(),
    tokenMetadata: {buyToken: {buyTaxBps: "0", sellTaxBps: "0", transferTaxBps: "0"}, sellToken: {buyTaxBps: "0", sellTaxBps: "0", transferTaxBps: "0"}},
    totalNetworkFee: "3150000000000",
    zid: "0x111111111111111111111111",
  };
  if (path.endsWith("/price")) return {...common, gas: "210000", gasPrice: "15000000"};
  const deadline = BigInt(nowSeconds() + 300);
  const permit: Permit = {token: sellToken, amount: sellAmount, nonce: NONCE, deadline};
  const typed = permit2Typed({chainId: Number(query.get("chainId")), token: sellToken, amount: sellAmount, spender: settler, deadline});
  const first = nativeSell ? nativeCheckAction(deadline, sellAmount) : o.first === "uniswapV3" ? uniswapV3VipAction(permit) : transferFromAction(permit, {recipient: settler});
  const data = executeData({recipient, buyToken, min, first, ...(nativeSell ? {} : {firstLength: 0xffff})});
  return {
    ...common,
    permit2: nativeSell ? null : {type: "Permit2", hash: permit2Hash(typed), eip712: typed},
    transaction: {to: settler.toLowerCase(), data, gas: "210000", gasPrice: "15000000", value: nativeSell ? sellAmount.toString() : "0"},
  };
}

/** One `fetch` for both sides: the 0x API (GET) and the chain's JSON-RPC (POST). */
export function stub(o: ApiStub = {}): typeof fetch {
  let registryReads = 0;
  let registry = o.registry ?? {};
  const rpcAnswer = (result: unknown) => new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result}));
  const revert = () => new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error: {code: 3, message: "execution reverted"}}));
  return vi.fn(async (input: string | URL, init?: {method?: string; body?: string; headers?: Record<string, string>}) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = JSON.parse(init!.body!) as {method: string; params: [{to?: string; data?: string}]};
      o.calls?.push({url, method, headers: init?.headers ?? {}, body});
      if (o.rpcDown) return new Response("bad gateway", {status: 502});
      if (body.method === "eth_call") {
        const call = body.params[0];
        if (call.to?.toLowerCase() !== ZEROEX_SETTLER_REGISTRY.toLowerCase()) return rpcAnswer("0x");
        if (call.data?.startsWith(REGISTRY_OWNER_OF_SELECTOR)) {
          registry = o.onRegistryRead?.(++registryReads) ?? registry;
          const current = registry.current === undefined ? SETTLER : registry.current;
          return current === null ? revert() : rpcAnswer(`0x${word(current)}`);
        }
        if (call.data?.startsWith(REGISTRY_PREV_SELECTOR)) {
          const prev = registry.prev === undefined ? PREV_SETTLER : registry.prev;
          return prev === null ? revert() : rpcAnswer(`0x${word(prev)}`);
        }
        return rpcAnswer("0x");
      }
      if (body.method === "eth_getTransactionReceipt") return rpcAnswer(o.receipt === undefined ? {status: "0x1"} : o.receipt);
      return new Response("{}", {status: 404});
    }
    o.calls?.push({url, method, headers: init?.headers ?? {}});
    const parsed = new URL(url);
    if (o.http) return new Response(JSON.stringify(o.error ?? {}), {status: o.http});
    if (o.raw !== undefined) return new Response(o.raw);
    let body: unknown = apiAnswer(parsed.pathname, parsed.searchParams, o);
    if (o.tamper) body = o.tamper(body as Record<string, any>, {query: parsed.searchParams, path: parsed.pathname});
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
}
