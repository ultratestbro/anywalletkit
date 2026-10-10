#!/usr/bin/env node
// Read-only: live Circle fees/allowance → Fast and Standard quotes USDC Base →
// Arbitrum for $10, the sealed calldata decoded back, and the preflight
// against the real TokenMessengerV2 / MessageTransmitterV2 on Base through a
// public RPC. Nothing is signed or sent. CCTP_SRC_TX=0x… additionally shows the
// attestation state of a past burn.
import {decodeFunctionData, parseAbi} from "viem";
import {cctpProvider} from "../dist/provider.js";
import {CCTP_DOMAINS} from "../dist/config.js";

const RPC = {"eip155:8453": process.env.RPC_BASE ?? "https://base-rpc.publicnode.com", "eip155:42161": process.env.RPC_ARB ?? "https://arbitrum-one-rpc.publicnode.com"};
const ABI = parseAbi(["function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)"]);
const params = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: CCTP_DOMAINS["eip155:42161"].usdc, amountIn: "10000000", destAddress: "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA", refundAddress: "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA"};

for (const mode of ["fast", "standard"]) {
  const p = cctpProvider({mode, rpcUrls: RPC});
  const reasons = [];
  const q = await p.getQuote({...params, onRefusal: (r) => reasons.push(r)});
  if (!q) { console.log(mode, "→ no quote", reasons); continue; }
  const {args} = decodeFunctionData({abi: ABI, data: q.txRequest.data});
  console.log(mode, {intent: q.intentId, out: q.destAmount, maxFee: q.providerData.maxFee, eta: q.etaSeconds, fees: q.fees, args: args.map(String)});
  const tx = await p.buildDeposit(q);
  try { await p.preflightDeposit(q, tx); console.log("   preflight ok (localMessageTransmitter, localDomain, getMinFeeAmount)"); } catch (e) { console.log("   preflight →", e.message); }
}
if (process.env.CCTP_SRC_TX) {
  const p = cctpProvider({rpcUrls: RPC});
  const ref = {intentId: "cctp:6:3:1000", sourceTxHash: process.env.CCTP_SRC_TX};
  console.log("track", await p.trackIntent(ref));
  const claim = await p.buildClaim(ref);
  console.log("claim", claim && {chain: claim.chain, to: claim.to, dataBytes: (claim.data.length - 2) / 2});
}
console.log("ok");
