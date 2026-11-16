import {describe, expect, it} from "vitest";
import {pad} from "viem";
import {createStargateQuoter, taxiNativeDrop} from "../src/quote.js";
import type {StargateDeployment} from "../src/registry.js";
import {setup, actor, recipient} from "./helpers/rpc.js";

describe("Stargate direct quote snapshots", () => {
  it("converts 18→6, separates a negative fee from refundable headroom, and binds the caller", async () => {
    const f = setup();
    const q = await f.quoter.quote(f.request);
    expect(q).toMatchObject({sentAmount: 10n ** 19n, dust: 0n, destinationAmount: 9_999_900n, minimumDestinationAmount: 9_999_900n, protocolFee: 10n ** 14n, protocolReward: 0n, messagingFee: 101n, messagingFeeCap: 127n, nativeValue: 127n, liquidityReserved: false, etaSeconds: null, sourceGas: null, approvalGas: null});
    expect(q.sendParam.minAmountLD).toBe(9_999_900n * 10n ** 12n);
    expect(f.reads.every((r) => r.block === "0x64")).toBe(true);
    expect(f.reads.filter((r) => r.functionName.startsWith("quote")).every((r) => r.from?.toLowerCase() === actor)).toBe(true);
    expect(Object.isFrozen(q)).toBe(true);
    expect(Object.isFrozen(q.sendParam)).toBe(true);
  });

  it("rounds the 6→18 caller floor upward and enforces it", async () => {
    const f = setup("eip155:42161", "eip155:56");
    f.state.feeSD = 0n;
    const q = await f.quoter.quote({...f.request, minimum: 9_999_998_000_000_000_001n, slippageBps: 100});
    expect(q.sendParam.minAmountLD).toBe(9_999_999n);
    expect(q.minimumDestinationAmount).toBe(9_999_999_000_000_000_000n);
    await expect(f.quoter.quote({...f.request, minimum: 10n ** 19n + 1n})).rejects.toThrow(/minimum/);
  });

  it("retains ERC20 dust in the source wallet; native input attaches dust separately from fees", async () => {
    for (const asset of [1, 13]) {
      const f = setup("eip155:8453", "eip155:42161", asset);
      f.state.feeSD = 0n;
      const amount = asset === 13 ? 10n ** 16n + 77n : 10n ** 7n;
      const q = await f.quoter.quote({...f.request, amount});
      expect(q.dust).toBe(asset === 13 ? 77n : 0n);
      expect(q.nativeValue).toBe(q.messagingFeeCap + (asset === 13 ? amount : 0n));
      expect(q.protocolFee).toBe(0n);
    }
    const f = setup();
    const q = await f.quoter.quote({...f.request, amount: f.request.amount + 99n});
    expect(q.dust).toBe(99n);
    expect(q.nativeValue).toBe(q.messagingFeeCap);
    expect(q.sentAmount).toBe(f.request.amount);
  });

  it("accepts rewards and rejects insufficient output credits even when input fits", async () => {
    const f = setup();
    f.state.feeSD = 100n;
    const q = await f.quoter.quote(f.request);
    expect(q.destinationAmount).toBe(10_000_100n);
    expect(q.protocolReward).toBe(10n ** 14n);
    expect(q.protocolFee).toBe(0n);
    f.state.credit = 10_000_000n;
    await expect(f.quoter.quote(f.request)).rejects.toThrow(/credits/);
    f.state.credit = (1n << 64n) - 1n;
    expect((await f.quoter.quote(f.request)).destinationAmount).toBe(10_000_100n);
  });

  it("refuses clipped input, inconsistent accounting, unaligned or zero output, and LZ token fees", async () => {
    const f = setup();
    f.state.credit = 9_000_000n;
    await expect(f.quoter.quote(f.request)).rejects.toThrow(/limits/);
    f.state.credit = 100_000_000n;
    for (const change of [
      {amountSentLD: f.request.amount - 10n ** 12n},
      {amountReceivedLD: f.request.amount},
      {amountReceivedLD: f.request.amount - 1n},
      {amountReceivedLD: 0n},
    ]) {
      f.state.override = (read, result) => {
        if (read.functionName !== "quoteOFT") return result;
        const [limits, fees, receipt] = result as [unknown, unknown, Record<string, bigint>];
        return [limits, fees, {...receipt, ...change}];
      };
      await expect(f.quoter.quote(f.request)).rejects.toThrow();
    }
    f.state.override = undefined;
    f.state.lzTokenFee = 1n;
    await expect(f.quoter.quote(f.request)).rejects.toThrow(/LZ token/);
  });

  it("supports uint64 values above JS safe integers and rejects dust-only/overflow amounts", async () => {
    const f = setup();
    f.state.credit = (1n << 64n) - 1n;
    f.state.feeSD = 0n;
    const amount = f.state.credit * 10n ** 12n;
    expect((await f.quoter.quote({...f.request, amount})).destinationAmount).toBe(f.state.credit);
    for (const bad of [0n, -1n, 99n, amount + 10n ** 12n, 1n << 256n]) await expect(f.quoter.quote({...f.request, amount: bad})).rejects.toThrow();
  });

  it("quotes Taxi native drops with canonical type-3 encoding and Bus with its fixed drop", async () => {
    const f = setup();
    const taxi = await f.quoter.quote({...f.request, nativeDrop: {amount: 123n}});
    expect(taxi.sendParam.extraOptions).toBe(`0x000301003102${"7b".padStart(32, "0")}${recipient.slice(2).padStart(64, "0")}`);
    expect(taxi.nativeDrop).toBe(123n);
    const bus = await f.quoter.quote({...f.request, mode: "bus", nativeDrop: {bus: true}});
    expect(bus.sendParam.oftCmd).toBe("0x00");
    expect(bus.sendParam.extraOptions).toBe("0x01");
    expect(bus.nativeDrop).toBe(f.state.nativeDrop);
    for (const bad of [0n, -1n, 1n << 128n]) expect(() => taxiNativeDrop(bad, recipient)).toThrow();
    await expect(f.quoter.quote({...f.request, nativeDrop: {bus: true}})).rejects.toThrow(/Taxi/);
    await expect(f.quoter.quote({...f.request, mode: "bus", nativeDrop: {amount: 1n}})).rejects.toThrow(/Bus/);
    f.state.nativeDrop = 0n;
    await expect(f.quoter.quote({...f.request, mode: "bus", nativeDrop: {bus: true}})).rejects.toThrow(/unavailable/);
  });

  it("does not synthesize a Bus quote when its fare is unavailable", async () => {
    const f = setup();
    f.state.busUnavailable = true;
    await expect(f.quoter.quote({...f.request, mode: "bus"})).rejects.toThrow(/quote/);
    expect((await f.quoter.quote(f.request)).mode).toBe("taxi");
  });

  it.each(["token", "sharedDecimals", "decimals", "approvalRequired", "localEid", "endpoint", "stargateType", "assetIds", "stargateImpls", "peers", "eid", "status"])("rechecks %s on the destination, not only the sending chain", async (field) => {
    const f = setup();
    f.state.override = (read, result) => read.chain === f.destination.chain && read.functionName === field
      ? typeof result === "string" ? (field === "peers" ? pad(actor, {size: 32}) : actor) : typeof result === "boolean" ? !result : 99
      : result;
    await expect(f.quoter.quote(f.request)).rejects.toThrow(/identity|peer|active/);
  });

  it("requires both RPCs and refuses wrong-chain, stale, reorged and cancelled snapshots", async () => {
    const f = setup();
    const incomplete = createStargateQuoter({...f.config, rpcUrls: {[f.source.chain]: "https://source.test"}});
    expect(incomplete.supportsRoute(f.source.chain, f.source.token, f.destination.chain, f.destination.token)).toBe(false);
    await expect(incomplete.quote(f.request)).rejects.toThrow(/RPC/);
    for (const key of ["wrongChain", "stale", "reorg"] as const) {
      f.state[key] = true;
      await expect(f.quoter.quote(f.request)).rejects.toThrow(/chain id|stale|block changed/);
      f.state[key] = false;
    }
    await expect(f.quoter.quote(f.request, AbortSignal.abort())).rejects.toThrow(/cancelled/);
  });

  it("never leaks keyed RPC endpoints or transport bodies", async () => {
    const f = setup();
    const quoter = createStargateQuoter({...f.config, fetchImpl: async () => { throw new Error("URL: https://source.test/private-key request body secret"); }});
    await expect(quoter.quote(f.request)).rejects.toThrow(/^stargate: RPC read, quote or decoding failed$/);
  });

  it("takes a snapshot of mutable caller options and has no verified-state cache", async () => {
    const f = setup();
    const pending = f.quoter.quote(f.request);
    f.request.amount = 1n;
    expect((await pending).requestedAmount).toBe(10n ** 19n);
    f.request.amount = 10n ** 19n;
    f.state.override = (read, result) => read.functionName === "status" ? 3 : result;
    await expect(f.quoter.quote(f.request)).rejects.toThrow(/active/);
  });

  it("recognizes only exact addresses on reviewed cross-chain paths", () => {
    const f = setup();
    const supports = (s: StargateDeployment, d: StargateDeployment) => f.quoter.supportsRoute(s.chain, s.token, d.chain, d.token);
    expect(supports(f.source, f.destination)).toBe(true);
    expect(supports(f.source, f.source)).toBe(false);
    expect(f.quoter.supportsRoute(f.source.chain, "USDC", f.destination.chain, f.destination.token)).toBe(false);
    expect(f.quoter.supportsRoute(f.source.chain, actor, f.destination.chain, f.destination.token)).toBe(false);
  });
});
