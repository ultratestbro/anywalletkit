#!/usr/bin/env node
// Records the test fixtures from public RPCs, read-only (nothing is signed or sent, no Across API is called):
//
//  - fixtures/status/*.json — real deposits on Base to Arbitrum: the source receipt (trimmed to what `status.ts` reads),
//    the destination SpokePool's `fillStatuses(relayHash)` at the blocks named below with those blocks' number and
//    time, and the calldata the deposit was sent with. The relay hash is computed by this package (`dist/status.js`);
//    a filled deposit reading 2 at its fill block and 0 one block before is what proves the hash right.
//  - fixtures/activity/*.json — the same transactions (and a native-coin one) mapped to ChainTx exactly as
//    history-evm's RPC path does (Transfer logs from the receipt); the expectation is what the module answers,
//    printed for review. `negative-*` are deposits that reach the SpokePool through another contract.
//
//   pnpm build && node scripts/record-fixtures.mjs
// RPC_<chainId>=url overrides a public endpoint.
import {mkdirSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {buildTx, parseReceiptTransfers, txRowFromRpc} from "@anywalletkit/history-evm";
import {ACROSS_CHAINS} from "../dist/config.js";
import {acrossDepositsInReceipt, acrossFillStatusCall, acrossRelayHash} from "../dist/status.js";
import {describeAcrossActivity} from "../dist/activity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "fixtures");
const RPC = {
  8453: [process.env.RPC_8453 ?? "https://base-rpc.publicnode.com"],
  // Public RPCs that answer eth_call at day-old blocks, tried in order (publicnode wants a key for that, arb1.arbitrum.io
  // had pruned it; 1rpc.io sometimes forwards to a node without the state).
  42161: process.env.RPC_42161 ? [process.env.RPC_42161] : ["https://arbitrum-one.public.blastapi.io", "https://1rpc.io/arb"],
};
const hex = (n) => `0x${BigInt(n).toString(16)}`;

async function rpc(chainId, method, params) {
  let last;
  for (const url of RPC[chainId]) {
    try {
      const res = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal: AbortSignal.timeout(30_000)});
      const body = await res.json();
      if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
      return body.result;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

const trimReceipt = (r) => ({
  transactionHash: r.transactionHash, blockNumber: r.blockNumber, status: r.status, from: r.from, to: r.to,
  logs: r.logs.map((l) => ({address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex})),
});

/** A destination read: the block's number and time and the fill status there. */
async function readAt(dest, blockTag, relayHash) {
  const block = await rpc(dest.chainId, "eth_getBlockByNumber", [blockTag, false]);
  const fillStatus = await rpc(dest.chainId, "eth_call", [{to: dest.spokePool, data: acrossFillStatusCall(relayHash)}, block.number]);
  return {block: {number: block.number, timestamp: block.timestamp}, fillStatus};
}

const STATUS = [
  {
    name: "base-arb-weth-depositv3",
    hash: "0x85c343b85b3510a16cd6b90ff596e4ab57735902448d1ec946243d9242953dd6",
    note: "WETH Base → Arbitrum, depositV3 sent straight to the Base SpokePool (depositId 6457809, recipient other than the depositor). Across's own indexer (GET app.across.to/api/deposit?depositTxnRef=…, read 2026-11-14) gave relayHash 0xe9e40248…4df6 and the fill 0x41c78309…5f40 at Arbitrum block 524261356.",
    acrossIndexerRelayHash: "0xe9e40248968303d9c85c0eb4082b2b1d70e7e637fc22aa605654f24084734df6",
    fillBlock: 524261356,
  },
  {
    name: "base-arb-usdc-deposit",
    hash: "0x6ff89815c96a3a31094bf083f7b8ef77d33ab591b59da3632acb8c314d929dd4",
    note: "USDC Base → Arbitrum, deposit (0xad5425c6) sent straight to the Base SpokePool with calldata from Across's API (it ends in the API's 3-byte marker 73c0de). Found by a FundsDeposited log scan of the Base SpokePool; read at the latest Arbitrum block.",
  },
  {
    name: "base-arb-expired",
    hash: "0x85585b7e4b37806e7f24fb971f8683d246dbf668feb2544d5713ef8eb8919445",
    note: "A Base → Arbitrum deposit that was never filled: found by a scan of 253 Base → Arbitrum deposits whose fill deadline had passed, reading each one's fillStatuses on Arbitrum (3 were still 0). Read at the latest Arbitrum block, past its fill deadline.",
  },
];

const ACTIVITY = [
  {name: "base-deposit-usdc", hash: "0x6ff89815c96a3a31094bf083f7b8ef77d33ab591b59da3632acb8c314d929dd4"},
  {name: "base-depositv3-weth", hash: "0x85c343b85b3510a16cd6b90ff596e4ab57735902448d1ec946243d9242953dd6"},
  {name: "base-depositv3-eth", hash: "0xc3b421dc0d21c084bcb1f4a4d05462264b94962df823b73eda6ae5f5bd7f0f6c"},
  {name: "negative-base-relayed-deposit", hash: "0xbf753fc54d0a84f671c537cee4e3a699a0f9600733971715dce97c14375d408f"},
];

const base = ACROSS_CHAINS["eip155:8453"];
const arb = ACROSS_CHAINS["eip155:42161"];
mkdirSync(join(OUT, "status"), {recursive: true});
mkdirSync(join(OUT, "activity"), {recursive: true});

for (const c of STATUS) {
  const tx = await rpc(8453, "eth_getTransactionByHash", [c.hash]);
  const receipt = await rpc(8453, "eth_getTransactionReceipt", [c.hash]);
  const [deposit] = acrossDepositsInReceipt(receipt, base);
  const relayHash = acrossRelayHash(deposit);
  const reads = c.fillBlock
    ? [await readAt(arb, hex(c.fillBlock - 1), relayHash), await readAt(arb, hex(c.fillBlock), relayHash)]
    : [await readAt(arb, "latest", relayHash)];
  const fixture = {
    note: `${c.note} Recorded ${new Date().toISOString().slice(0, 10)} over public RPCs.`,
    source: {chainId: 8453, txHash: c.hash, input: tx.input, receipt: trimReceipt(receipt)},
    relayHash,
    ...(c.acrossIndexerRelayHash ? {acrossIndexerRelayHash: c.acrossIndexerRelayHash} : {}),
    dest: {chainId: 42161, spokePool: arb.spokePool, reads},
  };
  writeFileSync(join(OUT, "status", `${c.name}.json`), JSON.stringify(fixture, null, 2) + "\n");
  console.log(c.name, "relayHash", relayHash, "reads", reads.map((r) => `${BigInt(r.block.number)}:${r.fillStatus.slice(-1)}`).join(" "));
}

for (const c of ACTIVITY) {
  const tx = await rpc(8453, "eth_getTransactionByHash", [c.hash]);
  const receipt = await rpc(8453, "eth_getTransactionReceipt", [c.hash]);
  const block = await rpc(8453, "eth_getBlockByNumber", [tx.blockNumber, false]);
  const row = txRowFromRpc(tx, receipt, Number(BigInt(block.timestamp)));
  const tokens = parseReceiptTransfers(receipt, row);
  const item = buildTx({chain: "eip155:8453", chainId: 8453, address: tx.from, source: "etherscan"}, tx.hash, row, tokens, []);
  const json = JSON.parse(JSON.stringify(item, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  delete json.raw;
  const own = [tx.from];
  const described = describeAcrossActivity({...item}, {own: new Set([tx.from, tx.from.toLowerCase()])});
  const expect = described
    ? {kind: described.kind, title: described.title, ...(described.assetsIn.length ? {assetsIn: described.assetsIn.map((a) => ({token: a.token, amount: String(a.amount)}))} : {}), ...(described.assetsOut.length ? {assetsOut: described.assetsOut.map((a) => ({token: a.token, amount: String(a.amount)}))} : {}), counterparty: described.counterparty}
    : null;
  const fixture = {note: `${c.name}: Base block ${BigInt(tx.blockNumber)}, basescan.org/tx/${c.hash.slice(0, 10)}… (selector ${tx.input.slice(0, 10)}, to ${tx.to})`, own, tx: json, expect};
  writeFileSync(join(OUT, "activity", `${c.name}.json`), JSON.stringify(fixture, null, 2) + "\n");
  console.log(c.name, c.hash, "selector", tx.input.slice(0, 10), "→", expect?.kind ?? null, expect?.title ?? "");
}
