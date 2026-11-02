// The engine hands a cross-chain serialized leg `bridgeOut` (recipient, chain, reviewed token and minimum), but an app
// mapping the hook onto wallet-solana's `sendSerialized` by hand could drop it — and a guard without bridgeOut checks
// only the SOL ceiling, so a Mayan order paying someone else passed through the real app path. wallet-solana now ships
// `serializedGuardFromExecution`, the mapping that carries every field; this runs a full engine → account bridge leg
// through it (the only package with both the engine and wallet-solana at hand).
import {describe, expect, it} from "vitest";
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getAddressEncoder, getBase64EncodedWireTransaction,
  pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address, type Instruction, type Transaction, type TransactionMessage,
} from "@solana/kit";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {SerializedExecutionExpectation} from "@anywalletkit/protocol-swap2-core";
import type {CrossChainProvider, Quote} from "@anywalletkit/protocol-swap2-core/types";
import {WalletManagerSolana, serializedGuardFromExecution, type SerializedExecutionInput, type SolanaRpc} from "@anywalletkit/wallet-solana";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ADDR0 = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk" as Address;
const STATE = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo" as Address;
const VAULT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" as Address;
const MY_USDC = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const SWIFT_V2 = "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny" as Address;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const OTHER = `0x${"66".repeat(20)}`;
const INPUT = 9_000_000n;
const MIN = 8_955_000n;

type State = {lamports: bigint; owner: string; data: Uint8Array} | null;
const sys = (lamports: bigint): State => ({lamports, owner: "11111111111111111111111111111111", data: new Uint8Array()});
function tokenAccount(mint: string, owner: string, amount: bigint): State {
  const data = new Uint8Array(165); data.set(getAddressEncoder().encode(mint as Address), 0); data.set(getAddressEncoder().encode(owner as Address), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true); data[108] = 1;
  return {lamports: 2_039_280n, owner: TOKEN, data};
}
const toRpc = (s: State) => (s ? {lamports: s.lamports, owner: s.owner, data: [Buffer.from(s.data).toString("base64"), "base64"], executable: false, rentEpoch: 0n, space: BigInt(s.data.length)} : null);
function fakeRpc(pre: Record<string, State>) {
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
/** TransferChecked (tag 12) of the input into the order's vault, then a Swift order paying `recipient` at least `min` of Base USDC. */
function bridgeWire(recipient: string, min: bigint): string {
  const transfer = new Uint8Array(10); transfer[0] = 12; new DataView(transfer.buffer).setBigUint64(1, INPUT, true); transfer[9] = 6;
  const order = new Uint8Array(198); const v = new DataView(order.buffer);
  order.set(Buffer.from("204c290c27a284db", "hex"), 0);
  v.setBigUint64(8, INPUT, true);
  order.set(Buffer.from(recipient.slice(2).toLowerCase().padStart(64, "0"), "hex"), 25);
  v.setUint16(57, 30, true);
  order.set(Buffer.from(BASE_USDC.slice(2).toLowerCase().padStart(64, "0"), "hex"), 59);
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

/** A provider quoting Solana USDC → Base USDC with `wire` as its serialized transaction. */
function bridgeProvider(wire: string): CrossChainProvider {
  return {
    name: "mayan-test", enabled: () => true, supportsRoute: () => true,
    getQuote: async (params): Promise<Quote> => ({
      provider: "mayan-test", intentId: "i", depositAddress: "", depositMemo: null, txRequest: {serializedTx: wire, value: "0"},
      sourceAmount: params.amountIn, destAmount: "9000000", minDestAmount: MIN.toString(), feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + 60_000,
    }),
    buildDeposit: async (q) => ({chain: "solana:mainnet", to: "", value: "0", serializedTx: q.txRequest!.serializedTx!}),
    trackIntent: async () => ({state: "pending"}),
  };
}
async function swap(wire: string, map: (e: SerializedExecutionExpectation) => Parameters<Awaited<ReturnType<WalletManagerSolana["getAccount"]>>["sendSerialized"]>[1]) {
  const f = fakeRpc({[ADDR0]: sys(10n ** 9n), [MY_USDC]: tokenAccount(USDC, ADDR0, 100_000_000n), [VAULT]: tokenAccount(USDC, STATE, 0n)});
  const solana = await new WalletManagerSolana(SEED, {provider: f.rpc}).getAccount(0);
  const seen: SerializedExecutionExpectation[] = [];
  const account = {
    getAddress: async () => ADDR0,
    sendTransaction: async () => { throw new Error("a serialized leg never sends a plain transaction"); },
    transfer: async () => { throw new Error("a serialized leg never transfers"); },
    sendSerializedTransaction: async (tx: string, e: SerializedExecutionExpectation) => { seen.push(e); return solana.sendSerialized(tx, map(e)); },
  };
  const provider = bridgeProvider(wire);
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  const outcome = await new P(account as never, {fromChain: "solana:mainnet", skipAccountChainCheck: true} as never)
    .swap2({fromToken: "USDC", toToken: BASE_USDC, toChain: 8453, recipient: RECIPIENT, fromTokenAmount: INPUT, minAmountOut: MIN, slippage: 0.005} as never)
    .then(() => "sent", (e: unknown) => String((e as {code?: string; cause?: {code?: string}}).cause?.code ?? (e as {code?: string}).code ?? e));
  return {outcome, seen, sent: f.sent};
}
const byHand = (e: SerializedExecutionExpectation) => ({
  expect: {
    maxLamportsOut: BigInt(e.maxValueOut),
    ...(e.tokenIn ? {tokenIn: {mint: e.tokenIn.token, minAmount: BigInt(e.tokenIn.minAmount)}} : {}),
    ...(e.source ? {maxTokenOut: {mint: e.source.token, amount: BigInt(e.source.maxAmount)}} : {}),
  },
});

describe("audit 2026-11-02 r2: a cross-chain serialized leg reaches the Solana guard with bridgeOut", () => {
  it("the engine always sets bridgeOut with the reviewed terms, and the helper carries all of it", async () => {
    const {outcome, seen, sent} = await swap(bridgeWire(RECIPIENT, MIN), serializedGuardFromExecution);
    expect(outcome).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(seen[0]!.bridgeOut).toEqual({destChain: "eip155:8453", recipient: RECIPIENT, destToken: BASE_USDC, minAmountOut: MIN.toString(), destDecimals: 6, slippageBps: 50});
    const e: SerializedExecutionInput = seen[0]!;
    expect(serializedGuardFromExecution(e).expect.bridgeOut).toEqual({destChain: "eip155:8453", recipient: RECIPIENT, destToken: BASE_USDC, minAmountOut: MIN, destDecimals: 6, slippageBps: 50});
  });

  it("an order paying someone else, or for less than reviewed, is refused through the helper — not through a hand mapping that drops bridgeOut", async () => {
    const theft = bridgeWire(OTHER, MIN);
    const viaHelper = await swap(theft, serializedGuardFromExecution);
    expect(viaHelper.sent).toHaveLength(0);
    expect(viaHelper.outcome).toMatch(/bridge-recipient/);
    const short = await swap(bridgeWire(RECIPIENT, 1n), serializedGuardFromExecution);
    expect(short.sent).toHaveLength(0);
    expect(short.outcome).toMatch(/bridge-min/);
    // The control: the same theft through a mapping without bridgeOut is only held to the SOL ceiling and is signed.
    const dropped = await swap(theft, byHand);
    expect(dropped.outcome).toBe("sent");
  });

  it("the helper keeps today's behaviour for same-chain legs and refuses a malformed amount", () => {
    expect(serializedGuardFromExecution({maxValueOut: "70000000", tokenIn: {token: USDC, minAmount: "980000"}})).toEqual({expect: {maxLamportsOut: 70_000_000n, tokenIn: {mint: USDC, minAmount: 980_000n}}});
    expect(serializedGuardFromExecution({maxValueOut: "1", bridgeOut: {destChain: "eip155:1", recipient: RECIPIENT, destToken: BASE_USDC, minAmountOut: "5"}}).expect.bridgeOut).toEqual({destChain: "eip155:1", recipient: RECIPIENT, destToken: BASE_USDC});
    expect(serializedGuardFromExecution({maxValueOut: "1"}, {programAllowlist: [TOKEN]})).toMatchObject({programAllowlist: [TOKEN]});
    expect(() => serializedGuardFromExecution({maxValueOut: "-1"})).toThrow(/maxValueOut/);
    expect(() => serializedGuardFromExecution({maxValueOut: "1", bridgeOut: {destChain: "eip155:1", recipient: RECIPIENT, minAmountOut: "1.5", destDecimals: 6}})).toThrow(/minAmountOut/);
  });
});
