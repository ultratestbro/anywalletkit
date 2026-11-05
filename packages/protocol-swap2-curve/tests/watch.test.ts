// Every router this module pins (and the older Ethereum routers it recognizes, and every AddressProvider it compares
// with) has an evm-code source in watch.json on its chain — a new chain in deployments.ts without a watch entry fails.
import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {CURVE_DEPLOYMENTS, CURVE_LEGACY_ROUTERS} from "../src/deployments.js";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../watch.json", import.meta.url)), "utf8")) as {module: string; sources: {id: string; type: string; chainId?: number; address?: string}[]};
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
  it("ids are unique", () => {
    const ids = manifest.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
