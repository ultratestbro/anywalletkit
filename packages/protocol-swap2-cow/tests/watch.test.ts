// Every contract this module pins has its code, and the reads that tie the three contracts together, watched on its
// chain in watch.json — a new chain in deployments.ts without watch entries fails here.
import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {COW_DEPLOYMENTS} from "../src/deployments.js";

interface Source {id: string; type: string; chainId?: number; address?: string; to?: string; signature?: string; decode?: string; repo?: string; path?: string}
const read = (file: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8")) as Record<string, unknown>;
const manifest = read("watch.json") as unknown as {module: string; sources: Source[]};
const code = new Set(manifest.sources.filter((s) => s.type === "evm-code").map((s) => `${s.chainId} ${s.address!.toLowerCase()}`));
const calls = (chainId: number, to: string, signature: string) => manifest.sources.filter((s) => s.type === "evm-call" && s.chainId === chainId && s.to!.toLowerCase() === to.toLowerCase() && s.signature === signature);

describe("watch.json coverage", () => {
  it("names this module", () => expect(manifest.module).toBe("@anywalletkit/protocol-swap2-cow"));
  it("the settlement contract, the vault relayer and eth-flow have an evm-code source on every chain", () => {
    const pinned = Object.values(COW_DEPLOYMENTS).flatMap((d) => [d.settlement, d.vaultRelayer, d.ethFlow].map((a) => `${d.chainId} ${a.toLowerCase()}`));
    expect(pinned).toHaveLength(9);
    expect(pinned.filter((p) => !code.has(p))).toEqual([]);
  });
  it("the domain separator, the settlement's vault relayer and eth-flow's settlement and wrapped native are read on every chain", () => {
    for (const d of Object.values(COW_DEPLOYMENTS)) {
      expect(calls(d.chainId, d.settlement, "domainSeparator()").map((s) => s.decode), `chain ${d.chainId}`).toEqual(["bytes32"]);
      expect(calls(d.chainId, d.settlement, "vaultRelayer()").map((s) => s.decode), `chain ${d.chainId}`).toEqual(["address"]);
      expect(calls(d.chainId, d.ethFlow, "cowSwapSettlement()").map((s) => s.decode), `chain ${d.chainId}`).toEqual(["address"]);
      expect(calls(d.chainId, d.ethFlow, "wrappedNativeToken()").map((s) => s.decode), `chain ${d.chainId}`).toEqual(["address"]);
    }
  });
  it("the official deployment files and the sources the encoders were written from are watched", () => {
    const files = new Set(manifest.sources.filter((s) => s.type === "github-file").map((s) => `${s.repo} ${s.path}`));
    for (const d of Object.values(COW_DEPLOYMENTS)) expect(files.has(`cowprotocol/ethflowcontract broadcast/Deploy.sol/${d.chainId}/deployment.prod.json`), `chain ${d.chainId}`).toBe(true);
    for (const f of ["cowprotocol/contracts networks.json", "cowprotocol/contracts src/contracts/libraries/GPv2Order.sol", "cowprotocol/contracts src/contracts/mixins/GPv2Signing.sol", "cowprotocol/ethflowcontract src/CoWSwapEthFlow.sol", "cowprotocol/ethflowcontract src/libraries/EthFlowOrder.sol", "cowprotocol/services crates/orderbook/openapi.yml"]) {
      expect(files.has(f), f).toBe(true);
    }
  });
  it("module.json (the registry entry) names exactly the shipped chains", () => {
    const listed = read("module.json").chains as string[];
    expect([...listed].sort()).toEqual(Object.keys(COW_DEPLOYMENTS).map((id) => `eip155:${id}`).sort());
  });
  it("ids are unique", () => {
    const ids = manifest.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
