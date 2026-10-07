import type { Transaction, TransactionMessage } from '@solana/kit'
import type { SolanaNativeTransfer } from './types.js'

/** A compiled kit `Transaction` (signatures may still be null). */
export const isSignedTransaction = (tx: unknown): tx is Transaction =>
  typeof tx === 'object' && tx !== null && 'messageBytes' in tx && 'signatures' in tx
export const isNativeTransfer = (tx: unknown): tx is SolanaNativeTransfer =>
  typeof tx === 'object' && tx !== null && 'to' in tx && 'value' in tx
export const isTransactionMessage = (tx: unknown): tx is TransactionMessage =>
  typeof tx === 'object' && tx !== null && Array.isArray((tx as TransactionMessage).instructions)
