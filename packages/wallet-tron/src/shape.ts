import type { TronContractCall, TronRawTransaction } from './types.js'

export const isPrebuilt = (tx: unknown): tx is TronRawTransaction => typeof tx === 'object' && tx !== null && typeof (tx as TronRawTransaction).txID === 'string'
export const isContractCall = (tx: unknown): tx is TronContractCall => typeof tx === 'object' && tx !== null && typeof (tx as TronContractCall).functionSelector === 'string'
