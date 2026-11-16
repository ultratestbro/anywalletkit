// SDK-323: generate reviewable evidence, NEVER overwrite the runtime deployment pins.
import {createHash} from "node:crypto";
import {writeFile, rename} from "node:fs/promises";
import {getAddress, isAddress, zeroAddress, pad, parseAbi, keccak256} from "viem";
import {CC_SOURCE_CHAINS} from "@anywalletkit/swap2-assets";
import {builtinNetwork} from "@anywalletkit/networks";
import {STARGATE_ABI, TOKEN_MESSAGING_ABI} from "../dist/abi.js";
import {createStargateRegistry} from "../dist/registry.js";
import {context, workers, EvidenceError, stringify} from "./evidence.mjs";

const commit = "414f47412123d7737520c6ba331c1376ec874a88";
const base = `https://raw.githubusercontent.com/stargate-protocol/stargate-v2/${commit}/packages/stg-evm-v2`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const aliases = {bera: "berachain", plumephoenix: "plume"};
const assetNames = {1: "USDC", 2: "USDT", 13: "ETH", 22: "mETH", 23: "EURC"};
const aux = parseAbi(["function decimals() view returns (uint8)", "function eid() view returns (uint32)"]);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const assert = (ok, code) => { if (!ok) throw new EvidenceError(code); };
const artifactCache = new Map();
async function artifact(chain, name) {
  const key = `${chain}/${name}`;
  if (!artifactCache.has(key)) artifactCache.set(key, (async () => {
    for (const folder of ["deployments", "deployments-zk"]) {
      const url = `${base}/${folder}/${chain}-mainnet/${name}.json`;
      const res = await fetch(url, {signal: AbortSignal.timeout(20_000)});
      if (res.status === 404) continue;
      assert(res.ok, "upstream-unavailable");
      const raw = await res.text(); const doc = JSON.parse(raw);
      assert(isAddress(doc.address), "upstream-invalid-address");
      return {address: getAddress(doc.address), url, sha256: sha256(raw)};
    }
    throw new EvidenceError("no-pinned-upstream-artifact");
  })());
  return artifactCache.get(key);
}

async function capture() {
  const url = "https://mainnet.stargate-api.com/v1/metadata?version=v2";
  const response = await fetch(url, {signal: AbortSignal.timeout(20_000)});
  assert(response.ok, "metadata-unavailable");
  const raw = await response.text(); const data = JSON.parse(raw).data?.v2;
  assert(Array.isArray(data), "invalid-metadata");
  const discovered = data.map((r) => {
    assert(typeof r.chainKey === "string" && /^\d+$/.test(r.assetId) && isAddress(r.address) && isAddress(r.token?.address) && isAddress(r.tokenMessaging) && ["POOL", "OFT", "NATIVE"].includes(r.stargateType), "invalid-metadata-row");
    return {chainKey: r.chainKey, assetId: r.assetId, address: getAddress(r.address), tokenMessaging: getAddress(r.tokenMessaging), token: r.token, sharedDecimals: r.sharedDecimals, stargateType: r.stargateType};
  }).sort((a, b) => a.chainKey.localeCompare(b.chainKey) || Number(a.assetId) - Number(b.assetId));
  const byKey = new Map(CC_SOURCE_CHAINS.filter((c) => c.caip2.startsWith("eip155:")).map((c) => [c.key, c]));
  const chainKeys = [...new Set(discovered.map((r) => r.chainKey))];
  const states = new Map();
  const results = await workers(chainKeys, 4, async (key) => {
    const catalog = byKey.get(aliases[key] ?? key);
    const rows = discovered.filter((r) => r.chainKey === key);
    if (!catalog) return {chainKey: key, status: "unsupported-sdk-chain", discovered: rows.length, deployments: []};
    const chain = catalog.caip2, chainId = Number(chain.split(":")[1]);
    const network = builtinNetwork(chain);
    let ctx;
    try {
      assert(network?.family === "evm", "unsupported-sdk-chain");
      const urls = process.env[`RPC_${chainId}`] ? [process.env[`RPC_${chainId}`]] : network.rpcs.slice(0, 2);
      ctx = await context(chain, chainId, urls);
      const messagingArtifact = await artifact(key, "TokenMessaging");
      const verified = [], rejected = [];
      for (const row of rows) {
        try {
          const asset = assetNames[row.assetId]; assert(!!asset, "unsupported-asset-family");
          const name = row.stargateType === "NATIVE" ? "StargatePoolNative" : `Stargate${row.stargateType === "OFT" ? "OFT" : "Pool"}${asset}`;
          const contractArtifact = await artifact(key, name);
          assert(same(contractArtifact.address, row.address) && same(messagingArtifact.address, row.tokenMessaging), "metadata-upstream-address-mismatch");
          const [token, sharedDecimals, approvalRequired, eid, endpoint, status, type, config] = await Promise.all(["token", "sharedDecimals", "approvalRequired", "localEid", "endpoint", "status", "stargateType", "getAddressConfig"].map((fn) => ctx.read(row.address, STARGATE_ABI, fn)));
          const native = same(token, zeroAddress);
          const localDecimals = native ? network.decimals : await ctx.read(token, aux, "decimals");
          const [mappedId, mappedAddress, messagingEndpoint, endpointEid, code] = await Promise.all([
            ctx.read(row.tokenMessaging, TOKEN_MESSAGING_ABI, "assetIds", [row.address]),
            ctx.read(row.tokenMessaging, TOKEN_MESSAGING_ABI, "stargateImpls", [Number(row.assetId)]),
            ctx.read(row.tokenMessaging, TOKEN_MESSAGING_ABI, "endpoint"), ctx.read(endpoint, aux, "eid"),
            ctx.client.getBytecode({address: row.address, blockNumber: ctx.block.number}),
          ]);
          assert(native === (row.stargateType === "NATIVE") && (native ? same(row.token.address, zeroAddress) || same(row.token.address, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE") : same(token, row.token.address)), "token-mismatch");
          assert(localDecimals === row.token.decimals && sharedDecimals === row.sharedDecimals, "decimals-mismatch");
          assert(eid === endpointEid && same(endpoint, messagingEndpoint) && same(config.tokenMessaging, row.tokenMessaging), "messaging-mismatch");
          assert(String(mappedId) === row.assetId && same(mappedAddress, row.address), "asset-mapping-mismatch");
          assert(type === (row.stargateType === "OFT" ? 1 : 0) && status === 1 && code && code !== "0x", "deployment-type-code-or-status-mismatch");
          const deployment = {chain, chainId, eid, assetId: Number(row.assetId), symbol: row.token.symbol, token: getAddress(token), address: row.address, tokenMessaging: row.tokenMessaging, endpoint: getAddress(endpoint), localDecimals, sharedDecimals, kind: native ? "native" : type === 1 ? "oft" : "pool", approvalRequired};
          createStargateRegistry([deployment], []); // validate all integer/identity constraints
          const matches = catalog.assets.filter((a) => native ? !a.contract : a.contract && same(a.contract, token));
          verified.push({deployment, artifact: contractArtifact, messagingArtifact, codeHash: keccak256(code), catalogSymbols: matches.map((a) => a.symbol), catalogStatus: matches.length ? matches.every((a) => a.decimals === localDecimals) ? "matched" : "decimals-mismatch" : "missing-token"});
        } catch (error) { rejected.push({assetId: row.assetId, address: row.address, reason: error instanceof EvidenceError ? error.code : "rpc-or-upstream-error"}); }
      }
      await ctx.checkBlock();
      states.set(key, {ctx, verified});
      console.log(`${key}: ${verified.length} verified, ${rejected.length} rejected`);
      return {chainKey: key, chain, status: "checked", block: ctx.block, deployments: verified, rejected, calls: ctx.calls};
    } catch (error) {
      console.log(`${key}: unavailable`);
      return {chainKey: key, chain, status: "unverified", reason: error instanceof EvidenceError ? error.code : "rpc-or-upstream-error", deployments: []};
    }
  });
  const paths = [];
  await workers([...states], 3, async ([key, {ctx, verified}]) => {
    const src = verified[0]?.deployment; if (!src) return;
    for (const [dstKey, state] of states) {
      if (key === dstKey) continue;
      const dst = state.verified[0]?.deployment; if (!dst) continue;
      try {
        const peer = await ctx.read(src.tokenMessaging, TOKEN_MESSAGING_ABI, "peers", [dst.eid]);
        paths.push({source: src.chain, destination: dst.chain, peer, expectedPeer: pad(dst.tokenMessaging, {size: 32}), status: same(peer, pad(dst.tokenMessaging, {size: 32})) ? "verified" : "peer-mismatch"});
      } catch { paths.push({source: src.chain, destination: dst.chain, status: "unverified"}); }
    }
  });
  // Any reorg invalidates this capture as a whole, including deployment evidence.
  for (const {ctx} of states.values()) await ctx.checkBlock();
  const deployments = results.flatMap((r) => r.deployments.map((v) => v.deployment));
  const verifiedPaths = paths.filter((p) => p.status === "verified").map(({source, destination}) => ({source, destination}));
  createStargateRegistry(deployments, verifiedPaths);
  const report = {schemaVersion: 1, kind: "registry-candidate-evidence", capturedAt: new Date().toISOString(), upstreamCommit: commit, metadata: {url, sha256: sha256(raw)}, discovered, chains: results, paths: paths.sort((a, b) => a.source.localeCompare(b.source) || a.destination.localeCompare(b.destination))};
  const file = new URL("../tests/fixtures/registry.json", import.meta.url);
  const tmp = new URL("../tests/fixtures/registry.json.tmp", import.meta.url);
  await writeFile(tmp, stringify(report)); await rename(tmp, file);
  console.log(`Registry evidence: ${discovered.length} discovered deployments; ${deployments.length} verified; ${verifiedPaths.length} verified directed messaging paths. Runtime pins unchanged.`);
}
try { await capture(); } catch (error) {
  console.error(`Registry capture failed: ${error instanceof EvidenceError ? error.code : "RPC/API/validation error"}. Runtime pins unchanged.`);
  process.exitCode = 1;
}
