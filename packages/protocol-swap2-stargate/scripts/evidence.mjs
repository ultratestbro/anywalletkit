// Shared read-only RPC recorder. Error diagnostics never include RPC URLs or provider error bodies.
import {createPublicClient, http, fallback, getAddress, encodeFunctionData, decodeFunctionResult} from "viem";

export const stringify = (value) => JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n";
export class EvidenceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export async function context(chain, chainId, urls, blockNumber) {
  const client = createPublicClient({transport: fallback(urls.map((url) => http(url, {timeout: 8_000, retryCount: 0})), {rank: false, retryCount: 0}), ccipRead: false});
  try {
    if (await client.getChainId() !== chainId) throw new EvidenceError("wrong-rpc-chain");
    const number = blockNumber ?? (await client.getBlockNumber()) - 24n;
    const block = await client.getBlock({blockNumber: number});
    if (!block.hash || block.number !== number) throw new EvidenceError("missing-block-identity");
    const calls = [];
    return {
      client, calls, block: {chain, chainId, number: block.number, hash: block.hash, timestamp: block.timestamp},
      async read(address, abi, functionName, args = []) {
        const data = encodeFunctionData({abi, functionName, args});
        try {
          const result = await client.call({to: getAddress(address), data, blockNumber: number});
          if (!result.data) throw new EvidenceError("empty-call-result");
          const decoded = decodeFunctionResult({abi, functionName, data: result.data});
          calls.push({to: getAddress(address), functionName, data, result: result.data});
          return decoded;
        } catch (error) {
          if (error instanceof EvidenceError) throw error;
          throw new EvidenceError(`rpc-call-or-decode:${functionName}`);
        }
      },
      async checkBlock() {
        if ((await client.getBlock({blockNumber: number})).hash !== block.hash) throw new EvidenceError("block-changed");
      },
    };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError("rpc-unavailable");
  }
}

export async function workers(items, concurrency, run) {
  let index = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => {
    while (index < items.length) { const i = index++; results[i] = await run(items[i]); }
  }));
  return results;
}
