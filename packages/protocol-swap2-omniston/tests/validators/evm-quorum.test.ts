/**
 * Extension audit 2026-11-09 E37: the secret disclosure rested on ONE RPC — `omnistonEvmRpcRequest` returns the first
 * endpoint that answers, so a malicious RPC (colluding with the resolver) could fabricate the escrow facts and get the
 * secret released. With `quorum: 2` every independent operator runs the whole validation on its own (state reads
 * pinned to its finalized block) and at least two must prove the position.
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeAbiParameters, encodeFunctionData, type Hex} from "viem";
import {createOmnistonEvmOutputValidator, omnistonRpcOperator, omnistonRpcOperatorGroups, type EvmOutputValidationInput} from "../../src/validators/evm-output.js";
import {createOmnistonEvmInputValidator, SRC_ESCROW_CREATED_TOPIC, type EvmInputValidationInput} from "../../src/validators/evm-input.js";

type Rpc = (method: string, params: unknown[]) => unknown;

/** fetch stub: each endpoint host answers with its own fake node; every call is recorded. */
function stubNodes(nodes: Record<string, Rpc>): {calls: {host: string; method: string; params: unknown[]}[]} {
  const calls: {host: string; method: string; params: unknown[]}[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: {body: string}) => {
    const host = new URL(url).host;
    const {method, params} = JSON.parse(init.body) as {method: string; params: unknown[]};
    calls.push({host, method, params});
    const node = nodes[host];
    if (!node) return new Response("no such node", {status: 502});
    try {
      return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result: await node(method, params)}), {status: 200});
    } catch (error) {
      return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error: {message: String(error)}}), {status: 200});
    }
  }));
  return {calls};
}
afterEach(() => vi.unstubAllGlobals());

// ── destination escrow (TON→EVM, EVM→EVM): the shape of evm-output.test.ts ──
const FACTORY = "0xafCF681272AF10959736f45616eeCBC22D7095E2";
const POSITION = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const HASH = Uint8Array.from({length: 32}, (_, index) => index + 1);
const HASH_HEX = `0x${Buffer.from(HASH).toString("hex")}` as Hex;
const QUOTE_TIME = 1_700_000_000;
const TUPLE = [
  {name: "orderHash", type: "bytes32"}, {name: "hashlock", type: "bytes32"}, {name: "maker", type: "uint256"}, {name: "taker", type: "uint256"},
  {name: "token", type: "uint256"}, {name: "amount", type: "uint256"}, {name: "safetyDeposit", type: "uint256"}, {name: "timelocks", type: "uint256"}, {name: "parameters", type: "bytes"},
] as const;
const DST_ABI = [
  {type: "function", name: "createDstEscrow", stateMutability: "payable", inputs: [{name: "dstImmutables", type: "tuple", components: TUPLE}, {name: "srcCancellationTimestamp", type: "uint256"}], outputs: []},
  {type: "function", name: "addressOfEscrowDst", stateMutability: "view", inputs: [{name: "immutables", type: "tuple", components: TUPLE}], outputs: [{type: "address"}]},
] as const;
const OUTPUT: EvmOutputValidationInput = {
  chain: "eip155:1", positionAddress: POSITION, factoryAddress: FACTORY, quoteTimestamp: QUOTE_TIME, executionIndex: 0, recipientAddress: RECIPIENT,
  outputTokenAddress: TOKEN, inputUnits: "1000000", outputUnits: "990000", resolverSendsUnits: "995000", srcHtlcSecurityDepositUnits: "500",
  dstSecurityDepositUnits: "1000", protocolFeeUnits: "5000", integratorFeeUnits: "0", protocolFeeRecipientAddress: "0x6666666666666666666666666666666666666666", secretHash: HASH,
};

/** A node that shows the escrow the quote promised (an honest node after the resolver delivered — or a lying one). */
function escrowNode(): Rpc {
  const immutables = {
    orderHash: `0x${"44".repeat(32)}` as Hex, hashlock: HASH_HEX, maker: BigInt(RECIPIENT), taker: BigInt("0x5555555555555555555555555555555555555555"),
    token: BigInt(TOKEN), amount: 995000n, safetyDeposit: 1000n,
    timelocks: 1n | (120n << 32n) | (240n << 64n) | (300n << 96n) | (1n << 128n) | (120n << 160n) | (180n << 192n),
    parameters: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}, {type: "uint256"}, {type: "uint256"}], [5000n, 0n, BigInt("0x6666666666666666666666666666666666666666"), 0n]),
  };
  const deployed = {...immutables, timelocks: immutables.timelocks | (BigInt(QUOTE_TIME) << 224n)};
  const txInput = encodeFunctionData({abi: DST_ABI, functionName: "createDstEscrow", args: [immutables, BigInt(QUOTE_TIME + 600)]});
  const eventData = encodeAbiParameters([{type: "address"}, {type: "bytes32"}, {type: "uint256"}], [POSITION, HASH_HEX, immutables.taker]);
  return (method, params) => {
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_getLogs") return [{data: eventData, transactionHash: `0x${"77".repeat(32)}`, blockNumber: "0x50"}];
    if (method === "eth_getTransactionByHash") return {to: FACTORY, input: txInput, value: "0x3e8"};
    if (method === "eth_getTransactionReceipt") return {status: "0x1", blockNumber: "0x50"};
    if (method === "eth_getBlockByNumber") return {timestamp: `0x${QUOTE_TIME.toString(16)}`};
    if (method === "eth_getCode") return "0x6001";
    if (method === "eth_getBalance") return "0x3e8";
    if (method === "eth_call") {
      const call = params[0] as {to: string; data: Hex};
      if (call.to.toLowerCase() === FACTORY.toLowerCase()) {
        const asked = decodeFunctionData({abi: DST_ABI, data: call.data}).args[0] as typeof deployed;
        return encodeAbiParameters([{type: "address"}], [asked.timelocks === deployed.timelocks && asked.maker === deployed.maker ? POSITION : "0x0000000000000000000000000000000000000bad"]);
      }
      if (call.to.toLowerCase() === POSITION.toLowerCase()) return encodeAbiParameters([{type: "address"}], [FACTORY]);
      if (call.to.toLowerCase() === TOKEN.toLowerCase()) return encodeAbiParameters([{type: "uint256"}], [995000n]);
    }
    throw new Error(`unexpected ${method}`);
  };
}
/** A node that knows of no such escrow (the honest view when the resolver did not deliver). */
const emptyNode: Rpc = (method) => (method === "eth_blockNumber" ? "0x64" : method === "eth_getLogs" ? [] : null);

const now = () => QUOTE_TIME * 1000 + 60_000;
const twoOperators = {"eip155:1": ["https://liar.example-rpc.com", "https://node.honest-rpc.org"]};

describe("E37 — Omniston EVM output validator with an RPC quorum", () => {
  it("default (no quorum): the first answering endpoint decides — a lying RPC alone gets the secret released", async () => {
    stubNodes({"liar.example-rpc.com": escrowNode(), "node.honest-rpc.org": emptyNode});
    await expect(createOmnistonEvmOutputValidator({rpcUrls: twoOperators, now})(OUTPUT)).resolves.toBe(true);
  });

  it("quorum 2: one operator's fabricated escrow is not enough", async () => {
    stubNodes({"liar.example-rpc.com": escrowNode(), "node.honest-rpc.org": emptyNode});
    const refusals: [string, Record<string, unknown> | undefined][] = [];
    const validate = createOmnistonEvmOutputValidator({rpcUrls: twoOperators, now, quorum: 2, onRefusal: (r, d) => refusals.push([r, d])});
    await expect(validate(OUTPUT)).resolves.toBe(false);
    expect(refusals.map(([r]) => r)).toContain("rpc-quorum-not-met");
    expect(refusals.find(([r]) => r === "no-escrow-event")?.[1]).toMatchObject({operator: "honest-rpc.org"});
  });

  it("quorum 2: two independent operators that each prove the escrow — state read at their finalized block", async () => {
    const {calls} = stubNodes({"a.example-rpc.com": escrowNode(), "node.honest-rpc.org": escrowNode(), "ethereum-rpc.publicnode.com": emptyNode});
    const validate = createOmnistonEvmOutputValidator({rpcUrls: {"eip155:1": ["https://a.example-rpc.com", "https://node.honest-rpc.org"]}, now, quorum: 2});
    await expect(validate(OUTPUT)).resolves.toBe(true);
    // 0x64 − 2 confirmations on Ethereum: every state read is pinned to 0x62, never "latest".
    const stateReads = calls.filter((c) => ["eth_call", "eth_getCode", "eth_getBalance"].includes(c.method));
    expect(stateReads.length).toBeGreaterThan(0);
    expect(stateReads.every((c) => c.params.at(-1) === "0x62")).toBe(true);
    expect(new Set(calls.map((c) => c.host))).toEqual(new Set(["a.example-rpc.com", "node.honest-rpc.org", "ethereum-rpc.publicnode.com"]));
  });

  it("quorum 2: endpoints of one operator count once — refused when fewer operators than the quorum are configured", async () => {
    stubNodes({"a.example-rpc.com": escrowNode(), "b.example-rpc.com": escrowNode()});
    const refusals: string[] = [];
    // eip155:999 (HyperEVM) public fallback is rpc.hyperliquid.xyz — a second operator; use a chain list without it.
    const validate = createOmnistonEvmOutputValidator({rpcUrls: {"eip155:1": ["https://a.example-rpc.com", "https://b.example-rpc.com"]}, now, quorum: 3, onRefusal: (r) => refusals.push(r)});
    await expect(validate(OUTPUT)).resolves.toBe(false);
    expect(refusals).toEqual(["rpc-quorum-unavailable"]);
  });

  it("a quorum needs per-operator endpoints, not a single injected request", () => {
    expect(() => createOmnistonEvmOutputValidator({request: async () => null, quorum: 2})).toThrow(/quorum/);
    expect(() => createOmnistonEvmOutputValidator({quorum: 0})).toThrow(/quorum/);
  });
});

describe("E37 — operators", () => {
  it("groups endpoints by registrable domain, caller URLs first, public fallbacks after, duplicates once", () => {
    expect(omnistonRpcOperator("https://base-rpc.publicnode.com")).toBe("publicnode.com");
    expect(omnistonRpcOperator("https://mainnet.base.org/")).toBe("base.org");
    expect(omnistonRpcOperatorGroups("eip155:8453", {"eip155:8453": ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://x.drpc.org"]}))
      .toEqual([
        {operator: "base.org", urls: ["https://mainnet.base.org"]},
        {operator: "publicnode.com", urls: ["https://base-rpc.publicnode.com"]},
        {operator: "drpc.org", urls: ["https://base.drpc.org", "https://x.drpc.org"]},
      ]);
  });
});

// ── source escrow (EVM→TON, EVM→EVM): the shape of evm-input.test.ts ──
const SRC_FACTORY = "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd";
const SRC_POSITION = "0x0CD4d5758313baAdB792c51175B383Bb64Ea6909";
const OWNER = "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA";
const RESOLVER = "0x2b654E50C83801AC79CE3011Ff94245E2937b1B7";
const SRC_TOKEN = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const SRC_HASH = Uint8Array.from({length: 32}, (_, index) => 255 - index);
const DEPLOYED_AT = 1_792_100_000;
const SRC_INPUT: EvmInputValidationInput = {
  chain: "eip155:8453", positionAddress: SRC_POSITION, factoryAddress: SRC_FACTORY, orderProtocolAddress: "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E",
  ownerAddress: OWNER, resolverAddress: RESOLVER, inputTokenAddress: SRC_TOKEN, inputUnits: "20000000", resolverSendsUnits: "20346628",
  srcHtlcSecurityDepositUnits: "600000000000000", quoteTimestamp: DEPLOYED_AT - 10, secretHash: SRC_HASH,
};
const COMPLEMENT = [
  {name: "maker", type: "uint256"}, {name: "amount", type: "uint256"}, {name: "token", type: "uint256"}, {name: "safetyDeposit", type: "uint256"}, {name: "chainId", type: "uint256"}, {name: "parameters", type: "bytes"},
] as const;
function fillNode(): Rpc {
  const stages = [1n, 120n, 240n, 300n, 1n, 120n, 180n];
  const immutables = {
    orderHash: `0x${"25".repeat(32)}` as Hex, hashlock: `0x${Buffer.from(SRC_HASH).toString("hex")}` as Hex, maker: BigInt(OWNER), taker: BigInt(RESOLVER),
    token: BigInt(SRC_TOKEN), amount: 20_000_000n, safetyDeposit: 600_000_000_000_000n,
    timelocks: stages.reduce((packed, value, index) => packed | (value << BigInt(index * 32)), BigInt(DEPLOYED_AT) << 224n), parameters: "0x" as Hex,
  };
  const complement = {maker: BigInt(RESOLVER), amount: 20_346_628n, token: BigInt("0xbDdba5647D24c4a513f8F85e596B111B511A6E5e"), safetyDeposit: 0n, chainId: 0n, parameters: "0x" as Hex};
  const data = encodeAbiParameters([{type: "tuple", components: TUPLE}, {type: "tuple", components: COMPLEMENT}], [immutables, complement]);
  return (method, params) => {
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_getLogs") return [{address: SRC_FACTORY, data, topics: [SRC_ESCROW_CREATED_TOPIC], transactionHash: `0x${"77".repeat(32)}`, blockNumber: "0x50"}];
    if (method === "eth_getTransactionReceipt") return {status: "0x1", blockNumber: "0x50"};
    if (method === "eth_getBlockByNumber") return {timestamp: `0x${DEPLOYED_AT.toString(16)}`};
    if (method === "eth_getCode") return "0x6001";
    if (method === "eth_getBalance") return `0x${(600_000_000_000_000n).toString(16)}`;
    if (method === "eth_call") {
      const call = params[0] as {to: string};
      if (call.to.toLowerCase() === SRC_FACTORY.toLowerCase()) return encodeAbiParameters([{type: "address"}], [SRC_POSITION]);
      if (call.to.toLowerCase() === SRC_POSITION.toLowerCase()) return encodeAbiParameters([{type: "address"}], [SRC_FACTORY]);
      if (call.to.toLowerCase() === SRC_TOKEN.toLowerCase()) return encodeAbiParameters([{type: "uint256"}], [20_000_000n]);
    }
    throw new Error(`unexpected ${method}`);
  };
}

describe("E37 — Omniston EVM input validator with an RPC quorum", () => {
  const nowSrc = () => (DEPLOYED_AT + 30) * 1000;
  const base = {"eip155:8453": ["https://liar.example-rpc.com", "https://node.honest-rpc.org"]};
  it("one operator's fabricated fill is not enough; two operators that each prove it are", async () => {
    stubNodes({"liar.example-rpc.com": fillNode(), "node.honest-rpc.org": emptyNode, "base-rpc.publicnode.com": emptyNode});
    await expect(createOmnistonEvmInputValidator({rpcUrls: base, now: nowSrc})(SRC_INPUT)).resolves.toBe(true);
    await expect(createOmnistonEvmInputValidator({rpcUrls: base, now: nowSrc, quorum: 2})(SRC_INPUT)).resolves.toBe(false);
    stubNodes({"liar.example-rpc.com": fillNode(), "node.honest-rpc.org": fillNode(), "base-rpc.publicnode.com": emptyNode});
    await expect(createOmnistonEvmInputValidator({rpcUrls: base, now: nowSrc, quorum: 2})(SRC_INPUT)).resolves.toBe(true);
  });
});
