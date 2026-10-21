import { decodeAddressWord, decodeUint, encodeParameters, hexToText, selector, splitCalldata } from './abi.js'
import { toBase58Address, toHexAddress } from './address.js'
import { decodeRawData, isDecodedContractType } from './raw.js'
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
  // The bytes are what gets signed, so the bytes are what gets described. The JSON copy is
  // only consulted when there are no bytes at all, and then nothing can be signed anyway.
  let raw: TronRawTransaction['raw_data'] | undefined
  let undecodedFields: number[] = []
  if (typeof tx.raw_data_hex === 'string' && tx.raw_data_hex.length > 0) {
    try {
      const decoded = decodeRawData(tx.raw_data_hex)
      raw = decoded.raw_data
      // A type without a schema is reported once as "not decoded", not field by field.
      undecodedFields = [...decoded.unknownFields.map((n) => -n), ...decoded.raw_data.contract.flatMap((c) => (isDecodedContractType(c.type) ? c.undecoded : []))]
      // (TronDecodedRaw.raw_data is structurally a raw_data with richer contracts)
    } catch (e) {
      warn(warnings, 'raw-undecodable', `raw_data_hex is not a well-formed Transaction.raw (${(e as Error).message}); the wallet cannot say what this transaction does and will not sign it.`)
      return d
    }
  } else {
    raw = tx.raw_data
    warn(warnings, 'no-raw-hex', 'The transaction carries no raw_data_hex: this description comes from the unsigned JSON copy and the wallet will not sign it.')
  }
  const contracts = raw?.contract ?? []
  if (contracts.length !== 1) warn(warnings, 'multi-contract', `The transaction carries ${contracts.length} contracts; the wallet signs exactly one.`)
  const contract = contracts[0]
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
    case 'TransferAssetContract': {
      d.kind = 'trc10-transfer'
      const to = toHexAddress(String(v.to_address))
      d.to = toBase58Address(to)
      d.amount = BigInt((v.amount as number | string) ?? 0)
      if (typeof v.asset_name === 'string') d.token = hexToText(v.asset_name)
      if (isZero(to)) warn(warnings, 'zero-address', 'Tokens would be sent to the zero address (burned).')
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
      if (!contract) break
      if (isDecodedContractType(contract.type)) {
        const fields = Object.entries(v).filter(([k]) => k !== 'owner_address').map(([k, x]) => `${k}=${k.endsWith('_address') ? b58(String(x)) : String(x)}`)
        warn(warnings, 'undecoded', `${contract.type}: no summary for this contract type; decoded fields: ${fields.join(', ') || 'none'}.`)
      } else {
        warn(warnings, 'undecoded', `${contract.type}: this contract type is not decoded by the wallet — only its owner is known; its parameters are not shown, and the dApp's own description of them is not checked.`)
      }
  }
  if (contract?.type === 'AccountPermissionUpdateContract') warn(warnings, 'account-permission', 'AccountPermissionUpdateContract changes which keys control this account — a signature here can hand the account to someone else.')
  if (undecodedFields.length) warn(warnings, 'undecoded', `${contract?.type ?? 'transaction'}: field(s) ${undecodedFields.map((n) => (n < 0 ? `raw.${-n}` : String(n))).join(', ')} were not decoded; the sheet cannot show their meaning.`)
  if (raw?.fee_limit !== undefined) d.feeLimit = raw.fee_limit
  if (raw?.data) {
    d.memo = hexToText(raw.data)
    warn(warnings, 'memo-fee', 'A memo is attached: the network charges the memo fee (1 TRX by default).')
  }
  if (raw?.expiration !== undefined) {
    d.expiration = raw.expiration
    if (raw.expiration <= (ctx.now ?? Date.now())) warn(warnings, 'expired', 'The transaction has already expired.')
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
