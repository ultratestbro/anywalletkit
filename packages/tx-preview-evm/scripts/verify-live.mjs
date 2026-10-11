// Live check against public RPCs — simulation only, nothing is signed or sent.
import {encodeFunctionData, parseAbi} from "viem";
import {previewEvmTx} from "../dist/index.js";

const ME = process.env.FROM ?? "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba";
const rpcOf = (url) => async (method, params) => {
  const res = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})});
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(j.error.message), {code: j.error.code, data: j.error.data});
  return j.result;
};
const ERC20 = parseAbi(["function approve(address,uint256)", "function transfer(address,uint256)"]);
const show = (name, p) => console.log(name, JSON.stringify(p, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const OTHER = "0x000000000000000000000000000000000000dEaD";
show("base approve→transfer", await previewEvmTx({
  chainId: 8453, from: ME, rpc: rpcOf("https://base-rpc.publicnode.com"), own: [ME], known: {[DIAMOND]: "LI.FI Diamond"}, expectedApproval: 1_000_000n,
  calls: [
    {to: USDC_BASE, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [DIAMOND, 1_000_000n]})},
    {to: USDC_BASE, data: encodeFunctionData({abi: ERC20, functionName: "transfer", args: [OTHER, 1_000_000n]})},
  ],
}));
show("base native", await previewEvmTx({chainId: 8453, from: ME, rpc: rpcOf("https://base-rpc.publicnode.com"), own: [ME], calls: [{to: OTHER, value: 10n ** 12n}]}));
show("base too much", await previewEvmTx({chainId: 8453, from: ME, rpc: rpcOf("https://base-rpc.publicnode.com"), own: [ME], calls: [{to: USDC_BASE, data: encodeFunctionData({abi: ERC20, functionName: "transfer", args: [OTHER, 10n ** 15n]})}]}));
show("avalanche fallback", await previewEvmTx({chainId: 43114, from: ME, rpc: rpcOf("https://api.avax.network/ext/bc/C/rpc"), own: [ME], calls: [{to: OTHER, value: 0n}]}));
