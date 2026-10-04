'use strict'

/**
 * @typedef {Object} MellowVaultPreset
 * @property {string} vault - The Core Vault address (everything else is discovered on-chain).
 * @property {string} registryId - The vault's id in Mellow's registry (APY / TVL decoration).
 * @property {string} name - Display name.
 * @property {string} shareSymbol - The share token's ticker.
 * @property {string} [note] - Caveats known at the time the preset was added.
 */

/**
 * Known Core Vaults by chain id and key. Presets are a convenience: any vault
 * on the same contracts works by passing its address as `vault`.
 * Addresses verified against the on-chain vault getters on 2026-09-07.
 *
 * @type {Record<number, Record<string, MellowVaultPreset>>}
 */
const MELLOW_ADDRESS_MAP = {
  1: {
    'lido-earn-eth': {
      vault: '0x6a37725ca7f4ce81c004c955f7280d5c704a249e',
      registryId: 'lido-earn-eth',
      name: 'Lido EarnETH',
      shareSymbol: 'earnETH'
    },
    'lido-earn-usd': {
      vault: '0x014e6da8f283c4af65b2aa0f201438680a004452',
      registryId: 'lido-earn-usd',
      name: 'Lido EarnUSD',
      shareSymbol: 'earnUSD'
    },
    'lido-strategy': {
      vault: '0x277c6a642564a91ff78b008022d65683cee5ccc5',
      registryId: 'lido-strategy',
      name: 'Lido stRATEGY',
      shareSymbol: 'strETH',
      note: 'Deposits gated by the vault whitelist as of 2026-09-07 (supply refuses); reads and redemptions work.'
    },
    'lido-conservative-earn-usd': {
      vault: '0xdf0fb76df2c21f79798949a4e886cd22d1c085d7',
      registryId: 'lido-conservative-earn-usd',
      name: 'Lido Conservative earnUSD',
      shareSymbol: 'earnUSD',
      note: 'Deposits gated by the vault whitelist as of 2026-09-07; sync deposit queues only.'
    },
    'lido-experimental-earn-usd': {
      vault: '0x0cc65147bf7f615a8dd9e78e2c53158f8e01754d',
      registryId: 'lido-experimental-earn-usd',
      name: 'Lido Experimental earnUSD',
      shareSymbol: 'earnUSD',
      note: 'Deposits gated by the vault whitelist as of 2026-09-07; sync deposit queues only.'
    }
  }
}

export default MELLOW_ADDRESS_MAP
