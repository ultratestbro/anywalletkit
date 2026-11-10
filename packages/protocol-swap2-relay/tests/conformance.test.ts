import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";
import {hashStruct} from "viem";
import {afterEach, beforeEach, vi} from "vitest";
import {RelaySwap2Protocol} from "../src/protocol.js";
import {loadQuote, protoOf, type QuoteFixture} from "./fixtures.js";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

describeProtocolModule("protocol-swap2-relay", {
  type: "swap2",
  activity,
  Protocol: RelaySwap2Protocol,
  config: {fromChain: "eip155:42161"},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

// The two recorded quotes were asked for this sender (and, for the native one, another recipient of the user's).
const USDC = loadQuote("user.arb-usdc_base-usdc");
const ETH = loadQuote("user.op-eth_base-eth");
const serve = (f: QuoteFixture): typeof fetch => (async () => new Response(JSON.stringify(f.response))) as typeof fetch;

// The orders were issued at the fixtures' time; the engine reads the clock.
beforeEach(() => { vi.useFakeTimers({toFake: ["Date"], now: Math.max(USDC.request.nowMs, ETH.request.nowMs) + 5_000}); });
afterEach(() => { vi.useRealTimers(); });

// The fixture's own reading of what is signed, apart from the module: the order type written out a second time, the
// id in the calldata resolved to the recorded order by hashing it here, and everyone that order pays or refunds.
const ORDER_TYPES = {
  Order: [
    {name: "version", type: "string"}, {name: "solverChainId", type: "string"}, {name: "solver", type: "address"}, {name: "salt", type: "uint256"},
    {name: "inputs", type: "Input[]"}, {name: "output", type: "Output"}, {name: "fees", type: "Fee[]"},
  ],
  Input: [{name: "payment", type: "InputPayment"}, {name: "refunds", type: "InputRefund[]"}],
  InputPayment: [{name: "chainId", type: "string"}, {name: "currency", type: "bytes"}, {name: "amount", type: "uint256"}, {name: "weight", type: "uint256"}],
  InputRefund: [
    {name: "chainId", type: "string"}, {name: "recipient", type: "bytes"}, {name: "currency", type: "bytes"},
    {name: "minimumAmount", type: "uint256"}, {name: "deadline", type: "uint32"}, {name: "extraData", type: "bytes"},
  ],
  Output: [{name: "chainId", type: "string"}, {name: "payments", type: "OutputPayment[]"}, {name: "deadline", type: "uint32"}, {name: "calls", type: "bytes[]"}, {name: "extraData", type: "bytes"}],
  OutputPayment: [{name: "recipient", type: "bytes"}, {name: "currency", type: "bytes"}, {name: "minimumAmount", type: "uint256"}, {name: "expectedAmount", type: "uint256"}],
  Fee: [{name: "recipientChainId", type: "string"}, {name: "recipient", type: "bytes"}, {name: "currencyChainId", type: "string"}, {name: "currency", type: "bytes"}, {name: "amount", type: "uint256"}],
} as const;
const pays = (f: QuoteFixture) => (source: {kind: string; data?: string}): string[] => {
  const data = (source.data ?? "").toLowerCase();
  const native = data.startsWith("0x49290c1c");
  if (!native && !data.startsWith("0xe8017952")) throw new Error(`not a deposit: ${data.slice(0, 10)}`);
  if (data.length !== 10 + 64 * (native ? 2 : 4)) throw new Error("deposit calldata of the wrong length");
  const order = protoOf(f).orderData;
  const id = hashStruct({types: ORDER_TYPES, primaryType: "Order", data: {...order, salt: BigInt(order.salt)} as never});
  if (data.slice(-64) !== id.slice(2)) throw new Error("the deposit names an order other than the recorded one");
  if (order.output.payments.length !== 1 || order.output.calls.length !== 0 || order.inputs.length !== 1) throw new Error("not a single plain payment");
  return [`0x${data.slice(34, 74)}`, order.output.payments[0]!.recipient, ...order.inputs[0]!.refunds.map((r) => r.recipient)];
};
const DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";

describeProtocolBehaviour("protocol-swap2-relay", {
  type: "swap2",
  Protocol: RelaySwap2Protocol,
  config: {fromChain: "eip155:42161"},
  fixtures: [
    {
      name: "USDC Arbitrum → USDC Base (exact approval to the depository, depositErc20 naming the order)",
      options: {fromToken: "USDC", toToken: USDC.request.destToken, toChain: 8453, recipient: USDC.request.recipient, fromTokenAmount: BigInt(USDC.request.amount), minAmountOut: BigInt(protoOf(USDC).orderData.output.payments[0]!.minimumAmount)},
      fetch: serve(USDC),
      account: {address: USDC.request.depositor, chain: "eip155:42161"},
      own: [USDC.request.recipient],
      sourceToken: USDC.request.sourceToken,
      spender: DEPOSITORY,
      callTargets: [DEPOSITORY],
      decode: pays(USDC),
    },
  ],
});
describeProtocolBehaviour("protocol-swap2-relay (native)", {
  type: "swap2",
  Protocol: RelaySwap2Protocol,
  config: {fromChain: "eip155:10"},
  fixtures: [
    {
      name: "ETH OP Mainnet → ETH Base to another address of the user (depositNative, the amount as value)",
      options: {fromToken: "ETH", toToken: ETH.request.destToken, toChain: 8453, recipient: ETH.request.recipient, fromTokenAmount: BigInt(ETH.request.amount), minAmountOut: BigInt(protoOf(ETH).orderData.output.payments[0]!.minimumAmount)},
      fetch: serve(ETH),
      account: {address: ETH.request.depositor, chain: "eip155:10"},
      own: [ETH.request.recipient],
      callTargets: [DEPOSITORY],
      decode: pays(ETH),
    },
  ],
});
