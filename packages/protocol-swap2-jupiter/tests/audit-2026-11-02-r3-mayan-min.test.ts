// The engine took a bridge's destination decimals from the asset catalog only, and serializedGuardFromExecution dropped
// the reviewed minimum without them. A token the catalog does not list (any 0x address passed as the destination) thus
// left a Mayan order's minimum unchecked: amountOutMin = 1 passed. The quote's own decimals (LI.FI's
// action.toToken.decimals) now fill the gap, and a Mayan order with no reviewed minimum or token is refused.
import {describe, expect, it} from "vitest";
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getAddressEncoder, getBase64EncodedWireTransaction,
  pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address, type Instruction, type Transaction, type TransactionMessage,
} from "@solana/kit";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {SerializedExecutionExpectation} from "@anywalletkit/protocol-swap2-core";
import type {CrossChainProvider, Quote} from "@anywalletkit/protocol-swap2-core/types";
import {WalletManagerSolana, serializedGuardFromExecution, type SolanaRpc} from "@anywalletkit/wallet-solana";

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
const INPUT = 9_000_000n;
const MIN = 8_955_000n;
/** A Base token the asset catalog does not list (18 decimals), and its quoted minimum. */
const UNLISTED = `0x${"ab".repeat(20)}`;
const MIN_OUT = 4_321_000_000_000_000_000n;

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
/** TransferChecked of the input into the order's vault, then a Swift order paying RECIPIENT at least `min` of `tokenOut`. */
function bridgeWire(tokenOut: string, min: bigint): string {
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
async function swap(wire: string, destDecimals?: number) {
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
  const outcome = await new P(account as never, {fromChain: "solana:mainnet", skipAccountChainCheck: true} as never)
    .swap2({fromToken: "USDC", toToken: UNLISTED, toChain: 8453, recipient: RECIPIENT, fromTokenAmount: INPUT, minAmountOut: MIN_OUT, slippage: 0.005} as never)
    .then(() => "sent", (e: unknown) => String((e as {code?: string; cause?: {code?: string}}).cause?.code ?? (e as {code?: string}).code ?? e));
  return {outcome, seen, sent: f.sent};
}

describe("audit 2026-11-02 r3: a Mayan order to a token the catalog does not list is still held to the reviewed minimum", () => {
  it("the quote's decimals reach bridgeOut, so an order asking for 1 base unit is refused and the real minimum passes", async () => {
    const short = await swap(bridgeWire(UNLISTED, 1n), 18);
    expect(short.seen[0]!.bridgeOut).toEqual({destChain: "eip155:8453", recipient: RECIPIENT, destToken: UNLISTED, minAmountOut: MIN_OUT.toString(), destDecimals: 18, slippageBps: 50});
    expect(short.outcome).toMatch(/bridge-min/);
    expect(short.sent).toHaveLength(0);
    // Mayan keeps 8 decimals: the reviewed minimum at that precision.
    const real = await swap(bridgeWire(UNLISTED, MIN_OUT / 10n ** 10n), 18);
    expect(real.outcome).toBe("sent");
    expect(real.sent).toHaveLength(1);
  });

  it("without decimals from the catalog or the quote the order has no reviewed minimum and is refused, not passed", async () => {
    const unknown = await swap(bridgeWire(UNLISTED, MIN_OUT / 10n ** 10n));
    expect(unknown.seen[0]!.bridgeOut).not.toHaveProperty("destDecimals");
    expect(serializedGuardFromExecution(unknown.seen[0]!).expect.bridgeOut).not.toHaveProperty("minAmountOut");
    expect(unknown.outcome).toMatch(/bridge-min/);
    expect(unknown.sent).toHaveLength(0);
    // Out-of-range decimals from a provider are ignored, as if missing.
    expect((await swap(bridgeWire(UNLISTED, MIN_OUT / 10n ** 10n), 99)).outcome).toMatch(/bridge-min/);
  });

  it("a guard that names no destination token refuses the order too", async () => {
    const f = fakeRpc({[ADDR0]: sys(10n ** 9n), [MY_USDC]: tokenAccount(USDC, ADDR0, 100_000_000n), [VAULT]: tokenAccount(USDC, STATE, 0n)});
    const solana = await new WalletManagerSolana(SEED, {provider: f.rpc}).getAccount(0);
    const expect_ = {maxLamportsOut: 20_000_000n, maxTokenOut: {mint: USDC, amount: INPUT}};
    const wire = bridgeWire(BASE_USDC, MIN);
    await expect(solana.checkSerialized(wire, {expect: {...expect_, bridgeOut: {destChain: "eip155:8453", recipient: RECIPIENT, minAmountOut: MIN, destDecimals: 6}}})).rejects.toMatchObject({code: "bridge-token"});
    await expect(solana.checkSerialized(wire, {expect: {...expect_, bridgeOut: {destChain: "eip155:8453", recipient: RECIPIENT, destToken: BASE_USDC}}})).rejects.toMatchObject({code: "bridge-min"});
    await expect(solana.checkSerialized(wire, {expect: {...expect_, bridgeOut: {destChain: "eip155:8453", recipient: RECIPIENT, destToken: BASE_USDC, minAmountOut: MIN, destDecimals: 6}}})).resolves.toBeDefined();
  });
});
