import {describe, expect, it} from "vitest";
import {zeroAddress} from "viem";
import {createStargateRegistry, type StargateDeployment} from "../src/registry.js";
import {stargateRegistry} from "../src/deployments.js";

const base = stargateRegistry.deployments.find((d) => d.chainId === 8453 && d.assetId === 1)!;
const bsc = stargateRegistry.deployments.find((d) => d.chainId === 56 && d.assetId === 1)!;
const forward = {source: base.chain, destination: bsc.chain};

describe("Stargate registry trust boundaries", () => {
  it("resolves exact token identities across different local decimals", () => {
    const route = stargateRegistry.route(base.chain, base.token.toLowerCase(), bsc.chain, bsc.token.toLowerCase())!;
    expect([route.source.localDecimals, route.destination.localDecimals]).toEqual([6, 18]);
    expect(stargateRegistry.find(base.chain, "USDC")).toBeUndefined();
    expect(stargateRegistry.find("eip155", `8453:${base.token}`)).toBeUndefined();
    expect(stargateRegistry.find(base.chain, base.token.toUpperCase().replace("0X", "0x"))).toBeDefined();
    expect(stargateRegistry.find(base.chain, "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA")).toBeUndefined(); // USDbC
    expect(stargateRegistry.route(base.chain, base.token, bsc.chain, stargateRegistry.deployments.find((d) => d.chainId === 56 && d.assetId === 2)!.token)).toBeUndefined();
  });

  it("requires evidence for the specific direction and rejects same-chain swaps", () => {
    const registry = createStargateRegistry([base, bsc], [forward]);
    expect(registry.route(base.chain, base.token, bsc.chain, bsc.token)).toBeDefined();
    expect(registry.route(bsc.chain, bsc.token, base.chain, base.token)).toBeUndefined();
    expect(registry.route(base.chain, base.token, base.chain, base.token)).toBeUndefined();
  });

  it("does not approve native pools or messaging contracts", () => {
    const native = stargateRegistry.find(base.chain, zeroAddress)!;
    expect(native.approvalRequired).toBe(true);
    expect(stargateRegistry.callTargets(base.chain)).toContain(native.address);
    expect(stargateRegistry.spenders(base.chain)).toEqual([base.address]);
    expect(stargateRegistry.callTargets(base.chain)).not.toContain(base.tokenMessaging);
    expect(stargateRegistry.spenders("eip155:999999")).toEqual([]);
    expect(createStargateRegistry([{...base, approvalRequired: false}], []).spenders(base.chain)).toEqual([]);
  });

  it("copies and freezes input so callers cannot mutate runtime pins", () => {
    const raw = {...base}, path = {...forward};
    const rows = [raw, {...bsc}], paths = [path];
    const registry = createStargateRegistry(rows, paths);
    raw.address = bsc.address; path.destination = base.chain; rows.length = 0; paths.length = 0;
    expect(registry.find(base.chain, base.token)?.address).toBe(base.address);
    expect(registry.route(base.chain, base.token, bsc.chain, bsc.token)).toBeDefined();
    expect(() => { (registry.deployments[0] as {address: string}).address = zeroAddress; }).toThrow();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.paths[0])).toBe(true);
    expect(Object.isFrozen(registry.callTargets(base.chain))).toBe(true);
  });

  it.each([
    {chainId: 1}, {eid: 0}, {eid: 2 ** 32}, {assetId: 65536}, {chainId: NaN},
    {address: zeroAddress}, {tokenMessaging: zeroAddress}, {endpoint: "bad"},
    {localDecimals: 5}, {sharedDecimals: -1}, {kind: "native"}, {token: zeroAddress},
    {approvalRequired: undefined}, {symbol: " "},
  ])("rejects malformed deployment %j", (change) => {
    expect(() => createStargateRegistry([{...base, ...change} as StargateDeployment], [])).toThrow();
  });

  it("rejects ambiguous identities, incompatible precision and inconsistent chain config", () => {
    for (const row of [
      {...base}, {...base, assetId: 99}, {...base, assetId: 99, token: bsc.token},
      {...bsc, eid: base.eid}, {...bsc, sharedDecimals: 5},
      {...base, assetId: 99, token: bsc.token, address: bsc.address, tokenMessaging: bsc.tokenMessaging},
    ]) expect(() => createStargateRegistry([base, row], [])).toThrow();
    for (const paths of [[forward, forward], [{source: base.chain, destination: base.chain}], [{source: base.chain, destination: "eip155:999"}]]) {
      expect(() => createStargateRegistry([base, bsc], paths)).toThrow();
    }
  });
});
