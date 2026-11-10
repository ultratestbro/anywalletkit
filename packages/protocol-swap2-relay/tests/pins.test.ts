// The pins themselves: what a remote client checks a backend's build against, and what the watch job reads.
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {relay, RELAY_ALLOCATOR, RELAY_CHAINS, RELAY_OWNER, RELAY_SOLVERS, relayChain} from "../src/config.js";
import {relayPins} from "../src/verify.js";

const json = <T>(rel: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as T;
interface Source {id: string; type: string; chainId?: number; address?: string; to?: string; signature?: string; decode?: string; url?: string}
const manifest = json<{module: string; sources: Source[]}>("../watch.json");
const chains = Object.values(RELAY_CHAINS);
// Pinned by chain id before the chain has an RPC in the watch job.
const UNWATCHED = [99901];

describe("relay pins", () => {
  it("29 chains, each a lowercase depository, a slug and a CAIP-2 key of its own id", () => {
    expect(chains).toHaveLength(29);
    for (const [key, c] of Object.entries(RELAY_CHAINS)) {
      expect(key).toBe(`eip155:${c.chainId}`);
      expect(c.caip2).toBe(key);
      expect(c.depository).toMatch(/^0x[0-9a-f]{40}$/);
      expect(c.slug).toMatch(/^[a-z0-9-]+$/);
      expect(Object.isFrozen(c)).toBe(true);
    }
    expect(new Set(chains.map((c) => c.slug)).size).toBe(29);
    expect(Object.isFrozen(RELAY_CHAINS)).toBe(true);
  });

  it("two deployments: Mantle and Linea on the second, everything else on the first", () => {
    const second = chains.filter((c) => c.depository === "0x59916da825d2d2ec1bf878d71c88826f6633ecca").map((c) => c.chainId);
    expect(second).toEqual([5000, 59144]);
    expect(new Set(chains.map((c) => c.depository)).size).toBe(2);
  });

  it("order chain names that differ from Relay's display names, and Elysium by id", () => {
    expect(relayChain("eip155:56")!.slug).toBe("bnb");
    expect(relayChain("eip155:480")!.slug).toBe("worldchain");
    expect(relayChain("eip155:99901")).toMatchObject({slug: "elysium", depository: "0x4cd00e387622c35bddb9b4c962c136462338bc31"});
  });

  it("only own keys resolve; chains Relay does not serve and other families do not", () => {
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty", "eip155:14", "eip155:1329", "eip155:01", "eip155:1 ", "EIP155:1", "1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "", "eip155:"]) {
      expect(relayChain(k), k).toBeUndefined();
      expect(relay.supportsChain(k), k).toBe(false);
    }
    expect(relayChain(1 as unknown as string)).toBeUndefined();
    expect(relay.supports("eip155:1", "eip155:1")).toBe(false);
    expect(relay.supports("eip155:1", "eip155:8453")).toBe(true);
    expect(relay.supports("eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe(false);
  });

  it("one solver signer, on Base", () => {
    expect(RELAY_SOLVERS).toEqual([{chainId: "base", address: "0xf70da97812cb96acdf810712aa562db8dfa3dbef"}]);
    expect(Object.isFrozen(RELAY_SOLVERS)).toBe(true);
    expect(Object.isFrozen(RELAY_SOLVERS[0])).toBe(true);
  });

  it("remote pins: the depository is the only call target and the only spender, and nothing off the list", () => {
    for (const c of chains) {
      expect(relayPins.callTargets(c.caip2)).toEqual([c.depository]);
      expect(relayPins.spenders(c.caip2)).toEqual([c.depository]);
    }
    expect(relayPins.callTargets("eip155:14")).toEqual([]);
    expect(relayPins.spenders("constructor")).toEqual([]);
    expect(typeof relayPins.verifyQuote).toBe("function");
    expect(typeof relayPins.verifyBuild).toBe("function");
  });
});

describe("watch.json coverage", () => {
  it("names this module and its ids are unique", () => {
    expect(manifest.module).toBe("@anywalletkit/protocol-swap2-relay");
    const ids = manifest.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Relay's /chains is watched (the list the pins were read from)", () => {
    expect(manifest.sources.filter((s) => s.type === "http-json" && s.url === "https://api.relay.link/chains")).toHaveLength(1);
  });

  it("every pinned depository has its code, allocator() and owner() read on its chain", () => {
    const watched = chains.filter((c) => !UNWATCHED.includes(c.chainId));
    expect(watched).toHaveLength(28);
    for (const c of watched) {
      expect(manifest.sources.filter((s) => s.type === "evm-code" && s.chainId === c.chainId && s.address === c.depository), c.name).toHaveLength(1);
      for (const signature of ["allocator()", "owner()"]) {
        expect(manifest.sources.filter((s) => s.type === "evm-call" && s.chainId === c.chainId && s.to === c.depository && s.signature === signature && s.decode === "address"), `${c.name} ${signature}`).toHaveLength(1);
      }
    }
    // Nothing on chain is watched at an address that is not a pin.
    const pinned = new Set(chains.map((c) => `${c.chainId} ${c.depository}`));
    for (const s of manifest.sources.filter((x) => x.type.startsWith("evm-"))) expect(pinned.has(`${s.chainId} ${s.address ?? s.to}`), s.id).toBe(true);
    for (const id of UNWATCHED) expect(manifest.sources.some((s) => s.chainId === id)).toBe(false);
  });

  it("the allocator and owner the watch job will first read are the ones written down", () => {
    expect(RELAY_ALLOCATOR).toBe("0x63c1d3e9c646184529c5694630a01c00df171b56");
    expect(RELAY_OWNER).toBe("0xf61a305199fa1135d76ffab3752d42f55cbd775a");
  });

  it("module.json (the registry entry) lists exactly the pinned chains", () => {
    const listed = json<{chains: string[]; name: string; type: string}>("../module.json");
    expect(listed.name).toBe("@anywalletkit/protocol-swap2-relay");
    expect(listed.type).toBe("swap2");
    expect([...listed.chains].sort()).toEqual(Object.keys(RELAY_CHAINS).sort());
  });
});
