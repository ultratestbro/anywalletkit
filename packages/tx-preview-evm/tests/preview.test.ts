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

  it("counts WETH9 Deposit / Withdrawal from a known wrapped token, ignores look-alikes", async () => {
    const WETH = "0x4200000000000000000000000000000000000006";
    const DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const ethOut = log(NATIVE, ME, WETH, 10n ** 16n);
    const wrapMeta = (params: unknown[]) => ((params[0] as {data: string}).data === "0x95d89b41" ? encodeAbiParameters([{type: "string"}], ["WETH"]) : toHex(18, {size: 32}));
    const depositFrom = (token: string) => ({address: token, topics: [DEPOSIT, pad(ME)], data: toHex(10n ** 16n, {size: 32})});
    const wrap = {to: WETH, data: "0xd0e30db0", value: 10n ** 16n};
    const r = rpc({eth_simulateV1: () => [{calls: [{status: "0x1", logs: [ethOut, depositFrom(WETH)]}]}], eth_call: wrapMeta});
    const p = await previewEvmTx({chainId: 8453, from: ME, calls: [wrap], rpc: r, own: [ME], known: {[WETH]: "WETH"}});
    expect(p.simulation.status === "ok" && p.simulation.changes.map((c) => `${c.symbol}:${c.delta}`)).toEqual(["ETH:-10000000000000000", "WETH:10000000000000000"]);
    // The same event from an unlisted contract is not a balance change.
    const fake = rpc({eth_simulateV1: () => [{calls: [{status: "0x1", logs: [ethOut, depositFrom(STRANGER)]}]}], eth_call: wrapMeta});
    const q = await previewEvmTx({chainId: 8453, from: ME, calls: [{...wrap, to: STRANGER}], rpc: fake, own: [ME], known: {[WETH]: "WETH"}});
    expect(q.simulation.status === "ok" && q.simulation.changes.map((c) => c.symbol)).toEqual(["ETH"]);
    // A wrapper that also emits a mint Transfer (Sonic wS) is counted once.
    const both = rpc({eth_simulateV1: () => [{calls: [{status: "0x1", logs: [ethOut, depositFrom(WETH), log(WETH, "0x0000000000000000000000000000000000000000", ME, 10n ** 16n)]}]}], eth_call: wrapMeta});
    const b = await previewEvmTx({chainId: 146, from: ME, calls: [wrap], rpc: both, own: [ME], known: {[WETH]: "WETH"}});
    expect(b.simulation.status === "ok" && b.simulation.changes.map((c) => `${c.symbol}:${c.delta}`)).toEqual(["ETH:-10000000000000000", "WETH:10000000000000000"]);
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
  it("passes state overrides to eth_simulateV1 and to the eth_call fallback (fund an unfunded sender)", async () => {
    const seen: unknown[][] = [];
    const sim = rpc({eth_simulateV1: (params) => { seen.push(params); return [{calls: [{status: "0x1", logs: []}]}]; }});
    const stateOverrides = {[ME]: {balance: 10n ** 18n}, [USDC]: {stateDiff: {["0x" + "11".repeat(32)]: toHex(5n, {size: 32})}}};
    await previewEvmTx({chainId: 8453, from: ME, calls: [swap], rpc: sim, own: [ME], stateOverrides});
    expect((seen[0]![0] as {blockStateCalls: {stateOverrides: unknown}[]}).blockStateCalls[0]!.stateOverrides).toEqual({
      [ME]: {balance: "0xde0b6b3a7640000"}, [USDC]: {stateDiff: {["0x" + "11".repeat(32)]: toHex(5n, {size: 32})}},
    });
    const calls: unknown[][] = [];
    const fb = rpc({eth_call: (params) => { calls.push(params); return "0x"; }});
    await previewEvmTx({chainId: 999, from: ME, calls: [swap], rpc: fb, own: [ME], stateOverrides});
    expect(calls[0]![2]).toEqual({[ME]: {balance: "0xde0b6b3a7640000"}, [USDC]: {stateDiff: {["0x" + "11".repeat(32)]: toHex(5n, {size: 32})}}});
    const none: unknown[][] = [];
    await previewEvmTx({chainId: 999, from: ME, calls: [swap], rpc: rpc({eth_call: (params) => { none.push(params); return "0x"; }}), own: [ME]});
    expect(none[0]).toHaveLength(2);
  });
});
