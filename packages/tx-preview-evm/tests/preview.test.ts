import {describe, expect, it} from "vitest";
import {encodeFunctionData, encodeAbiParameters, parseAbi, toHex, maxUint256} from "viem";
import {decodeCall, previewEvmTx, type Rpc} from "../src/index.js";

const ME = "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const STRANGER = "0x91c4d2aa6e15f0a7b3c9d8e7f6a5b4c3d2e1e07a";
const ERC20 = parseAbi(["function approve(address,uint256)", "function transfer(address,uint256)", "function setApprovalForAll(address,bool)"]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const log = (token: string, from: string, to: string, amount: bigint) => ({address: token, topics: [TRANSFER, pad(from), pad(to)], data: toHex(amount, {size: 32})});
const errString = (s: string) => `0x08c379a0${encodeAbiParameters([{type: "string"}], [s]).slice(2)}`;

function rpc(handlers: Record<string, (params: unknown[]) => unknown>): Rpc & {calls: string[]} {
  const calls: string[] = [];
  const fn = (async (method: string, params: unknown[]) => {
    calls.push(method);
    const h = handlers[method];
    if (!h) throw Object.assign(new Error(`the method ${method} does not exist`), {code: -32601});
    return h(params);
  }) as Rpc & {calls: string[]};
  fn.calls = calls;
  return fn;
}

const meta = (params: unknown[]) => {
  const data = (params[0] as {data: string}).data;
  if (data === "0x95d89b41") return encodeAbiParameters([{type: "string"}], ["USDC"]);
  if (data === "0x313ce567") return toHex(6, {size: 32});
  return "0x";
};

describe("decodeCall", () => {
  it("names approvals and flags unlimited ones", () => {
    const exact = decodeCall({to: USDC, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [DIAMOND, 100_000_000n]})}, {[DIAMOND]: "LI.FI Diamond"});
    expect(exact.approval).toEqual({token: USDC, spender: DIAMOND, spenderLabel: "LI.FI Diamond", amount: 100_000_000n, kind: "erc20"});
    const unlimited = decodeCall({to: USDC, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [DIAMOND, maxUint256]})});
    expect(unlimited.approval?.amount).toBeNull();
    const all = decodeCall({to: USDC, data: encodeFunctionData({abi: ERC20, functionName: "setApprovalForAll", args: [STRANGER, true]})});
    expect(all.approval).toMatchObject({kind: "operator", amount: null});
  });

  it("decodes token transfers and leaves unknown calls as their selector", () => {
    const t = decodeCall({to: USDC, data: encodeFunctionData({abi: ERC20, functionName: "transfer", args: [STRANGER, 5n]})});
    expect(t.transfer).toEqual({token: USDC, to: STRANGER, amount: 5n});
    expect(decodeCall({to: DIAMOND, data: "0x3f8f6a2a00"}).method).toBe("0x3f8f6a2a");
    expect(decodeCall({to: STRANGER, value: 1n}).method).toBe("transfer (native)");
  });
});

describe("previewEvmTx", () => {
  const approve = {to: USDC, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [DIAMOND, 100_000_000n]})};
  const swap = {to: DIAMOND, data: "0x3f8f6a2a" + "00".repeat(64)};

  it("simulates approve → swap and reports the sender's balance changes", async () => {
    const r = rpc({
      eth_simulateV1: () => [{calls: [
        {status: "0x1", gasUsed: "0xb000", logs: []},
        {status: "0x1", gasUsed: "0x4c2c0", logs: [log(USDC, ME, DIAMOND, 100_000_000n), log("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", DIAMOND, ME, 1n)]},
      ]}],
      eth_call: meta,
    });
    const p = await previewEvmTx({chainId: 8453, from: ME, calls: [approve, swap], rpc: r, own: [ME], known: {[DIAMOND]: "LI.FI Diamond"}, expectedRecipient: ME, expectedApproval: 100_000_000n});
    expect(p.simulation).toEqual({status: "ok", gasUsed: [0xb000n, 0x4c2c0n], changes: [
      {token: USDC, symbol: "USDC", decimals: 6, delta: -100_000_000n},
      {token: "native", symbol: "ETH", decimals: 18, delta: 1n},
    ]});
    expect(p.checks.map((c) => `${c.code}:${c.status}`)).toEqual(["contract-known:ok", "simulation-ok:ok", "recipient-own:ok", "approval-exact:ok"]);
  });

  it("warns on an unknown contract, a foreign recipient, and an unlimited approval to an unknown spender", async () => {
    const r = rpc({eth_simulateV1: () => [{calls: [{status: "0x1", logs: []}, {status: "0x1", logs: []}]}]});
    const p = await previewEvmTx({
      chainId: 8453, from: ME, rpc: r, own: [ME], expectedRecipient: STRANGER,
      calls: [{to: USDC, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [STRANGER, maxUint256]})}, {to: STRANGER, data: "0x7ff36ab5"}],
    });
    expect(p.checks.filter((c) => c.status === "warn").map((c) => c.code)).toEqual(["contract-unknown", "recipient-foreign", "approval-unknown-spender", "approval-unlimited"]);
  });

  it("flags an approval larger than the flow needs", async () => {
    const r = rpc({eth_simulateV1: () => [{calls: [{status: "0x1", logs: []}, {status: "0x1", logs: []}]}]});
    const big = {to: USDC, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [DIAMOND, 500_000_000n]})};
    const p = await previewEvmTx({chainId: 8453, from: ME, calls: [big, swap], rpc: r, own: [ME], known: {[DIAMOND]: "LI.FI"}, expectedApproval: 100_000_000n});
    expect(p.checks.find((c) => c.code === "approval-excess")).toMatchObject({status: "warn", detail: {amount: "500000000", expected: "100000000"}});
  });

  it("reports which call reverts and why", async () => {
    const r = rpc({eth_simulateV1: () => [{calls: [{status: "0x1", logs: []}, {status: "0x0", returnData: errString("ERC20: transfer amount exceeds balance"), logs: []}]}]});
    const p = await previewEvmTx({chainId: 8453, from: ME, calls: [approve, swap], rpc: r, own: [ME], known: {[DIAMOND]: "LI.FI"}});
    expect(p.simulation).toEqual({status: "reverted", callIndex: 1, reason: "ERC20: transfer amount exceeds balance"});
    expect(p.checks.find((c) => c.code === "simulation-reverted")?.status).toBe("warn");
  });

  it("falls back to eth_call where eth_simulateV1 is missing (Avalanche, HyperEVM)", async () => {
    const ok = rpc({eth_call: () => "0x"});
    const single = await previewEvmTx({chainId: 999, from: ME, calls: [swap], rpc: ok, own: [ME], known: {[DIAMOND]: "LI.FI"}});
    expect(single.simulation.status).toBe("unavailable");
    expect(ok.calls).toEqual(["eth_simulateV1", "eth_call"]);
    const bad = rpc({eth_call: () => { throw Object.assign(new Error("execution reverted"), {data: errString("expired quote")}); }});
    expect((await previewEvmTx({chainId: 999, from: ME, calls: [swap], rpc: bad, own: [ME]})).simulation).toEqual({status: "reverted", callIndex: 0, reason: "expired quote"});
    const seq = await previewEvmTx({chainId: 43114, from: ME, calls: [approve, swap], rpc: rpc({}), own: [ME]});
    expect(seq.simulation).toMatchObject({status: "unavailable"});
    expect(seq.checks.find((c) => c.code === "simulation-unavailable")?.status).toBe("unknown");
  });

  it("a plain native send checks the recipient only", async () => {
    const r = rpc({eth_simulateV1: () => [{calls: [{status: "0x1", logs: [log("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", ME, STRANGER, 10n)]}]}]});
    const p = await previewEvmTx({chainId: 1, from: ME, calls: [{to: STRANGER, value: 10n}], rpc: r, own: [ME]});
    expect(p.checks.map((c) => c.code)).toEqual(["simulation-ok", "recipient-foreign"]);
    expect(p.simulation).toMatchObject({changes: [{token: "native", delta: -10n}]});
  });
});
