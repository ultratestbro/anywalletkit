import type { TronContractCall, TronRawTransaction } from './types.js'

/** Type guard: a transaction prebuilt by a node or provider (has `txID`). */
export const isPrebuilt = (tx: unknown): tx is TronRawTransaction => typeof tx === 'object' && tx !== null && typeof (tx as TronRawTransaction).txID === 'string'
/** Type guard: a contract call (`functionSelector`). */
export const isContractCall = (tx: unknown): tx is TronContractCall => typeof tx === 'object' && tx !== null && typeof (tx as TronContractCall).functionSelector === 'string'
