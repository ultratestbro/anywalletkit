// Every address this module pins has a source in watch.json on every chain of the table — a new chain in chains.ts
// without a watch entry fails here. The Settler registry is the trust root (whatever it names is the accepted Settler)
// and an ERC-1967 proxy: it is watched as a proxy (implementation slot and code) with its owner(), not by the code of
// its forwarder alone, which an upgrade or an ownership change would leave unchanged. What it names — ownerOf(2), the
// Settler in force — is watched too: a new 0x deployment shows up in the digest the day it happens (native-coin sales to
// it are refused from then until the chain's newestLiveNonce / previousLiveNonce are raised; verify:live on the canary
// fails as long as the registry names anything else than the pinned current and previous Settlers).
// The instance it replaced — prev(2), the oldest Settler a swap may go to — is watched on every chain as well: a change
// without a new deployment is a rollback or a re-pointed registry. A new Settler in force is the one change that refuses
// native-coin sales from the day it happens, so its source carries severity "high" (the digest and the diff say so).
// Permit2 and the wrapped natives are watched by their code. Every count below is derived from the chain table.
import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {toFunctionSelector} from "viem";
import {ZEROEX_CHAINS, ZEROEX_PERMIT2} from "../src/chains.js";
import {zeroExProvider} from "../src/provider.js";
import {REGISTRY_OWNER_OF_SELECTOR, REGISTRY_PREV_SELECTOR} from "../src/settler.js";

interface Source {id: string; type: string; chainId?: number; address?: string; to?: string; signature?: string; args?: unknown[]; decode?: string; repo?: string; label?: string; severity?: string}
const read = (file: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8"));
const manifest = read("watch.json") as {module: string; sources: Source[]};
const of = (type: string, key: "address" | "to" = "address") => new Set(manifest.sources.filter((s) => s.type === type).map((s) => `${s.chainId} ${s[key]!.toLowerCase()}`));
const watched = of("evm-code");
const CHAINS = Object.keys(ZEROEX_CHAINS).length;

describe("watch.json coverage", () => {
  it("names this module", () => expect(manifest.module).toBe("@anywalletkit/protocol-swap2-0x"));
  it("every pinned Permit2 and wrapped native has an evm-code source on its chain", () => {
    const pinned: string[] = [];
    for (const [id, c] of Object.entries(ZEROEX_CHAINS)) pinned.push(`${id} ${ZEROEX_PERMIT2.toLowerCase()}`, `${id} ${c.wrappedNative!.toLowerCase()}`);
    expect(CHAINS).toBe(8);
    expect(pinned).toHaveLength(2 * CHAINS);
    expect(pinned.filter((p) => !watched.has(p))).toEqual([]);
    expect(watched.size).toBe(2 * CHAINS);
  });
  it("every chain's Settler registry is watched as an ERC-1967 proxy and by its owner()", () => {
    const registries = Object.entries(ZEROEX_CHAINS).map(([id, c]) => `${id} ${c.registry.toLowerCase()}`);
    expect(registries).toHaveLength(CHAINS);
    const proxies = of("evm-proxy");
    expect(registries.filter((r) => !proxies.has(r))).toEqual([]);
    expect(proxies.size).toBe(CHAINS);
    const calls = manifest.sources.filter((s) => s.type === "evm-call");
    const owners = calls.filter((s) => s.signature === "owner()");
    expect(owners.every((s) => s.decode === "address" && s.args === undefined)).toBe(true);
    expect(new Set(owners.map((s) => `${s.chainId} ${s.to!.toLowerCase()}`))).toEqual(new Set(registries));
    expect(owners).toHaveLength(CHAINS);
    // the Settler in force on every chain: a new deployment is a diff, and the one that refuses native-coin sales
    const inForce = calls.filter((s) => s.signature === "ownerOf(uint256)");
    expect(inForce.every((s) => s.decode === "address" && JSON.stringify(s.args) === "[2]" && /newestLiveNonce \/ previousLiveNonce/.test(s.label!))).toBe(true);
    expect(new Set(inForce.map((s) => `${s.chainId} ${s.to!.toLowerCase()}`))).toEqual(new Set(registries));
    expect(inForce).toHaveLength(CHAINS);
    expect(inForce.map((s) => s.severity)).toEqual(inForce.map(() => "high"));
    // the instance it replaced on every chain: prev(uint128) [2], selector 0xe2603dc2 (the registry's own ABI)
    const previous = calls.filter((s) => s.signature === "prev(uint128)");
    expect(previous.every((s) => s.decode === "address" && JSON.stringify(s.args) === "[2]" && /previousLiveNonce/.test(s.label!))).toBe(true);
    expect(new Set(previous.map((s) => `${s.chainId} ${s.to!.toLowerCase()}`))).toEqual(new Set(registries));
    expect(previous).toHaveLength(CHAINS);
    expect(toFunctionSelector("prev(uint128)")).toBe(REGISTRY_PREV_SELECTOR);
    expect(toFunctionSelector("ownerOf(uint256)")).toBe(REGISTRY_OWNER_OF_SELECTOR);
    expect(calls).toHaveLength(3 * CHAINS);
    // only the Settler in force carries a severity
    expect(manifest.sources.filter((s) => s.severity !== undefined).map((s) => s.id)).toEqual(inForce.map((s) => s.id));
    // the forwarder's code alone is not a watch on the trust root
    for (const r of registries) expect(watched.has(r), r).toBe(false);
  });
  it("code sources come only from 0x's own Settler repository, and every source is labelled", () => {
    for (const s of manifest.sources) {
      if (s.repo !== undefined) expect(s.repo).toBe("0xProject/0x-settler");
      expect(s.label, s.id).toBeTruthy();
    }
    expect(manifest.sources.filter((s) => s.type === "github-file").length).toBeGreaterThanOrEqual(3);
  });
  it("module.json (the registry entry) names exactly the chains the provider offers", () => {
    const listed = (read("module.json") as {chains: string[]}).chains;
    const p = zeroExProvider({apiKey: () => "placeholder", rpcUrls: {}});
    expect(listed).toEqual(Object.keys(ZEROEX_CHAINS).map((id) => `eip155:${id}`));
    for (const c of listed) expect(p.supportsChain!(c), c).toBe(true);
  });
  it("ids are unique", () => {
    const ids = manifest.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
