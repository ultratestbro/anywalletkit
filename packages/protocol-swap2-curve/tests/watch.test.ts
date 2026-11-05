// Every router this module pins (and the older Ethereum routers it recognizes, and every AddressProvider it compares
// with) has an evm-code source in watch.json on its chain — a new chain in deployments.ts without a watch entry fails.
import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {CURVE_DEPLOYMENTS, CURVE_LEGACY_ROUTERS} from "../src/deployments.js";

interface Source {id: string; type: string; chainId?: number; address?: string; to?: string; signature?: string; args?: unknown[]; decode?: string; format?: string; pins?: {from: string; export: string; group: string; roles: Record<string, string>}}
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../watch.json", import.meta.url)), "utf8")) as {module: string; sources: Source[]};
const watched = new Set(manifest.sources.filter((s) => s.type === "evm-code").map((s) => `${s.chainId} ${s.address!.toLowerCase()}`));

describe("watch.json coverage", () => {
  it("names this module", () => expect(manifest.module).toBe("@anywalletkit/protocol-swap2-curve"));
  it("every pinned router, legacy router and AddressProvider has an evm-code source on its chain", () => {
    const pinned: string[] = [];
    for (const [id, d] of Object.entries(CURVE_DEPLOYMENTS)) pinned.push(`${id} ${d.router.toLowerCase()}`, `${id} ${d.addressProvider.toLowerCase()}`);
    for (const [id, list] of Object.entries(CURVE_LEGACY_ROUTERS)) for (const r of list) pinned.push(`${id} ${r.router.toLowerCase()}`);
    expect(pinned.length).toBeGreaterThanOrEqual(38);
    expect(pinned.filter((p) => !watched.has(p))).toEqual([]);
  });
  it("every pinned router's version() is read on its chain, decoded as a string", () => {
    const calls = manifest.sources.filter((s) => s.type === "evm-call" && s.signature === "version()" && s.decode === "string");
    for (const [id, d] of Object.entries(CURVE_DEPLOYMENTS)) {
      expect(calls.filter((s) => s.chainId === Number(id) && s.to!.toLowerCase() === d.router.toLowerCase()), `chain ${id}`).toHaveLength(1);
    }
  });
  it("every AddressProvider's id 2 is read; Ethereum's names the older router, which is pinned as what it is", () => {
    for (const [id, d] of Object.entries(CURVE_DEPLOYMENTS)) {
      const ap = manifest.sources.filter((s) => s.type === "evm-call" && s.chainId === Number(id) && s.to!.toLowerCase() === d.addressProvider.toLowerCase());
      expect(ap, `chain ${id}`).toHaveLength(1);
      expect(ap[0]!.args).toEqual([2]);
    }
    const eth = manifest.sources.find((s) => s.id === "address-provider-id2-ethereum")!;
    expect(eth).toMatchObject({signature: "get_id_info(uint256)", decode: "(address,string,uint256,uint256)"});
    // id 2 there is Router NG v1.1 (history only), not the v1.2 router the module pins and quotes on.
    expect(CURVE_DEPLOYMENTS[1]!.addressProviderRouter).toBe(CURVE_LEGACY_ROUTERS[1]![0]!.router);
    expect(CURVE_DEPLOYMENTS[1]!.addressProviderRouter).not.toBe(CURVE_DEPLOYMENTS[1]!.router);
    expect((eth as {label?: string}).label).toMatch(/older Router NG v1\.1/);
  });
  it("deployments.json pins every router and AddressProvider by chain id (curve-deployments)", () => {
    const j = manifest.sources.filter((s) => s.type === "json-pins" && s.format === "curve-deployments");
    expect(j).toHaveLength(1);
    expect(j[0]!.pins).toEqual({from: "dist/index.js", export: "CURVE_DEPLOYMENTS", group: "$key", roles: {router: "router", addressProvider: "address-provider"}});
    for (const field of Object.keys(j[0]!.pins!.roles)) for (const d of Object.values(CURVE_DEPLOYMENTS)) expect(d).toHaveProperty(field);
  });
  it("ids are unique", () => {
    const ids = manifest.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
