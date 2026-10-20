#!/usr/bin/env node
// Read-only: every deployment in config.ts re-read on-chain (token(),
// approvalRequired(), endpoint(), peers → Arbitrum and HyperEVM), then a live
// quote USDT Arbitrum → HyperEVM for 10 USDT (quoteOFT + quoteSend through the
// provider) with the sealed calldata decoded back and the preflight run.
// Nothing is signed or sent. USDT0_SRC_TX=0x… additionally tracks a past send
// through LayerZero Scan. RPC_<chainId>=url overrides a public endpoint.
import {createPublicClient, decodeFunctionData, getAddress, http, pad, parseAbi} from "viem";
import {usdt0Provider} from "../dist/provider.js";
import {USDT0_CHAINS} from "../dist/config.js";

const PUBLIC_RPC = {
  1: "https://ethereum-rpc.publicnode.com", 42161: "https://arbitrum-one-rpc.publicnode.com", 10: "https://optimism-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com", 999: "https://rpc.hyperliquid.xyz/evm", 57073: "https://rpc-gel.inkonchain.com",
  80094: "https://rpc.berachain.com", 130: "https://unichain-rpc.publicnode.com", 1329: "https://sei-evm-rpc.publicnode.com",
  9745: "https://rpc.plasma.to", 143: "https://rpc.monad.xyz", 4326: "https://mainnet.megaeth.com/rpc", 196: "https://rpc.xlayer.tech",
  5000: "https://rpc.mantle.xyz", 2818: "https://rpc.morphl2.io", 14: "https://flare-api.flare.network/ext/C/rpc",
};
const rpcUrls = Object.fromEntries(Object.values(USDT0_CHAINS).map((c) => [c.caip2, process.env[`RPC_${c.chainId}`] ?? PUBLIC_RPC[c.chainId]]));
const ABI = parseAbi([
  "function token() view returns (address)", "function approvalRequired() view returns (bool)", "function endpoint() view returns (address)",
  "function peers(uint32 eid) view returns (bytes32)", "function sharedDecimals() view returns (uint8)",
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "function send(SendParam s, MessagingFee fee, address refundAddress) payable",
]);
const ARB = USDT0_CHAINS["eip155:42161"], HYPE = USDT0_CHAINS["eip155:999"];

let bad = 0;
for (const chain of Object.values(USDT0_CHAINS)) {
  const c = createPublicClient({transport: http(rpcUrls[chain.caip2], {timeout: 15_000})});
  const read = (functionName, args = []) => c.readContract({address: getAddress(chain.oft), abi: ABI, functionName, args});
  try {
    const [token, approval, endpoint, shared, peerArb, peerHype] = await Promise.all([read("token"), read("approvalRequired"), read("endpoint"), read("sharedDecimals"), read("peers", [ARB.eid]), read("peers", [HYPE.eid])]);
    const checks = {
      token: token.toLowerCase() === chain.token.toLowerCase(),
      approval: approval === chain.adapter,
      endpoint: endpoint.toLowerCase() === chain.endpoint.toLowerCase(),
      shared6: Number(shared) === 6,
      peerArb: chain === ARB || peerArb.toLowerCase() === pad(getAddress(ARB.oft), {size: 32}).toLowerCase(),
      peerHype: chain === HYPE || peerHype.toLowerCase() === pad(getAddress(HYPE.oft), {size: 32}).toLowerCase(),
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) bad++;
    console.log(`${ok ? "ok " : "BAD"} ${chain.name.padEnd(12)} eid ${chain.eid} oft ${chain.oft}`, ok ? "" : checks);
  } catch (e) {
    bad++;
    console.log(`ERR ${chain.name.padEnd(12)} ${e.shortMessage ?? e.message}`);
  }
}

const p = usdt0Provider({rpcUrls});
const reasons = [];
const me = "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA";
const q = await p.getQuote({sourceChain: ARB.caip2, sourceToken: "USDT0", destChain: HYPE.caip2, destToken: HYPE.token, amountIn: "10000000", destAddress: me, refundAddress: me, onRefusal: (r) => reasons.push(r)});
if (!q) { console.log("quote → none", reasons); process.exit(1); }
const {args} = decodeFunctionData({abi: ABI, data: q.txRequest.data});
console.log("quote Arbitrum → HyperEVM 10 USDT0", {
  intent: q.intentId, received: q.destAmount, minReceived: q.minDestAmount, nativeFeeWei: q.txRequest.nativeFee, nativeFeeEth: Number(q.txRequest.nativeFee) / 1e18,
  value: q.txRequest.value, to: q.txRequest.to, approval: q.txRequest.approvalAddress ?? "none", eta: q.etaSeconds,
  sendParam: {dstEid: args[0].dstEid, to: args[0].to, amountLD: String(args[0].amountLD), minAmountLD: String(args[0].minAmountLD)}, fee: {nativeFee: String(args[1].nativeFee), lzTokenFee: String(args[1].lzTokenFee)}, refund: args[2],
});
const tx = await p.buildDeposit(q);
try { await p.preflightDeposit(q, tx); console.log("preflight ok (token, approvalRequired, peer, live fee ≤ sealed)"); } catch (e) { bad++; console.log("preflight →", e.message); }
if (process.env.USDT0_SRC_TX) {
  const ref = {intentId: q.intentId, sourceTxHash: process.env.USDT0_SRC_TX};
  console.log("track", await p.trackIntent(ref));
  const claim = await p.buildClaim(ref);
  console.log("claim", claim && {chain: claim.chain, to: claim.to, dataBytes: (claim.data.length - 2) / 2});
}
console.log(bad ? `FAILED (${bad})` : "ok");
process.exit(bad ? 1 : 0);
