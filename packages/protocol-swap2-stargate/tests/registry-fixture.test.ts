import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {decodeFunctionData, decodeFunctionResult, encodeFunctionResult, pad, parseAbi, type Abi, type Hex} from "viem";
import {CC_SOURCE_CHAINS} from "@anywalletkit/swap2-assets";
import {STARGATE_ABI, TOKEN_MESSAGING_ABI} from "../src/abi.js";
import {STARGATE_REGISTRY_EVIDENCE, stargateRegistry} from "../src/deployments.js";
import type {StargateDeployment} from "../src/registry.js";

type Call = {to: string; functionName: string; data: Hex; result: Hex};
type Evidence = {deployment: StargateDeployment; catalogStatus: string; artifact: {address: string; url: string; sha256: string}; messagingArtifact: {address: string}; codeHash: Hex};
const raw = readFileSync(new URL("./fixtures/registry.json", import.meta.url), "utf8");
const snapshot = JSON.parse(raw) as {
  upstreamCommit: string; chains: {chain?: string; status: string; block?: {number: string; hash: Hex}; deployments: Evidence[]; calls?: Call[]}[];
  paths: {source: string; destination: string; status: string; peer?: Hex}[];
};
const abi: Abi = [...STARGATE_ABI, ...TOKEN_MESSAGING_ABI, ...parseAbi(["function decimals() view returns (uint8)", "function eid() view returns (uint32)"])];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

describe("reviewed registry evidence", () => {
  it("binds runtime pins to the reviewed evidence and excludes unverified or unlisted assets", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(STARGATE_REGISTRY_EVIDENCE.sha256);
    expect(snapshot.upstreamCommit).toBe(STARGATE_REGISTRY_EVIDENCE.upstreamCommit);
    const verified = snapshot.chains.flatMap((c) => c.deployments).filter((v) => v.catalogStatus === "matched");
    expect(stargateRegistry.deployments).toEqual(verified.map((v) => v.deployment));
    expect(stargateRegistry.deployments).toHaveLength(25);
    for (const d of stargateRegistry.deployments) {
      const catalog = CC_SOURCE_CHAINS.find((c) => c.caip2 === d.chain)!;
      expect(catalog.assets.some((a) => a.decimals === d.localDecimals && (d.kind === "native" ? !a.contract : a.contract && same(a.contract, d.token)))).toBe(true);
    }
  });

  it("replays raw contract responses and checks identities against artifacts", () => {
    for (const chain of snapshot.chains.filter((c) => c.status === "checked")) {
      expect(BigInt(chain.block!.number)).toBeGreaterThan(0n);
      expect(chain.block!.hash).toMatch(/^0x[0-9a-f]{64}$/);
      for (const call of chain.calls!) {
        expect(decodeFunctionData({abi, data: call.data}).functionName).toBe(call.functionName);
        const result = decodeFunctionResult({abi, functionName: call.functionName, data: call.result});
        expect(encodeFunctionResult({abi, functionName: call.functionName, result})).toBe(call.result);
      }
      const read = (to: string, functionName: string, args: unknown[] = []) => {
        const call = chain.calls!.find((c) => same(c.to, to) && c.functionName === functionName && JSON.stringify(decodeFunctionData({abi, data: c.data}).args ?? []) === JSON.stringify(args));
        expect(call, `${chain.chain} ${functionName}`).toBeDefined();
        return decodeFunctionResult({abi, functionName, data: call!.result});
      };
      for (const {deployment: d, artifact, messagingArtifact, codeHash} of chain.deployments) {
        expect(artifact.address).toBe(d.address);
        expect(artifact.url).toContain(`/${snapshot.upstreamCommit}/`);
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(codeHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(messagingArtifact.address).toBe(d.tokenMessaging);
        for (const [fn, expected] of Object.entries({token: d.token, sharedDecimals: d.sharedDecimals, approvalRequired: d.approvalRequired, localEid: d.eid, endpoint: d.endpoint, status: 1, stargateType: d.kind === "oft" ? 1 : 0})) {
          expect(read(d.address, fn)).toBe(expected);
        }
        expect(read(d.tokenMessaging, "assetIds", [d.address])).toBe(d.assetId);
        expect(read(d.tokenMessaging, "stargateImpls", [d.assetId])).toBe(d.address);
        expect(read(d.tokenMessaging, "endpoint")).toBe(d.endpoint);
        expect(read(d.endpoint, "eid")).toBe(d.eid);
        expect(read(d.address, "getAddressConfig")).toMatchObject({tokenMessaging: d.tokenMessaging});
        if (d.kind !== "native") expect(read(d.token, "decimals")).toBe(d.localDecimals);
      }
    }
  });

  it("pins only directions backed by the source messaging peer response", () => {
    const chains = new Set(stargateRegistry.deployments.map((d) => d.chain));
    expect(stargateRegistry.paths).toEqual(snapshot.paths.filter((p) => p.status === "verified" && chains.has(p.source) && chains.has(p.destination)).map(({source, destination}) => ({source, destination})));
    for (const path of stargateRegistry.paths) {
      const source = stargateRegistry.deployments.find((d) => d.chain === path.source)!;
      const dst = stargateRegistry.deployments.find((d) => d.chain === path.destination)!;
      const call = snapshot.chains.find((c) => c.chain === path.source)!.calls!.find((c) => same(c.to, source.tokenMessaging) && c.functionName === "peers" && decodeFunctionData({abi, data: c.data}).args?.[0] === dst.eid)!;
      expect(decodeFunctionResult({abi, functionName: "peers", data: call.result})).toBe(pad(dst.tokenMessaging.toLowerCase() as Hex, {size: 32}));
    }
  });
});
