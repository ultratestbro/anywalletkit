import {decodeFunctionData, encodeFunctionResult, pad, parseAbi, toHex, zeroAddress, type Abi, type Hex} from "viem";
import {STARGATE_ABI, TOKEN_MESSAGING_ABI} from "../../src/abi.js";
import {stargateRegistry} from "../../src/deployments.js";
import {createStargateQuoter, type StargateQuoteRequest} from "../../src/quote.js";

export const actor = "0x1111111111111111111111111111111111111111";
export const recipient = "0x2222222222222222222222222222222222222222";
const hash = `0x${"ab".repeat(32)}` as Hex;
const allAbi: Abi = [...STARGATE_ABI, ...TOKEN_MESSAGING_ABI, ...parseAbi(["function decimals() view returns (uint8)", "function eid() view returns (uint32)"])];
type Read = {chain: string; to: string; from?: string; functionName: string; args: readonly unknown[]; block: string};

/** Synthetic RPC server: no network, balances, private keys or real transaction submission. */
export function setup(sourceChain = "eip155:56", destinationChain = "eip155:42161", assetId = 1) {
  const source = stargateRegistry.deployments.find((d) => d.chain === sourceChain && d.assetId === assetId)!;
  const destination = stargateRegistry.deployments.find((d) => d.chain === destinationChain && d.assetId === assetId)!;
  const reads: Read[] = [];
  const state = {
    feeSD: -100n, credit: 1_000_000_000n, messagingFee: 101n, lzTokenFee: 0n, nativeDrop: 10n ** 15n,
    busUnavailable: false, stale: false, reorg: false, wrongChain: false,
    override: undefined as ((read: Read, result: unknown) => unknown) | undefined,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const chain = String(input).includes("source") ? source : destination;
    const other = chain === source ? destination : source;
    const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
    let result: unknown;
    if (body.method === "eth_chainId") result = toHex(state.wrongChain ? 999 : chain.chainId);
    else if (body.method === "eth_getBlockByNumber") result = {number: "0x64", hash: state.reorg && body.params[0] !== "latest" ? `0x${"cd".repeat(32)}` : hash, timestamp: toHex(BigInt(Math.floor(Date.now() / 1000)) - (state.stale ? 600n : 0n)), transactions: []};
    else if (body.method === "eth_call") {
      const call = body.params[0] as {to: string; data: Hex; from?: string};
      const decoded = decodeFunctionData({abi: allAbi, data: call.data});
      const read: Read = {chain: chain.chain, to: call.to, ...(call.from ? {from: call.from} : {}), functionName: decoded.functionName, args: decoded.args ?? [], block: String(body.params[1])};
      reads.push(read);
      const values: Record<string, unknown> = {
        token: chain.token, sharedDecimals: chain.sharedDecimals, approvalRequired: chain.approvalRequired,
        localEid: chain.eid, endpoint: chain.endpoint, eid: chain.eid, status: 1, stargateType: chain.kind === "oft" ? 1 : 0,
        decimals: chain.localDecimals, assetIds: chain.assetId, stargateImpls: chain.address, peers: pad(other.tokenMessaging, {size: 32}),
        paths: state.credit, nativeDropAmounts: state.nativeDrop,
        getAddressConfig: {feeLib: actor, planner: actor, treasurer: actor, tokenMessaging: chain.tokenMessaging, creditMessaging: actor, lzToken: zeroAddress},
      };
      result = values[read.functionName];
      if (read.functionName === "quoteOFT") {
        const sp = read.args[0] as {amountLD: bigint};
        const rate = 10n ** BigInt(chain.localDecimals - chain.sharedDecimals);
        const inputSD = sp.amountLD / rate;
        const sent = (inputSD > state.credit ? state.credit : inputSD) * rate;
        result = [{minAmountLD: rate, maxAmountLD: state.credit * rate}, state.feeSD ? [{feeAmountLD: state.feeSD * rate, description: "synthetic fee/reward"}] : [], {amountSentLD: sent, amountReceivedLD: sent + state.feeSD * rate}];
      }
      if (read.functionName === "quoteSend") {
        const sp = read.args[0] as {oftCmd: Hex};
        if (state.busUnavailable && sp.oftCmd !== "0x") return Response.json({jsonrpc: "2.0", id: body.id, error: {code: 3, message: "execution reverted", data: "0x5bc181900000000000000000000000000000000000000000000000000000000000000000"}});
        result = {nativeFee: state.messagingFee, lzTokenFee: state.lzTokenFee};
      }
      result = state.override ? state.override(read, result) : result;
      result = encodeFunctionResult({abi: allAbi, functionName: read.functionName, result});
    } else throw new Error(`unexpected RPC ${body.method}`);
    return Response.json({jsonrpc: "2.0", id: body.id, result});
  };
  const config = {rpcUrls: {[source.chain]: "https://source.test/private-key", [destination.chain]: "https://destination.test/private-key"}, fetchImpl};
  const request: StargateQuoteRequest = {sourceChain, sourceToken: source.token, destinationChain, destinationToken: destination.token, amount: 10n * 10n ** BigInt(source.localDecimals), mode: "taxi", sender: actor, recipient};
  return {source, destination, reads, state, config, request, quoter: createStargateQuoter(config)};
}

