'use strict'

/**
 * @typedef {Object} StakePoolConfig
 * @property {string} name - Short name; lower-cased into the seed of the wallet's unstake accounts, so it must stay stable per pool.
 * @property {string} pool - The stake pool state account.
 * @property {string} mint - The pool token mint (the LST) — checked against the on-chain state before any transaction.
 * @property {string} symbol - LST ticker for display.
 */

/**
 * Known pools on the SPL Stake Pool program, by key (mainnet; addresses
 * verified against the on-chain pool state 2026-09-07). Any other pool on the
 * same program works by passing `{ name, pool, mint, symbol }` directly — the
 * program's byte layouts are shared, only the addresses differ.
 *
 * @type {Record<string, StakePoolConfig>}
 */
const SPL_STAKE_POOL_ADDRESS_MAP = {
  jito: {
    name: 'Jito',
    pool: 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb',
    mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    symbol: 'JitoSOL'
  }
}

export default SPL_STAKE_POOL_ADDRESS_MAP
