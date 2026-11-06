// Curve lending deployments per chain. Only Savings crvUSD (scrvUSD) is built so far,
// and it exists as a vault on Ethereum alone: the scrvUSD tokens on L2s are bridged
// ERC-20s whose `totalAssets` / `asset` revert (there, "earn" is a crvUSD → scrvUSD swap).
//
// Every scrvUSD pin was read on Ethereum on 2026-11-05 (block 26 350 290) and matches
// docs.curve.finance (developer/scrvusd/overview) and docs.curve.finance/deployments.json:
// the vault's runtime code is the 45-byte EIP-1167 clone of the implementation below,
// the implementation is Yearn's VaultV3.vy 3.0.4 (23 754 bytes), `apiVersion()` "3.0.4",
// `asset()` crvUSD. Addresses are never resolved through Curve's AddressProvider or API.
//
// LlamaLend (`CurveLendVaultProtocolEvm`, a later phase) adds its factories and the curated
// market list to `CurveLendingChain` here; scrvUSD does not depend on them.
import type { Address, Hex } from 'viem'

export interface ScrvUsdDeployment {
  chainId: number
  /** The vault (and share token). */
  vault: Address
  /** The VaultV3 implementation the clone delegates to. */
  implementation: Address
  /** keccak256 of the implementation's runtime code. */
  implementationCodeHash: Hex
  /** The vault's own runtime code: the EIP-1167 minimal proxy pointing at `implementation`. */
  cloneCode: Hex
  /** crvUSD. */
  asset: Address
  apiVersion: string
}

export interface CurveLendingChain {
  chainId: number
  name: string
  crvUsd: Address
  scrvUsd?: ScrvUsdDeployment
}

const IMPLEMENTATION: Address = '0xd8063123BBA3B480569244AE66BFE72B6c84b00d'
const CRVUSD: Address = '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E'

/** EIP-1167 runtime code for a clone of `impl`. */
export const eip1167Code = (impl: Address): Hex => `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`

export const SCRVUSD: ScrvUsdDeployment = Object.freeze({
  chainId: 1,
  vault: '0x0655977FEb2f289A4aB78af67BAB0d17aAb84367',
  implementation: IMPLEMENTATION,
  implementationCodeHash: '0xcf95c532cb05bdfdbcfcb5ade8957e84b69091d0260b667ebc5627ca9efbfd65',
  cloneCode: eip1167Code(IMPLEMENTATION),
  asset: CRVUSD,
  apiVersion: '3.0.4',
})

/** The scrvUSD deployment by chain id (Ethereum only): the shape the module watch checks against docs.curve.finance/deployments.json. */
export const SCRVUSD_DEPLOYMENTS: Readonly<Record<number, ScrvUsdDeployment>> = Object.freeze({ 1: SCRVUSD })

export const CURVE_LENDING_CHAINS: Readonly<Record<number, CurveLendingChain>> = Object.freeze({
  1: { chainId: 1, name: 'Ethereum', crvUsd: CRVUSD, scrvUsd: SCRVUSD },
})

export const CURVE_LENDING_CHAIN_IDS: readonly string[] = Object.freeze(Object.keys(CURVE_LENDING_CHAINS).map((id) => `eip155:${id}`))

/** Curve's prices API (decoration only: the projected scrvUSD APY). */
export const CURVE_PRICES_API = 'https://prices.curve.finance'
