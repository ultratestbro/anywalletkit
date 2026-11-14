import {describe, expect, it} from "vitest";
import {acrossProvider} from "../src/provider.js";
import {
  ACROSS_FILL_STATUS, acrossDepositsInReceipt, acrossFillState, acrossFillStatusCall, acrossRelayHash, acrossRpc, parseAcrossFillStatus,
  trackAcrossDeposit, type AcrossRpc,
} from "../src/status.js";
import {decodeAcrossDeposit} from "../src/deposit.js";
import {acrossIntentId} from "../src/verify.js";
import {ARB, BASE, rpcFrom, statusFixture, type StatusFixture} from "./fixtures.js";

const WETH_DEPOSIT = statusFixture("base-arb-weth-depositv3");
const USDC_DEPOSIT = statusFixture("base-arb-usdc-deposit");
const EXPIRED = statusFixture("base-arb-expired");

/** A JSON-RPC caller answering from a status fixture (the same answers `rpcFrom` serves over fetch). */
function rpcOf(f: StatusFixture, readIndex: number, log: string[] = []): {source: AcrossRpc; dest: AcrossRpc} {
  const read = f.dest.reads[readIndex]!;
  return {
    source: async (method, params) => { log.push(`source ${method} ${JSON.stringify(params)}`); return method === "eth_getTransactionReceipt" ? f.source.receipt : null; },
    dest: async (method, params) => {
      log.push(`dest ${method} ${JSON.stringify(params)}`);
      if (method === "eth_getBlockByNumber") return read.block;
      if (method === "eth_call") return read.fillStatus;
      return null;
    },
  };
}

describe("the deposit from its receipt", () => {
  it("reads FundsDeposited of the pinned SpokePool (a real Base → Arbitrum depositV3)", () => {
    const [d, ...rest] = acrossDepositsInReceipt(WETH_DEPOSIT.source.receipt, BASE);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      originChainId: 8453, destinationChainId: 42161n, depositId: 6_457_809n,
      depositor: "0x000000000000000000000000f0decae81b94a3b9e3903568ba336b3daa40cdf3",
      recipient: "0x00000000000000000000000020bee9556dccdeb7562f1b7de26489a1f099a650",
      inputToken: "0x0000000000000000000000004200000000000000000000000000000000000006",
      outputToken: "0x00000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab1",
      inputAmount: 531_404_851_235_290_248n, outputAmount: 531_132_706_277_721_174n, message: "0x",
    });
    // The receipt's own logs are only read from the pinned SpokePool of that chain.
    expect(acrossDepositsInReceipt(WETH_DEPOSIT.source.receipt, ARB)).toEqual([]);
  });

  it("the event matches the deposit calldata that made it (USDC, deposit 0xad5425c6, marker taken off)", () => {
    const [d] = acrossDepositsInReceipt(USDC_DEPOSIT.source.receipt, BASE);
    const a = decodeAcrossDeposit(USDC_DEPOSIT.source.input.slice(0, -6));
    const word = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2)}`;
    expect(d!.depositor).toBe(word(a.depositor));
    expect(d!.recipient).toBe(word(a.recipient));
    expect(d!.inputToken).toBe(word(a.inputToken));
    expect(d!.outputToken).toBe(word(a.outputToken));
    expect(d!.inputAmount).toBe(a.inputAmount);
    expect(d!.outputAmount).toBe(a.outputAmount);
    expect(d!.destinationChainId).toBe(a.destinationChainId);
    expect(d!.quoteTimestamp).toBe(a.quoteTimestamp);
    expect(d!.fillDeadline).toBe(a.fillDeadline);
    expect(d!.exclusiveRelayer).toBe(word(a.exclusiveRelayer));
    // An offset is resolved against the block time in the event.
    if (a.exclusivityParameter > 0 && a.exclusivityParameter <= 31_536_000) expect(d!.exclusivityDeadline).toBeGreaterThan(a.exclusivityParameter);
  });

  it("skips junk logs and junk receipts", () => {
    const log = WETH_DEPOSIT.source.receipt.logs.find((l) => l.address.toLowerCase() === BASE.spokePool)!;
    const variants = [
      {...log, topics: log.topics.slice(0, 3)},
      {...log, topics: [log.topics[0]!.replace(/.$/, "0"), ...log.topics.slice(1)]},
      {...log, data: "0x1234"},
      {...log, data: "zz"},
      {...log, removed: true},
      null,
    ];
    for (const v of variants) expect(acrossDepositsInReceipt({logs: [v]}, BASE)).toEqual([]);
    expect(acrossDepositsInReceipt(null, BASE)).toEqual([]);
    expect(acrossDepositsInReceipt({logs: "x"}, BASE)).toEqual([]);
  });
});

describe("the relay hash", () => {
  it("is the one Across's own indexer gives for the same deposit", () => {
    const [d] = acrossDepositsInReceipt(WETH_DEPOSIT.source.receipt, BASE);
    expect(acrossRelayHash(d!)).toBe(WETH_DEPOSIT.acrossIndexerRelayHash);
    expect(acrossRelayHash(d!)).toBe("0xe9e40248968303d9c85c0eb4082b2b1d70e7e637fc22aa605654f24084734df6");
  });

  it("is what the destination's fillStatuses is keyed by: 0 one block before the fill, 2 at the fill block (Arbitrum, recorded)", () => {
    const [d] = acrossDepositsInReceipt(WETH_DEPOSIT.source.receipt, BASE);
    expect(WETH_DEPOSIT.relayHash).toBe(acrossRelayHash(d!));
    const [before, at] = WETH_DEPOSIT.dest.reads;
    expect(BigInt(at!.block.number) - BigInt(before!.block.number)).toBe(1n);
    expect(parseAcrossFillStatus(before!.fillStatus)).toBe(ACROSS_FILL_STATUS.UNFILLED);
    expect(parseAcrossFillStatus(at!.fillStatus)).toBe(ACROSS_FILL_STATUS.FILLED);
  });

  it("changes with any field", () => {
    const [d] = acrossDepositsInReceipt(WETH_DEPOSIT.source.receipt, BASE);
    const h = acrossRelayHash(d!);
    expect(acrossRelayHash({...d!, outputAmount: d!.outputAmount + 1n})).not.toBe(h);
    expect(acrossRelayHash({...d!, destinationChainId: 10n})).not.toBe(h);
    expect(acrossRelayHash({...d!, originChainId: 1})).not.toBe(h);
    expect(acrossRelayHash({...d!, message: "0x00"})).not.toBe(h);
  });

  it("fillStatuses calldata and answers", () => {
    expect(acrossFillStatusCall(WETH_DEPOSIT.relayHash as `0x${string}`)).toBe(`0xc35c83fc${WETH_DEPOSIT.relayHash.slice(2)}`);
    expect(() => acrossFillStatusCall("0x12")).toThrow();
    expect(parseAcrossFillStatus(`0x${"0".repeat(63)}1`)).toBe(1);
    for (const bad of [`0x${"0".repeat(63)}3`, "0x", "0x02", null, `0x${"0".repeat(64)}00`]) expect(parseAcrossFillStatus(bad)).toBeNull();
  });

  it("fill states: filled; open until the fill deadline (inclusive); expired after it", () => {
    expect(acrossFillState(2, 100, 1000)).toBe("filled");
    expect(acrossFillState(0, 100, 100)).toBe("unfilled");
    expect(acrossFillState(1, 100, 99)).toBe("slow-fill-requested");
    expect(acrossFillState(0, 100, 101)).toBe("expired");
    expect(acrossFillState(1, 100, 101)).toBe("expired");
  });
});

describe("trackAcrossDeposit on recorded chains", () => {
  it("filled → completed", async () => {
    const r = rpcOf(WETH_DEPOSIT, 1);
    const t = await trackAcrossDeposit({sourceTxHash: WETH_DEPOSIT.source.txHash, source: BASE, dest: ARB, sourceRpc: r.source, destRpc: r.dest});
    expect(t.status).toEqual({state: "completed", depositReceived: true});
    expect(t.fill).toBe("filled");
    expect(t.relayHash).toBe(WETH_DEPOSIT.acrossIndexerRelayHash);
  });

  it("unfilled before the deadline → pending, the deposit seen; the fill status is read at the block whose time is used", async () => {
    const log: string[] = [];
    const r = rpcOf(WETH_DEPOSIT, 0, log);
    const t = await trackAcrossDeposit({sourceTxHash: WETH_DEPOSIT.source.txHash, source: BASE, dest: ARB, sourceRpc: r.source, destRpc: r.dest});
    expect(t.status).toEqual({state: "pending", depositReceived: true});
    expect(t.fill).toBe("unfilled");
    expect(log[2]).toContain(`"${WETH_DEPOSIT.dest.reads[0]!.block.number}"`);
    expect(log[2]).toContain(ARB.spokePool);
  });

  it("unfilled past the deadline (a real expired deposit) → refund-pending", async () => {
    const r = rpcOf(EXPIRED, 0);
    const t = await trackAcrossDeposit({sourceTxHash: EXPIRED.source.txHash, source: BASE, dest: ARB, sourceRpc: r.source, destRpc: r.dest});
    expect(parseInt(EXPIRED.dest.reads[0]!.block.timestamp, 16)).toBeGreaterThan(t.deposit!.fillDeadline);
    expect(t.status).toEqual({state: "refund-pending", depositReceived: true});
    expect(t.fill).toBe("expired");
  });

  it("without RPCs: pending, then deposit seen", async () => {
    const r = rpcOf(USDC_DEPOSIT, 0);
    expect((await trackAcrossDeposit({sourceTxHash: USDC_DEPOSIT.source.txHash, source: BASE, dest: ARB})).status).toEqual({state: "pending"});
    expect((await trackAcrossDeposit({sourceTxHash: USDC_DEPOSIT.source.txHash, source: BASE, dest: ARB, sourceRpc: r.source})).status).toEqual({state: "pending", depositReceived: true});
  });

  it("a reverted deposit fails; a mined transaction that is not one deposit of this route fails", async () => {
    const reverted: AcrossRpc = async () => ({...USDC_DEPOSIT.source.receipt, status: "0x0"});
    expect((await trackAcrossDeposit({sourceTxHash: USDC_DEPOSIT.source.txHash, source: BASE, dest: ARB, sourceRpc: reverted})).status).toEqual({state: "failed"});
    const empty: AcrossRpc = async () => ({...USDC_DEPOSIT.source.receipt, logs: []});
    expect((await trackAcrossDeposit({sourceTxHash: USDC_DEPOSIT.source.txHash, source: BASE, dest: ARB, sourceRpc: empty})).status).toEqual({state: "failed"});
    const r = rpcOf(USDC_DEPOSIT, 0);
    // The same receipt tracked for another destination is not this transfer.
    expect((await trackAcrossDeposit({sourceTxHash: USDC_DEPOSIT.source.txHash, source: BASE, dest: {...ARB, chainId: 10}, sourceRpc: r.source})).status).toEqual({state: "failed"});
  });

  it("nothing made up when a node fails or answers junk", async () => {
    const r = rpcOf(USDC_DEPOSIT, 0);
    const hash = USDC_DEPOSIT.source.txHash;
    const boom: AcrossRpc = async () => { throw new Error("down"); };
    expect((await trackAcrossDeposit({sourceTxHash: hash, source: BASE, dest: ARB, sourceRpc: boom})).status).toEqual({state: "pending"});
    expect((await trackAcrossDeposit({sourceTxHash: hash, source: BASE, dest: ARB, sourceRpc: async () => null})).status).toEqual({state: "pending"});
    expect((await trackAcrossDeposit({sourceTxHash: hash, source: BASE, dest: ARB, sourceRpc: async () => ({status: "0x2"})})).status).toEqual({state: "pending"});
    expect((await trackAcrossDeposit({sourceTxHash: hash, source: BASE, dest: ARB, sourceRpc: r.source, destRpc: boom})).status).toEqual({state: "pending", depositReceived: true});
    const junkBlock: AcrossRpc = async (m) => (m === "eth_getBlockByNumber" ? {number: "latest"} : `0x${"0".repeat(63)}2`);
    expect((await trackAcrossDeposit({sourceTxHash: hash, source: BASE, dest: ARB, sourceRpc: r.source, destRpc: junkBlock})).status).toEqual({state: "pending", depositReceived: true});
    const junkStatus: AcrossRpc = async (m) => (m === "eth_getBlockByNumber" ? USDC_DEPOSIT.dest.reads[0]!.block : "0x07");
    expect((await trackAcrossDeposit({sourceTxHash: hash, source: BASE, dest: ARB, sourceRpc: r.source, destRpc: junkStatus})).status).toEqual({state: "pending", depositReceived: true});
    expect((await trackAcrossDeposit({sourceTxHash: "0x12", source: BASE, dest: ARB, sourceRpc: r.source})).status).toEqual({state: "pending"});
  });
});

describe("acrossRpc", () => {
  it("speaks JSON-RPC over fetch and keeps the URL out of its errors", async () => {
    const seen: unknown[] = [];
    const ok = acrossRpc("https://rpc.example/key-123", (async (_u: unknown, init?: RequestInit) => { seen.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result: "0x1"})); }) as typeof fetch);
    expect(await ok("eth_chainId", [])).toBe("0x1");
    expect(seen[0]).toMatchObject({jsonrpc: "2.0", method: "eth_chainId", params: []});
    const failing = acrossRpc("https://rpc.example/key-123", (async () => { throw new Error("connect https://rpc.example/key-123 refused"); }) as typeof fetch);
    await expect(failing("eth_call", [])).rejects.toThrow(/^across: eth_call failed — connect <url> refused$/);
    const http = acrossRpc("https://rpc.example/key-123", (async () => new Response("no", {status: 503})) as typeof fetch);
    await expect(http("eth_call", [])).rejects.toThrow(/HTTP 503/);
    const err = acrossRpc("https://x.example", (async () => new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error: {message: "execution reverted"}}))) as typeof fetch);
    await expect(err("eth_call", [])).rejects.toThrow(/execution reverted/);
    const notJson = acrossRpc("https://x.example", (async () => new Response("<html>")) as typeof fetch);
    await expect(notJson("eth_call", [])).rejects.toThrow(/not JSON/);
    const noResult = acrossRpc("https://x.example", (async () => new Response(JSON.stringify({jsonrpc: "2.0", id: 1}))) as typeof fetch);
    await expect(noResult("eth_call", [])).rejects.toThrow(/no result/);
    expect(() => acrossRpc("ftp://x")).toThrow();
  });
});

describe("provider.trackIntent", () => {
  const intent = (f: StatusFixture) => acrossIntentId(8453, 42161, f.source.input.slice(0, -6) as `0x${string}`);

  it("reads both chains through rpcUrls", async () => {
    const calls: {url: string; method: string; params: unknown[]}[] = [];
    const p = acrossProvider({rpcUrls: {"eip155:8453": "https://base.example", "eip155:42161": "https://arb.example"}, fetchImpl: rpcFrom(WETH_DEPOSIT, 1, calls)});
    expect(await p.trackIntent({intentId: intent(USDC_DEPOSIT), sourceTxHash: WETH_DEPOSIT.source.txHash})).toEqual({state: "completed", depositReceived: true});
    expect(calls.map((c) => `${c.url} ${c.method}`)).toEqual(["https://base.example eth_getTransactionReceipt", "https://arb.example eth_getBlockByNumber", "https://arb.example eth_call"]);
    const expired = acrossProvider({rpcUrls: {"eip155:8453": "https://base.example", "eip155:42161": "https://arb.example"}, fetchImpl: rpcFrom(EXPIRED, 0)});
    expect(await expired.trackIntent({intentId: intent(USDC_DEPOSIT), sourceTxHash: EXPIRED.source.txHash})).toEqual({state: "refund-pending", depositReceived: true});
  });

  it("before a deposit, without RPCs, and for ids that are not its own", async () => {
    const calls: unknown[] = [];
    const p = acrossProvider({fetchImpl: rpcFrom(WETH_DEPOSIT, 1, calls as never)});
    expect(await p.trackIntent({intentId: intent(USDC_DEPOSIT)})).toEqual({state: "pending"});
    expect(await p.trackIntent({intentId: intent(USDC_DEPOSIT), sourceTxHash: WETH_DEPOSIT.source.txHash})).toEqual({state: "pending"});
    expect(calls).toEqual([]);
    expect(await p.trackIntent({intentId: "relay:0x1", sourceTxHash: WETH_DEPOSIT.source.txHash})).toEqual({state: "failed"});
    expect(await p.trackIntent({intentId: "across:8453:56:" + "0".repeat(32), sourceTxHash: WETH_DEPOSIT.source.txHash})).toEqual({state: "failed"});
    expect(await p.trackIntent({intentId: "across:8453:8453:" + "0".repeat(32), sourceTxHash: WETH_DEPOSIT.source.txHash})).toEqual({state: "failed"});
  });

  it("refuses an RPC URL that is not http(s)", () => {
    expect(() => acrossProvider({rpcUrls: {"eip155:8453": "ws://x"}})).toThrow(/http or https/);
  });
});
