/** A 0x-prefixed hex string (address, code hash). */
export type Hex = `0x${string}`
/** One curated Curve pool. Addresses are EIP-55 checksummed; native ETH-like coin = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE. */
export interface CurvePool {
  address: Hex
  name: string
  /** coins(i) read on-chain, index order. */
  coins: readonly Hex[]
  /** decimals per coin, same order as coins. */
  decimals: readonly number[]
  /** For metapools / lending pools: underlying coins in exchange_underlying index order (swap_type 2). */
  underlying?: readonly Hex[]
  underlyingDecimals?: readonly number[]
  /** Router pool_type: 1 stable, 2 twocrypto, 3 tricrypto, 10 stable-ng, 20 twocrypto-ng, 30 tricrypto-ng. */
  poolType: 1 | 2 | 3 | 10 | 20 | 30
  /** Router swap_type values this pool allows: 1 exchange; 2 exchange_underlying (only if underlying is set). */
  swapTypes: readonly (1 | 2)[]
  /** keccak256 of eth_getCode(address) at build time. */
  codeHash: Hex
  /** USD TVL at build time (integer dollars). */
  tvlUsd: number
  /** Unix seconds of pool creation (block timestamp) when known. */
  createdAt?: number
}
/** The curated pools of one chain, as built by scripts/build-allowlist.mjs. */
export interface CurveChainPools {
  chainId: number
  /** ISO date of the build. */
  builtAt: string
  /** Block the on-chain checks ran at. */
  block: number
  pools: readonly CurvePool[]
}
