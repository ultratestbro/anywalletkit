import { decodeAddressWord, decodeUint, encodeParameters, hexToText, selector, splitCalldata } from './abi.js'
import { toBase58Address, toHexAddress } from './address.js'
import { isContractCall, isPrebuilt } from './shape.js'
import type { TronContractCall, TronNativeTransfer, TronRawTransaction, TronTransaction, TronTxDescription, TronTxWarning } from './types.js'

/** Tron's zero address (20 zero bytes behind the 0x41 prefix). */
export const ZERO_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
export const ZERO_ADDRESS_HEX = '41' + '0'.repeat(40)
const MAX_UINT256 = (1n << 256n) - 1n
const UNLIMITED_THRESHOLD = 1n << 255n

const SELECTORS: Record<string, 'transfer' | 'approve' | 'transferFrom'> = {
  a9059cbb: 'transfer',
  '095ea7b3': 'approve',
  '23b872dd': 'transferFrom',
}

export interface DescribeContext {
  /**
   * Whether the recipient account already exists on chain. Offline callers do not know;
   * `WalletAccountReadOnlyTron.describeTransactionOnline` fills it from `/wallet/getaccount`.
   */
  recipientExists?: boolean
  /** Unix ms "now" for the expiry warning (default Date.now()). */
  now?: number
}

const isZero = (hex: string) => hex.toLowerCase() === ZERO_ADDRESS_HEX
const b58 = (a: string | undefined) => (a ? toBase58Address(a) : undefined)
const isUnlimited = (v: bigint) => v === MAX_UINT256 || v >= UNLIMITED_THRESHOLD

function warn(list: TronTxWarning[], code: TronTxWarning['code'], message: string) {
  list.push({ code, message })
}

/** Decode a selector + ABI words into the TRC-20 part of a description. */
function describeCalldata(d: TronTxDescription, contract: string, data: string, warnings: TronTxWarning[]) {
  const { selector, words } = splitCalldata(data)
  d.selector = selector
  d.contract = toBase58Address(contract)
  const fn = SELECTORS[selector]
  if (fn === 'transfer' && words.length >= 2) {
    d.kind = 'trc20-transfer'
    d.token = d.contract
    d.to = toBase58Address(decodeAddressWord(words[0]!))
    d.amount = decodeUint(words[1]!)
    if (isZero(decodeAddressWord(words[0]!))) warn(warnings, 'zero-address', 'Tokens would be sent to the zero address (burned).')
  } else if (fn === 'approve' && words.length >= 2) {
    d.kind = 'trc20-approve'
    d.token = d.contract
    d.spender = toBase58Address(decodeAddressWord(words[0]!))
    d.amount = decodeUint(words[1]!)
    if (isUnlimited(d.amount)) warn(warnings, 'unlimited-approve', `Unlimited TRC-20 approval for ${d.spender}.`)
  } else {
    d.kind = 'contract-call'
    if (fn === 'transferFrom' && words.length >= 3) {
      d.from = toBase58Address(decodeAddressWord(words[0]!))
      d.to = toBase58Address(decodeAddressWord(words[1]!))
      d.amount = decodeUint(words[2]!)
      d.token = d.contract
    }
  }
}

function describeContractCall(tx: TronContractCall, warnings: TronTxWarning[]): TronTxDescription {
  const d: TronTxDescription = { kind: 'contract-call', warnings }
  // Re-encode the caller's parameters so the same decoder serves both input shapes.
  let data = selector(tx.functionSelector)
  try { data += encodeParameters(tx.parameters ?? []) } catch { /* unsupported param type: selector-only description */ }
  describeCalldata(d, tx.contractAddress, data, warnings)
  if (tx.options?.callValue) d.callValue = BigInt(tx.options.callValue)
  if (tx.options?.feeLimit !== undefined) d.feeLimit = tx.options.feeLimit
  return d
}

function describeRaw(tx: TronRawTransaction, warnings: TronTxWarning[], ctx: DescribeContext): TronTxDescription {
  const d: TronTxDescription = { kind: 'unknown', warnings }
  const contract = tx.raw_data?.contract?.[0]
  const v = (contract?.parameter?.value ?? {}) as Record<string, unknown>
  const from = b58(v.owner_address as string | undefined)
  if (from) d.from = from
  switch (contract?.type) {
    case 'TransferContract': {
      d.kind = 'trx-transfer'
      const to = toHexAddress(String(v.to_address))
      d.to = toBase58Address(to)
      d.amount = BigInt((v.amount as number | string) ?? 0)
      if (isZero(to)) warn(warnings, 'zero-address', 'TRX would be sent to the zero address (burned).')
      break
    }
    case 'TriggerSmartContract': {
      describeCalldata(d, String(v.contract_address), String(v.data ?? ''), warnings)
      if (v.call_value) d.callValue = BigInt(v.call_value as number | string)
      break
    }
    case 'FreezeBalanceV2Contract':
    case 'FreezeBalanceContract':
      d.kind = 'freeze'
      d.amount = BigInt((v.frozen_balance as number | string) ?? 0)
      d.resource = (v.resource as 'BANDWIDTH' | 'ENERGY' | undefined) ?? 'BANDWIDTH'
      break
    case 'UnfreezeBalanceV2Contract':
    case 'UnfreezeBalanceContract':
      d.kind = 'unfreeze'
      if (v.unfreeze_balance !== undefined) d.amount = BigInt(v.unfreeze_balance as number | string)
      d.resource = (v.resource as 'BANDWIDTH' | 'ENERGY' | undefined) ?? 'BANDWIDTH'
      break
    default:
      d.kind = 'unknown'
  }
  if (tx.raw_data?.fee_limit !== undefined) d.feeLimit = tx.raw_data.fee_limit
  if (tx.raw_data?.data) {
    d.memo = hexToText(tx.raw_data.data)
    warn(warnings, 'memo-fee', 'A memo is attached: the network charges the memo fee (1 TRX by default).')
  }
  if (tx.raw_data?.expiration !== undefined) {
    d.expiration = tx.raw_data.expiration
    if (tx.raw_data.expiration <= (ctx.now ?? Date.now())) warn(warnings, 'expired', 'The transaction has already expired.')
  }
  return d
}

/**
 * What a transaction does — decoded offline, no network. Works on the three input shapes
 * (`{to, value}`, contract call, node-built raw transaction). Only the `unactivated-recipient`
 * warning needs the chain; pass `ctx.recipientExists` or use `describeTransactionOnline`.
 */
export function describeTransaction(tx: TronTransaction, ctx: DescribeContext = {}): TronTxDescription {
  const warnings: TronTxWarning[] = []
  let d: TronTxDescription
  if (isPrebuilt(tx)) d = describeRaw(tx, warnings, ctx)
  else if (isContractCall(tx)) d = describeContractCall(tx, warnings)
  else {
    const { to, value } = tx as TronNativeTransfer
    const hex = toHexAddress(to)
    d = { kind: 'trx-transfer', warnings, to: toBase58Address(hex), amount: BigInt(value) }
    if (isZero(hex)) warn(warnings, 'zero-address', 'TRX would be sent to the zero address (burned).')
  }
  // Unbuilt shapes carry the memo as a field; node-built ones as raw_data.data (handled in describeRaw).
  const memo = !isPrebuilt(tx) ? (tx as { memo?: string }).memo : undefined
  if (memo) {
    d.memo = memo
    warn(warnings, 'memo-fee', 'A memo is attached: the network charges the memo fee (1 TRX by default).')
  }
  if (ctx.recipientExists === false && (d.kind === 'trx-transfer' || d.kind === 'trc20-transfer') && d.to) {
    warn(warnings, 'unactivated-recipient', d.kind === 'trx-transfer'
      ? `${d.to} does not exist yet: the transfer also pays the account creation fee (1.1 TRX without staked bandwidth).`
      : `${d.to} does not exist yet: a fresh TRC-20 holder costs more energy.`)
  }
  return d
}
