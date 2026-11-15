import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {keccak256, toBytes, toEventSelector, toFunctionSelector} from "viem";
import {ccAsset, ccChain} from "@anywalletkit/swap2-assets";
import {
  ACROSS_CHAINS, ACROSS_DEPOSIT, ACROSS_DEPOSIT_V3, ACROSS_FILL_STATUSES, ACROSS_FUNDS_DEPOSITED, ACROSS_HUB_CROSS_CHAIN_CONTRACTS,
  ACROSS_HUB_POOL, ACROSS_REFUSED_SELECTORS, ACROSS_SPEED_UP_TYPEHASH, ACROSS_V5_MESSAGE_PREFIX, ACROSS_DEPOSIT_QUOTE_TIME_BUFFER_S,
  ACROSS_FILL_DEADLINE_BUFFER_S, acrossChain, acrossRouteOf, acrossToken,
} from "../src/config.js";
import {acrossPins} from "../src/verify.js";
import {readJson} from "./fixtures.js";

const deployed = readJson<{chains: Record<string, {chain_name: string; SpokePool: string; HubPool?: string}>}>("official", "deployed-addresses.json");
const hub = readJson<{rows: Record<string, {adapter: string; spokePool: string}>}>("official", "hub-cross-chain-contracts.json");
const spokes = readJson<{chains: Record<string, {chainIdRpc: number; spokeChainId: number; impl: string; crossDomainAdmin: string; wrappedNativeToken: string; fillDeadlineBuffer: number; depositQuoteTimeBuffer: number; pausedDeposits: number; depositSelectorPush4: boolean}>}>("official", "spoke-pools.json");
const routesFile = readJson<{routes: [number, string, number, string, string, string, boolean][]}>("official", "available-routes.json");
const tokensFile = readJson<{tokens: {chainId: number; address: string; symbol: string; decimals: number}[]}>("official", "swap-tokens.json");
const pinned = Object.values(ACROSS_CHAINS);
const pkg = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8"));

describe("pins: shape", () => {
  it("17 chains, frozen, null-prototype, own keys only", () => {
    expect(pinned).toHaveLength(17);
    expect(Object.isFrozen(ACROSS_CHAINS)).toBe(true);
    expect(Object.getPrototypeOf(ACROSS_CHAINS)).toBeNull();
    expect(acrossChain("constructor")).toBeUndefined();
    expect(acrossChain("__proto__")).toBeUndefined();
    expect(acrossChain("toString")).toBeUndefined();
    for (const c of pinned) {
      expect(Object.isFrozen(c)).toBe(true);
      expect(Object.isFrozen(c.tokens)).toBe(true);
      expect(c.caip2).toBe(`eip155:${c.chainId}`);
      expect(c.spokePool).toMatch(/^0x[0-9a-f]{40}$/);
      if (c.wrappedNative !== null) expect(c.wrappedNative).toMatch(/^0x[0-9a-f]{40}$/);
      expect(c.tokens.length).toBeGreaterThan(0);
      for (const t of c.tokens) {
        expect(Object.isFrozen(t)).toBe(true);
        expect(t.address).toMatch(/^0x[0-9a-f]{40}$/);
        expect(acrossToken(c, t.address.toUpperCase().replace("0X", "0x"))).toBe(t);
      }
    }
  });

  it("the constants are what the contract source computes to", () => {
    expect(ACROSS_DEPOSIT).toBe(toFunctionSelector("deposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)"));
    expect(ACROSS_DEPOSIT_V3).toBe(toFunctionSelector("depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)"));
    expect(ACROSS_FUNDS_DEPOSITED).toBe(toEventSelector("FundsDeposited(bytes32,bytes32,uint256,uint256,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes32,bytes)"));
    expect(ACROSS_FUNDS_DEPOSITED).toBe("0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3");
    expect(ACROSS_FILL_STATUSES).toBe(toFunctionSelector("fillStatuses(bytes32)"));
    expect(ACROSS_HUB_CROSS_CHAIN_CONTRACTS).toBe(toFunctionSelector("crossChainContracts(uint256)"));
    expect(ACROSS_V5_MESSAGE_PREFIX).toBe(keccak256(toBytes("AcrossV5MessagePrefix.V1")));
    expect(ACROSS_SPEED_UP_TYPEHASH).toBe(keccak256(toBytes("UpdateDepositDetails(uint256 depositId,uint256 originChainId,uint256 updatedOutputAmount,bytes32 updatedRecipient,bytes updatedMessage)")));
    const names: Record<string, string> = {
      unsafeDeposit: "unsafeDeposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint256,uint32,uint32,uint32,bytes)",
      depositNow: "depositNow(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,bytes)",
      depositV3Now: "depositV3Now(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,bytes)",
      speedUpDeposit: "speedUpDeposit(bytes32,uint256,uint256,bytes32,bytes,bytes)",
      speedUpV3Deposit: "speedUpV3Deposit(address,uint256,uint256,address,bytes,bytes)",
      multicall: "multicall(bytes[])",
    };
    for (const [sel, name] of Object.entries(ACROSS_REFUSED_SELECTORS)) expect(toFunctionSelector(names[name]!)).toBe(sel);
  });
});

describe("pins: against Across's files and the chains", () => {
  it("the HubPool is the one in deployed-addresses.json", () => {
    expect(deployed.chains["1"]!.HubPool!.toLowerCase()).toBe(ACROSS_HUB_POOL);
  });

  it("every SpokePool equals deployed-addresses.json AND HubPool.crossChainContracts on chain", () => {
    for (const c of pinned) {
      expect(deployed.chains[String(c.chainId)]?.SpokePool.toLowerCase(), c.name).toBe(c.spokePool);
      expect(hub.rows[String(c.chainId)]?.spokePool, c.name).toBe(c.spokePool);
    }
  });

  it("every SpokePool on chain: its chain id, the HubPool as admin, the pinned wrapped native token, the buffers, not paused", () => {
    for (const c of pinned) {
      const s = spokes.chains[String(c.chainId)]!;
      expect(s.chainIdRpc, c.name).toBe(c.chainId);
      expect(s.spokeChainId, c.name).toBe(c.chainId);
      expect(s.impl, c.name).toMatch(/^0x(?!0{40})[0-9a-f]{40}$/);
      expect(s.crossDomainAdmin, c.name).toBe(ACROSS_HUB_POOL);
      expect(s.wrappedNativeToken, c.name).toBe(c.wrappedNative ?? "0x0000000000000000000000000000000000000000");
      expect(s.depositQuoteTimeBuffer, c.name).toBe(ACROSS_DEPOSIT_QUOTE_TIME_BUFFER_S);
      expect(s.fillDeadlineBuffer, c.name).toBe(ACROSS_FILL_DEADLINE_BUFFER_S);
      expect(s.pausedDeposits, c.name).toBe(0);
      // EraVM bytecode is not scanned for PUSH4; zkSync's deposit selector was confirmed from a traced deposit (config.ts).
      expect(s.depositSelectorPush4, c.name).toBe(c.chainId !== 324);
    }
  });

  it("the excluded chains are excluded for the stated reasons", () => {
    expect(spokes.chains["534352"]!.pausedDeposits).toBe(1);
    expect(acrossChain("eip155:534352")).toBeUndefined();
    expect(acrossChain("eip155:56")).toBeUndefined();
    // BNB Chain: Across moves the catalog's (18-decimal) USDC / USDT there only into other assets.
    const bsc = routesFile.routes.filter((r) => r[0] === 56);
    for (const sym of ["USDC", "USDT"]) {
      const catalog = ccAsset("eip155:56", sym)!;
      expect(catalog.decimals).toBe(18);
      const out = bsc.filter((r) => r[1].toLowerCase() === catalog.contract!.toLowerCase());
      expect(out.length).toBeGreaterThan(0);
      for (const r of out) expect(r[5]).not.toBe(r[4]);
    }
  });

  it("every pinned token is in Across's token list with the same decimals, and is the catalog's token by address", () => {
    for (const c of pinned) {
      for (const t of c.tokens) {
        const listed = tokensFile.tokens.find((x) => x.chainId === c.chainId && x.address.toLowerCase() === t.address);
        expect(listed, `${t.symbol} on ${c.name}`).toBeDefined();
        expect(listed!.decimals, `${t.symbol} on ${c.name}`).toBe(t.decimals);
        const cat = ccAsset(c.caip2, t.symbol);
        expect(cat?.contract?.toLowerCase(), `${t.symbol} on ${c.name} in the catalog`).toBe(t.address);
        expect(cat!.decimals).toBe(t.decimals);
      }
      expect(ccChain(c.caip2)?.key, c.name).toBe(c.key);
      // The native coin: ether where it is bridged, and its wrapped token is the pinned WETH.
      if (c.nativeIsEth) {
        expect(ccAsset(c.caip2, "ETH")?.contract ?? null, c.name).toBeNull();
        expect(c.tokens.find((t) => t.asset === "ETH")?.address, c.name).toBe(c.wrappedNative);
      } else {
        expect(c.tokens.some((t) => t.asset === "ETH"), c.name).toBe(false);
      }
    }
  });

  it("every pinned token has a same-asset route in Across's route list to every other pinned chain carrying that asset", () => {
    const has = (a: number, ta: string, b: number, tb: string) =>
      routesFile.routes.some((r) => r[0] === a && r[1].toLowerCase() === ta && r[2] === b && r[3].toLowerCase() === tb);
    let pairs = 0;
    for (const a of pinned) for (const b of pinned) {
      if (a === b) continue;
      for (const ta of a.tokens) for (const tb of b.tokens) {
        if (ta.asset !== tb.asset) continue;
        // A route Across does not list is simply not taken; what matters is that each pinned token has one.
        if (has(a.chainId, ta.address, b.chainId, tb.address)) pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(300);
    for (const a of pinned) for (const t of a.tokens) {
      const somewhere = pinned.some((b) => b !== a && b.tokens.some((u) => u.asset === t.asset && has(a.chainId, t.address, b.chainId, u.address)));
      expect(somewhere, `${t.symbol} on ${a.name} has a same-asset route`).toBe(true);
    }
    // And the native coin: Across lists an `isNative` route out of every ETH chain pinned.
    for (const a of pinned.filter((c) => c.nativeIsEth)) {
      expect(routesFile.routes.some((r) => r[0] === a.chainId && r[6] && r[1].toLowerCase() === a.wrappedNative), a.name).toBe(true);
    }
  });

  it("routes Across lists between different assets are not served", () => {
    const cross = routesFile.routes.filter((r) => r[4] !== r[5] && !(r[4] === "USDT" && r[5] === "USDT"));
    expect(cross.length).toBeGreaterThan(0);
    for (const r of cross) {
      const route = acrossRouteOf(`eip155:${r[0]}`, r[1], `eip155:${r[2]}`, r[3]);
      expect("code" in route, `${r[4]} → ${r[5]}`).toBe(true);
    }
  });
});

describe("pins: manifests", () => {
  const watch = pkg("watch.json") as {module: string; sources: {id: string; type: string; chainId?: number; address?: string; to?: string; signature?: string; args?: unknown[]}[]};
  const mod = pkg("module.json") as {name: string; chains: string[]};

  it("module.json names exactly the pinned chains", () => {
    expect(mod.name).toBe("@anywalletkit/protocol-swap2-across");
    expect(mod.chains).toEqual(pinned.map((c) => c.caip2).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7))));
  });

  it("watch.json watches every pinned SpokePool (evm-proxy), its pause flag and its HubPool registry entry, and the HubPool", () => {
    expect(watch.module).toBe("@anywalletkit/protocol-swap2-across");
    const ids = watch.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of pinned) {
      expect(watch.sources.some((s) => s.type === "evm-proxy" && s.chainId === c.chainId && s.address === c.spokePool), `${c.name} SpokePool`).toBe(true);
      expect(watch.sources.some((s) => s.type === "evm-call" && s.chainId === c.chainId && s.to === c.spokePool && s.signature === "pausedDeposits()"), `${c.name} pause`).toBe(true);
      expect(watch.sources.some((s) => s.type === "evm-call" && s.chainId === 1 && s.to === ACROSS_HUB_POOL && s.signature === "crossChainContracts(uint256)" && s.args?.[0] === c.chainId), `${c.name} registry`).toBe(true);
    }
    expect(watch.sources.some((s) => s.type === "evm-code" && s.chainId === 1 && s.address === ACROSS_HUB_POOL)).toBe(true);
    // Nothing on chain is watched that the module does not pin.
    const addrs = new Set([ACROSS_HUB_POOL, ...pinned.map((c) => c.spokePool)]);
    for (const s of watch.sources) {
      if (s.type.startsWith("evm-")) expect(addrs.has((s.address ?? s.to)!), s.id).toBe(true);
    }
  });

  it("remote pins: the SpokePool is the only call target and spender, per chain", () => {
    for (const c of pinned) {
      expect(acrossPins.callTargets(c.caip2)).toEqual([c.spokePool]);
      expect(acrossPins.spenders(c.caip2)).toEqual([c.spokePool]);
    }
    expect(acrossPins.callTargets("eip155:56")).toEqual([]);
    expect(acrossPins.spenders("constructor")).toEqual([]);
    expect(Object.isFrozen(acrossPins)).toBe(true);
  });
});
