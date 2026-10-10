export * from './base.js'
export * from './swap.js'
export * from './bridge.js'
export * from './swap2.js'
export * from './lending.js'
export * from './staking.js'
export * from './approvals.js'
export * from './fiat.js'

/** Every protocol type the registry knows. */
export type ProtocolType = 'swap' | 'bridge' | 'swap2' | 'lending' | 'staking' | 'approvals' | 'fiat'
