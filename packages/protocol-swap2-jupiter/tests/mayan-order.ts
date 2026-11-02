// A Solana USDC → Base Mayan Swift order built byte by byte, and a swap2 run of it through the engine and
// wallet-solana's guard with a fake RPC: what the account was handed and whether the order was sent.
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getAddressEncoder, getBase64EncodedWireTransaction,
  pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address, type Instruction, type Transaction, type TransactionMessage,
} from "@solana/kit";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {SerializedExecutionExpectation} from "@anywalletkit/protocol-swap2-core";
import type {CrossChainProvider, Quote} from "@anywalletkit/protocol-swap2-core/types";
import {WalletManagerSolana, serializedGuardFromExecution, type SolanaRpc} from "@anywalletkit/wallet-solana";

export const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const ADDR0 = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk" as Address;
export const STATE = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo" as Address;
export const VAULT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" as Address;
export const MY_USDC = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address;
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const SWIFT_V2 = "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny" as Address;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const RECIPIENT = "0x3333333333333333333333333333333333333333";
export const INPUT = 9_000_000n;
export const MIN = 8_955_000n;
/** A Base token the asset catalog does not list (18 decimals), and its quoted minimum. */
export const UNLISTED = `0x${"ab".repeat(20)}`;
export const MIN_OUT = 4_321_000_000_000_000_000n;

type State = {lamports: bigint; owner: string; data: Uint8Array} | null;
export const sys = (lamports: bigint): State => ({lamports, owner: "11111111111111111111111111111111", data: new Uint8Array()});
export function tokenAccount(mint: string, owner: string, amount: bigint): State {
  const data = new Uint8Array(165); data.set(getAddressEncoder().encode(mint as Address), 0); data.set(getAddressEncoder().encode(owner as Address), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true); data[108] = 1;
  return {lamports: 2_039_280n, owner: TOKEN, data};
}
const toRpc = (s: State) => (s ? {lamports: s.lamports, owner: s.owner, data: [Buffer.from(s.data).toString("base64"), "base64"], executable: false, rentEpoch: 0n, space: BigInt(s.data.length)} : null);
export function fakeRpc(pre: Record<string, State>) {
  const sent: string[] = [];
  const h: Record<string, (...a: unknown[]) => unknown> = {
    getMultipleAccounts: (addrs) => ({value: (addrs as string[]).map((a) => toRpc(pre[a] ?? null))}),
    simulateTransaction: (_w, cfg) => ({value: {err: null, unitsConsumed: 1000n, logs: [], accounts: (cfg as {accounts: {addresses: string[]}}).accounts.addresses.map((a) => toRpc(pre[a] ?? null))}}),
    getFeeForMessage: () => ({value: 5000n}),
    sendTransaction: (w) => { sent.push(w as string); return "B".repeat(87); },
  };
  const rpc = new Proxy({} as SolanaRpc, {get: (_t, m: string) => (...args: unknown[]) => ({send: async () => { const f = h[m]; if (!f) throw new Error(`unmocked ${m}`); return f(...args); }})});
  return {rpc, sent};
}
/** TransferChecked of the input into the order's vault, then a Swift order paying RECIPIENT at least `min` of `tokenOut`. */
export function bridgeWire(tokenOut: string, min: bigint): string {
  const transfer = new Uint8Array(10); transfer[0] = 12; new DataView(transfer.buffer).setBigUint64(1, INPUT, true); transfer[9] = 6;
  const order = new Uint8Array(198); const v = new DataView(order.buffer);
  order.set(Buffer.from("204c290c27a284db", "hex"), 0);
  v.setBigUint64(8, INPUT, true);
  order.set(Buffer.from(RECIPIENT.slice(2).toLowerCase().padStart(64, "0"), "hex"), 25);
  v.setUint16(57, 30, true);
  order.set(Buffer.from(tokenOut.slice(2).toLowerCase().padStart(64, "0"), "hex"), 59);
  v.setBigUint64(91, min, true);
  const w = (address: Address) => ({address, role: AccountRole.WRITABLE});
  const ixs: Instruction[] = [
    {programAddress: TOKEN, accounts: [w(MY_USDC), {address: USDC, role: AccountRole.READONLY}, w(VAULT), {address: ADDR0, role: AccountRole.READONLY_SIGNER}], data: transfer},
    {programAddress: SWIFT_V2, accounts: [{address: ADDR0, role: AccountRole.WRITABLE_SIGNER}, {address: ADDR0, role: AccountRole.WRITABLE_SIGNER}, w(STATE), w(VAULT), w(MY_USDC), {address: USDC, role: AccountRole.READONLY}], data: order},
  ];
  const msg = pipe(createTransactionMessage({version: 0}), (x) => setTransactionMessageFeePayer(ADDR0, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({blockhash: "9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6" as never, lastValidBlockHeight: 100n}, x),
    (x) => appendTransactionMessageInstructions(ixs, x)) as TransactionMessage;
  return getBase64EncodedWireTransaction(compileTransaction(msg as never) as Transaction);
}

/** A provider quoting Solana USDC → `UNLISTED` on Base (18 decimals; MIN_OUT is its minimum) with `wire`, reporting `destDecimals`. */
function bridgeProvider(wire: string, destDecimals?: number): CrossChainProvider {
  return {
    name: "mayan-test", enabled: () => true, supportsRoute: () => true,
    getQuote: async (params): Promise<Quote> => ({
      provider: "mayan-test", intentId: "i", depositAddress: "", depositMemo: null, txRequest: {serializedTx: wire, value: "0"},
      sourceAmount: params.amountIn, destAmount: (MIN_OUT + 1n).toString(), minDestAmount: MIN_OUT.toString(), ...(destDecimals !== undefined ? {destDecimals} : {}),
      feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + 60_000,
    }),
    buildDeposit: async (q) => ({chain: "solana:mainnet", to: "", value: "0", serializedTx: q.txRequest!.serializedTx!}),
    trackIntent: async () => ({state: "pending"}),
  };
}
/**
 * swap2 of INPUT Solana USDC → `toToken` on Base (default UNLISTED) at MIN_OUT, the quote reporting `destDecimals` and
 * the caller passing `toTokenDecimals` when given: whether it was sent (else the error's code and message), and the
 * expectation the account was handed.
 */
export async function swap(wire: string, destDecimals?: number, extra: {toTokenDecimals?: number; toToken?: string} = {}) {
  const f = fakeRpc({[ADDR0]: sys(10n ** 9n), [MY_USDC]: tokenAccount(USDC, ADDR0, 100_000_000n), [VAULT]: tokenAccount(USDC, STATE, 0n)});
  const solana = await new WalletManagerSolana(SEED, {provider: f.rpc}).getAccount(0);
  const seen: SerializedExecutionExpectation[] = [];
  const account = {
    getAddress: async () => ADDR0,
    sendTransaction: async () => { throw new Error("a serialized leg never sends a plain transaction"); },
    transfer: async () => { throw new Error("a serialized leg never transfers"); },
    sendSerializedTransaction: async (tx: string, e: SerializedExecutionExpectation) => { seen.push(e); return solana.sendSerialized(tx, serializedGuardFromExecution(e)); },
  };
  const provider = bridgeProvider(wire, destDecimals);
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  let message = "";
  const outcome = await new P(account as never, {fromChain: "solana:mainnet", skipAccountChainCheck: true} as never)
    .swap2({fromToken: "USDC", toToken: extra.toToken ?? UNLISTED, toChain: 8453, recipient: RECIPIENT, fromTokenAmount: INPUT, minAmountOut: MIN_OUT, slippage: 0.005,
      ...(extra.toTokenDecimals !== undefined ? {toTokenDecimals: extra.toTokenDecimals} : {})} as never)
    .then(() => "sent", (e: unknown) => {
      message = String((e as {message?: string}).message ?? e);
      return String((e as {code?: string; cause?: {code?: string}}).cause?.code ?? (e as {code?: string}).code ?? e);
    });
  return {outcome, message, seen, sent: f.sent};
}

