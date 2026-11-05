export type Hex = `0x${string}`
export interface CurvePool {
  address: Hex; name: string; coins: readonly Hex[]; decimals: readonly number[]
  underlying?: readonly Hex[]; underlyingDecimals?: readonly number[]
  poolType: 1 | 2 | 3 | 10 | 20 | 30
  swapTypes: readonly (1 | 2)[]
  codeHash: Hex; tvlUsd: number; createdAt?: number
}
export interface CurveChainPools { chainId: number; builtAt: string; block: number; pools: readonly CurvePool[] }
