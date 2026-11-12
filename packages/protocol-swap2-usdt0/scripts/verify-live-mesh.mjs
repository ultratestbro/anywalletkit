#!/usr/bin/env node
// Read-only check of the USDT0 Legacy Mesh routes (EVM → Tron / TON) against the live contracts. Nothing is signed or sent.
//  1. Every pinned mesh OFT re-read on-chain: code, token(), approvalRequired(), endpoint(), sharedDecimals(), feeBps(),
//     peers(30420) / peers(30343) = the pinned Tron / TON OFT.
//  2. A live quote (quoteOFT + quoteSend through the provider) from every mesh source into Tron and TON, two amounts each:
//     the sealed send decoded back (eid, recipient bytes, amounts, refund), buildDeposit + preflightDeposit (eth_call).
//  3. Real delivered mesh transfers from LayerZero Scan: the encoder reproduces each packet's recipient bytes from the
//     address the destination paid, and trackIntent follows them to "completed" (TON: the payout read from tonapi).
// RPC_<chainId>=url overrides a public endpoint.
import {createPublicClient, decodeFunctionData, getAddress, http, parseAbi} from "viem";
import {usdt0Provider, TON_API} from "../dist/provider.js";
import {LZ_SCAN_API, USDT0_MESH_DESTINATIONS, USDT0_MESH_SOURCES, meshRecipientBytes32, meshRecipientMatches, tronAddressOf} from "../dist/config.js";

const PUBLIC_RPC = {1: "https://ethereum-rpc.publicnode.com", 42161: "https://arb1.arbitrum.io/rpc", 42220: "https://forno.celo.org"};
const rpcUrls = Object.fromEntries(Object.values(USDT0_MESH_SOURCES).map((s) => [s.caip2, process.env[`RPC_${s.chainId}`] ?? PUBLIC_RPC[s.chainId]]));
const ABI = parseAbi([
  "function token() view returns (address)", "function approvalRequired() view returns (bool)", "function endpoint() view returns (address)",
  "function sharedDecimals() view returns (uint8)", "function feeBps() view returns (uint16)", "function peers(uint32 eid) view returns (bytes32)",
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "function send(SendParam s, MessagingFee fee, address refundAddress) payable",
]);
const TRON = USDT0_MESH_DESTINATIONS["tron:728126428"], TON = USDT0_MESH_DESTINATIONS["ton:-239"];
const REFUND = "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA";
// Recipients the mesh paid on 2026-11-12 (TronGrid / toncenter), reused as quote recipients.
const RECIPIENT = {[TRON.caip2]: "TRjNDwg9kSj7sv1J6qGG4ad2wB9S9XqjMn", [TON.caip2]: "UQAQskXMoOIlwQZWQaqDmfRsNQaYsyTE5ImQoZ2QMCMqzp5R"};
const fmt = (wei, d = 18) => (Number(wei) / 10 ** d).toPrecision(4);
let bad = 0;

console.log("1. pins on-chain");
for (const s of Object.values(USDT0_MESH_SOURCES)) {
  const c = createPublicClient({transport: http(rpcUrls[s.caip2], {timeout: 20_000})});
  const read = (functionName, args = []) => c.readContract({address: getAddress(s.oft), abi: ABI, functionName, args});
  try {
    const [code, token, approval, endpoint, shared, feeBps, peerTron, peerTon] = await Promise.all([
      c.getCode({address: s.oft}), read("token"), read("approvalRequired"), read("endpoint"), read("sharedDecimals"), read("feeBps"), read("peers", [TRON.eid]), read("peers", [TON.eid]),
    ]);
    const checks = {
      code: !!code && code.length > 2, token: token.toLowerCase() === s.token.toLowerCase(), approval: approval === true,
      endpoint: endpoint.toLowerCase() === s.endpoint.toLowerCase(), shared6: Number(shared) === 6,
      peerTron: peerTron.toLowerCase() === TRON.peer, peerTon: peerTon.toLowerCase() === TON.peer,
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) bad++;
    console.log(`  ${ok ? "ok " : "BAD"} ${s.name.padEnd(9)} eid ${s.eid} oft ${s.oft} code ${(code.length - 2) / 2} B feeBps ${feeBps}`, ok ? "" : checks);
  } catch (e) {
    bad++;
    console.log(`  ERR ${s.name} ${e.shortMessage ?? e.message}`);
  }
}

console.log("2. live quotes (read-only), 10 and 1000 USDT from every mesh source into Tron and TON");
const p = usdt0Provider({rpcUrls});
const sourceToken = {"eip155:1": "USDT", "eip155:42161": "USDT0", "eip155:42220": USDT0_MESH_SOURCES["eip155:42220"].token};
for (const s of Object.values(USDT0_MESH_SOURCES)) {
  for (const d of [TRON, TON]) {
    for (const amountIn of ["10000000", "1000000000"]) {
      const reasons = [];
      const params = {sourceChain: s.caip2, sourceToken: sourceToken[s.caip2], destChain: d.caip2, destToken: "USDT", amountIn, destAddress: RECIPIENT[d.caip2], refundAddress: REFUND, dry: false, onRefusal: (r) => reasons.push(r)};
      const q = await p.getQuote(params);
      if (!q) { bad++; console.log(`  BAD ${s.name} → ${d.name} ${Number(amountIn) / 1e6}: ${reasons.join("; ")}`); continue; }
      const [sp, fee, refund] = decodeFunctionData({abi: ABI, data: q.txRequest.data}).args;
      const want = meshRecipientBytes32(d, RECIPIENT[d.caip2]).to;
      let preflight = "ok";
      try { await p.preflightDeposit(q, await p.buildDeposit(q)); } catch (e) { preflight = e.message; bad++; }
      const ok = sp.dstEid === d.eid && sp.to === want && meshRecipientMatches(d, sp.to, RECIPIENT[d.caip2]) && String(sp.amountLD) === amountIn && String(sp.minAmountLD) === q.minDestAmount && getAddress(refund) === REFUND && fee.nativeFee === BigInt(q.txRequest.value);
      if (!ok) bad++;
      const nativeSym = s.chainId === 42220 ? "CELO" : "ETH";
      console.log(`  ${ok ? "ok " : "BAD"} ${s.name.padEnd(9)} → ${d.name.padEnd(4)} ${String(Number(amountIn) / 1e6).padStart(5)} USDT: receives ${Number(q.destAmount) / 1e6} (mesh fee ${q.fees.map((f) => Number(f.amount) / 1e6).join("+")}), LayerZero fee sealed ${fmt(q.txRequest.nativeFee)} ${nativeSym} (quote ${fmt((BigInt(q.txRequest.nativeFee) * 10_000n) / 12_500n)}), to ${sp.to}, eta ${q.etaSeconds}s, preflight ${preflight}`);
    }
  }
}

console.log("3. real delivered mesh transfers: the encoder reproduces the packet recipient; trackIntent → completed");
const PAST = [
  // Ethereum → Tron through an aggregator; TronGrid: USDT from the Tron OFT to TRjNDwg9… (the same amount as the packet).
  {src: "eip155:1", dst: TRON, tx: "0x458c5542e2179a28a6cfc7d22be75c4697fc809406ecab847a640f7a6a89f51c", recipient: "TRjNDwg9kSj7sv1J6qGG4ad2wB9S9XqjMn"},
  // Arbitrum → TON through an aggregator; toncenter: the USDT jetton from the TON OFT to UQAQskXM… (975.094748 USDT).
  {src: "eip155:42161", dst: TON, tx: "0xa2a27a8193ab9cf8a46c4eade343f9098588d49ac546c45b39534ba8447b8411", recipient: "UQAQskXMoOIlwQZWQaqDmfRsNQaYsyTE5ImQoZ2QMCMqzp5R"},
  // Arbitrum → TON, a direct send() on the mesh OFT (sp.to = the packet's to).
  {src: "eip155:42161", dst: TON, tx: "0xd89fe4b66bf3d712d90e773fc76782ca390518a69eded0dfd0ff639d46289cb9", recipient: "0:cc62e9d78d228f4a293381530aaad4c9f4fc44123dab3b6743f737c46bc01f79"},
  // Arbitrum → Tron, a direct send() on the mesh OFT; the recipient spelled from the packet's low 20 bytes.
  {src: "eip155:42161", dst: TRON, tx: "0x7f071ac850c3e8cb79628bb42116697869d5d073beae556ec73aa917b725c67d", recipient: null},
];
for (const t of PAST) {
  const s = USDT0_MESH_SOURCES[t.src];
  const res = await fetch(`${LZ_SCAN_API}/v1/messages/tx/${t.tx}`, {headers: {accept: "application/json"}});
  const m = (await res.json()).data?.find((x) => x.pathway?.srcEid === s.eid && x.pathway?.dstEid === t.dst.eid);
  const payload = m?.source?.tx?.payload ?? "";
  const packetTo = `0x${payload.slice(6, 70)}`;
  const recipient = t.recipient ?? tronAddressOf(Uint8Array.from(packetTo.slice(26).match(/../g).map((h) => parseInt(h, 16))));
  const enc = meshRecipientBytes32(t.dst, recipient);
  const status = await p.trackIntent({intentId: `usdt0-mesh:${s.eid}:${t.dst.eid}`, sourceTxHash: t.tx});
  const ok = payload.startsWith("0x0002") && enc.to === packetTo && status.state === "completed";
  if (!ok) bad++;
  console.log(`  ${ok ? "ok " : "BAD"} ${s.name} → ${t.dst.name} ${t.tx.slice(0, 12)}… recipient ${recipient} → ${enc.to ?? enc.refusal} ${enc.to === packetTo ? "= packet to" : `≠ packet ${packetTo}`}; amount ${Number(BigInt(`0x${payload.slice(70, 86)}`)) / 1e6} USDT; track ${JSON.stringify(status)}`);
}
console.log(`hosts: ${LZ_SCAN_API}, ${TON_API}, RPCs ${Object.values(rpcUrls).map((u) => new URL(u).host).join(", ")}`);
console.log(bad ? `FAILED (${bad})` : "ok");
process.exit(bad ? 1 : 0);
