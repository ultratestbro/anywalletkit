// SDK-322: eth_call only. No wallet, signing, approval, transaction submission or API key.
// Run after build. Optional RPC_8453/RPC_42161/RPC_56 override URLs are never persisted.
// Writes the fixture only after every requested check succeeds.
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile, rename} from "node:fs/promises";
import {createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionResult, decodeErrorResult, getAddress, pad, keccak256, zeroAddress} from "viem";
import {STARGATE_ABI, TOKEN_MESSAGING_ABI} from "../dist/abi.js";
import {destinationAmount} from "../dist/amounts.js";

const CHAIN = {
  base: {id: 8453, eid: 30184, rpc: "https://base-rpc.publicnode.com"},
  arbitrum: {id: 42161, eid: 30110, rpc: "https://arbitrum-one-rpc.publicnode.com"},
  bsc: {id: 56, eid: 30102, rpc: "https://bsc-rpc.publicnode.com"},
};
const cases = [
  {source: "base", destination: "arbitrum", assetId: "1", amountLD: "10000000"},
  {source: "base", destination: "arbitrum", assetId: "13", amountLD: "1000000000000000"},
  {source: "bsc", destination: "base", assetId: "1", amountLD: "10000000000000000000"},
  {source: "base", destination: "bsc", assetId: "1", amountLD: "10000000"},
];
const auxiliaryAbi = parseAbi(["function decimals() view returns (uint8)", "function eid() view returns (uint32)"]);
const account = "0x0000000000000000000000000000000000000001";
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const json = (value) => JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n";
let stage = "metadata";
class CaptureValidationError extends Error {}
class ObservedRevert extends Error {
  constructor(functionName, data) { super("observed eth_call revert"); this.functionName = functionName; this.data = data; }
}

async function capture() {
  const metadataUrl = "https://mainnet.stargate-api.com/v1/metadata?version=v2";
  const response = await fetch(metadataUrl, {signal: AbortSignal.timeout(20_000)});
  if (!response.ok) throw new CaptureValidationError(`metadata: HTTP ${response.status}`);
  const raw = await response.text();
  const rows = JSON.parse(raw).data.v2;
  const find = (chain, assetId) => {
    const found = rows.filter((r) => r.chainKey === chain && r.assetId === assetId);
    if (found.length !== 1) throw new CaptureValidationError(`metadata: ambiguous or missing ${chain}:${assetId}`);
    return found[0];
  };
  const clients = new Map(), blocks = {}, calls = [], deployments = new Map();
  for (const [name, cfg] of Object.entries(CHAIN)) {
    stage = `${name}: block identity`;
    const client = createPublicClient({transport: http(process.env[`RPC_${cfg.id}`] ?? cfg.rpc, {timeout: 15_000, retryCount: 1}), ccipRead: false});
    if (await client.getChainId() !== cfg.id) throw new CaptureValidationError(`${name}: wrong RPC chain`);
    const latest = await client.getBlockNumber();
    const block = await client.getBlock({blockNumber: latest - 24n});
    if (!block.hash || block.number === null) throw new Error(`${name}: missing block identity`);
    blocks[name] = {chainId: cfg.id, eid: cfg.eid, number: block.number, hash: block.hash, timestamp: block.timestamp};
    clients.set(name, client);
  }
  async function read(chain, address, abi, functionName, args = []) {
    stage = `${chain}: ${functionName}`;
    const data = encodeFunctionData({abi, functionName, args});
    const blockNumber = blocks[chain].number;
    let result;
    try {
      result = await clients.get(chain).call({account, to: getAddress(address), data, blockNumber});
    } catch (error) {
      let cause = error, reverted = false, revertData;
      while (cause) {
        if (cause.name === "ExecutionRevertedError" || cause.code === 3) reverted = true;
        if (typeof cause.data === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(cause.data)) revertData = cause.data;
        cause = cause.cause;
      }
      if (!reverted || !revertData) throw error; // transport failures must not look like unavailable routes
      calls.push({chain, blockNumber, to: getAddress(address), from: account, functionName, data, error: {kind: "reverted", data: revertData}});
      throw new ObservedRevert(functionName, revertData);
    }
    if (!result.data) throw new Error(`${chain}: empty ${functionName} response`);
    const decoded = decodeFunctionResult({abi, functionName, data: result.data});
    calls.push({chain, blockNumber, to: getAddress(address), from: account, functionName, data, result: result.data});
    return decoded;
  }
  async function deployment(chain, assetId) {
    const key = `${chain}:${assetId}`;
    if (deployments.has(key)) return deployments.get(key);
    const row = find(chain, assetId);
    const address = getAddress(row.address);
    const [token, sharedDecimals, approvalRequired, localEid, endpoint, status, stargateType, config] = await Promise.all(
      ["token", "sharedDecimals", "approvalRequired", "localEid", "endpoint", "status", "stargateType", "getAddressConfig"].map((fn) => read(chain, address, STARGATE_ABI, fn)),
    );
    const native = same(token, zeroAddress);
    const localDecimals = native ? 18 : await read(chain, token, auxiliaryAbi, "decimals");
    const messaging = config.tokenMessaging;
    const [mappedId, mappedPool, messagingEndpoint, endpointEid, code] = await Promise.all([
      read(chain, messaging, TOKEN_MESSAGING_ABI, "assetIds", [address]),
      read(chain, messaging, TOKEN_MESSAGING_ABI, "stargateImpls", [Number(assetId)]),
      read(chain, messaging, TOKEN_MESSAGING_ABI, "endpoint"),
      read(chain, endpoint, auxiliaryAbi, "eid"),
      clients.get(chain).getBytecode({address, blockNumber: blocks[chain].number}),
    ]);
    // Metadata uses a native-token sentinel; token() is authoritative for native identity.
    if ((!native && !same(token, row.token.address)) || (native && row.stargateType !== "NATIVE") || localDecimals !== row.token.decimals || sharedDecimals !== row.sharedDecimals || localEid !== CHAIN[chain].eid || endpointEid !== localEid || !same(messaging, row.tokenMessaging) || String(mappedId) !== assetId || !same(mappedPool, address) || !same(messagingEndpoint, endpoint) || stargateType !== (row.stargateType === "OFT" ? 1 : 0) || status !== 1 || !code || code === "0x") {
      throw new CaptureValidationError(`${key}: deployment identity/status mismatch (token=${token}, native=${native}, decimals=${localDecimals}/${sharedDecimals}, eid=${localEid}/${endpointEid}, assetId=${mappedId}, type=${stargateType}, status=${status})`);
    }
    const observed = {chain, chainId: CHAIN[chain].id, eid: localEid, assetId, address, token, localDecimals, sharedDecimals, native, approvalRequired, tokenMessaging: messaging, endpoint, stargateType, status, codeHash: keccak256(code), metadata: row};
    deployments.set(key, observed);
    return observed;
  }
  const routes = [];
  for (const c of cases) {
    const src = await deployment(c.source, c.assetId);
    const dst = await deployment(c.destination, c.assetId);
    if (src.sharedDecimals !== dst.sharedDecimals) throw new Error("shared decimals mismatch");
    const peer = await read(c.source, src.tokenMessaging, TOKEN_MESSAGING_ABI, "peers", [dst.eid]);
    if (!same(peer, pad(dst.tokenMessaging, {size: 32}))) throw new CaptureValidationError(`${c.source}: destination peer mismatch`);
    const credit = await read(c.source, src.address, STARGATE_ABI, "paths", [dst.eid]);
    for (const mode of ["taxi", "bus"]) {
      const param = {dstEid: dst.eid, to: pad(account, {size: 32}), amountLD: BigInt(c.amountLD), minAmountLD: 0n, extraOptions: "0x", composeMsg: "0x", oftCmd: mode === "taxi" ? "0x" : "0x00"};
      try {
      const [limit, feeDetails, receipt] = await read(c.source, src.address, STARGATE_ABI, "quoteOFT", [param]);
      if (param.amountLD < limit.minAmountLD || param.amountLD > limit.maxAmountLD || receipt.amountSentLD !== param.amountLD || receipt.amountReceivedLD === 0n) throw new CaptureValidationError(`${c.source}:${mode}: amount unavailable`);
      param.minAmountLD = receipt.amountReceivedLD;
      const fee = await read(c.source, src.address, STARGATE_ABI, "quoteSend", [param, false]);
      routes.push({...c, mode, sourceDeployment: `${c.source}:${c.assetId}`, destinationDeployment: `${c.destination}:${c.assetId}`, creditSD: credit, sendParam: param, limit, feeDetails, receipt, fee, destinationAmountLD: destinationAmount(receipt.amountReceivedLD, src.localDecimals, dst.localDecimals, src.sharedDecimals)});
      } catch (error) {
        if (!(error instanceof ObservedRevert)) throw error;
        let decoded;
        try { decoded = decodeErrorResult({abi: TOKEN_MESSAGING_ABI, data: error.data}); } catch { /* preserve unknown raw revert */ }
        routes.push({...c, mode, sourceDeployment: `${c.source}:${c.assetId}`, destinationDeployment: `${c.destination}:${c.assetId}`, creditSD: credit, sendParam: param, unavailable: {functionName: error.functionName, revertData: error.data, ...(decoded ? {errorName: decoded.errorName, args: decoded.args} : {})}});
      }
    }
  }
  // Detect a reorg during capture; a fixture never silently mixes two hashes at one height.
  for (const [name, block] of Object.entries(blocks)) {
    if ((await clients.get(name).getBlock({blockNumber: block.number})).hash !== block.hash) throw new Error(`${name}: block changed during capture`);
  }
  const provenance = JSON.parse(await readFile(new URL("../tests/fixtures/upstream.json", import.meta.url), "utf8"));
  const snapshot = {schemaVersion: 1, kind: "mainnet-read-only", capturedAt: new Date().toISOString(), account, upstreamCommit: provenance.commit, metadata: {url: metadataUrl, sha256: createHash("sha256").update(raw).digest("hex"), deploymentsDiscovered: rows.length, chainsDiscovered: new Set(rows.map((r) => r.chainKey)).size}, blocks, deployments: Object.fromEntries(deployments), routes, calls};
  const dir = new URL("../tests/fixtures/", import.meta.url);
  await mkdir(dir, {recursive: true});
  const temp = new URL("mainnet.json.tmp", dir);
  await writeFile(temp, json(snapshot));
  await rename(temp, new URL("mainnet.json", dir));
  console.log(`Captured ${deployments.size} deployments and ${routes.length} Taxi/Bus observations (${routes.filter((r) => r.unavailable).length} reverted) on ${Object.keys(blocks).length} fixed blocks; ${calls.length} eth_call responses. Nothing signed or sent.`);
}
try { await capture(); } catch (error) {
  // viem errors can include credential-bearing RPC URLs. Keep logs safe even with RPC_* overrides.
  console.error(`Stargate fixture capture failed during ${stage}. ${error instanceof CaptureValidationError ? error.message : "RPC/API/decoding error (details omitted to protect RPC credentials)."} Existing fixture unchanged.`);
  process.exitCode = 1;
}
