/**
 * scan F7: the full node builds `raw_data` for `transfer` / `sendTransaction` /
 * `signTransaction`, and a malicious or compromised node could answer a USDT send with
 * `transfer(attacker, amount)` or a TRX send with an AccountPermissionUpdateContract —
 * owned by this account, consistent JSON, correct txID. So every node build is decoded
 * and compared with what was asked for before anything is simulated, priced or signed.
 */
import { bytesToHex } from '@noble/hashes/utils.js'
import { toHexAddress } from './address.js'
import { UnsafeTransactionError } from './errors.js'
import { readFields, verifyRawTransaction } from './raw.js'
import type { TronRawTransaction } from './types.js'

/** What the wallet asked the node to build. Addresses in any form; numbers in sun. */
export type ExpectedBuild =
  | { type: 'TransferContract'; owner: string; to: string; amount: bigint }
  | {
    type: 'TriggerSmartContract'; owner: string; contract: string
    /** selector ‖ ABI-encoded parameters, hex (0x optional, any case). */
    data: string
    callValue: bigint
    /** The `fee_limit` actually POSTed to `/wallet/triggersmartcontract`. */
    feeLimit: bigint
  }

const TYPE_URL_PREFIX = 'type.googleapis.com/protocol.'
/** Transaction.raw fields a node build carries: ref_block_bytes 1, ref_block_num 3, ref_block_hash 4, expiration 8, contract 11, timestamp 14, fee_limit 18 (+ data 10 for the memo the wallet splices in). */
const BUILD_FIELDS = [1, 3, 4, 8, 11, 14, 18]
const PARAM_KEYS: Record<ExpectedBuild['type'], string[]> = {
  TransferContract: ['owner_address', 'to_address', 'amount'],
  TriggerSmartContract: ['owner_address', 'contract_address', 'call_value', 'data'],
}

const fail = (what: string): never => {
  throw new UnsafeTransactionError('build-mismatch', `The node built a different transaction than requested — ${what}. Nothing was signed.`)
}
const big = (v: unknown): bigint => (v === undefined || v === null ? 0n : BigInt(v as number | string | bigint))
const sameAddress = (a: unknown, b: string): boolean => { try { return typeof a === 'string' && toHexAddress(a) === toHexAddress(b) } catch { return false } }

/**
 * Refuse a node-built transaction unless its bytes are exactly one contract of the
 * expected type with the expected owner, recipient / contract, amount / calldata,
 * call value and fee limit — no Permission_id, no TRC-10 token on the call, no second
 * contract, no field the request did not produce. `memo` = the bytes the wallet spliced
 * into `raw_data.data` (none → the field must be absent).
 */
export function assertNodeBuild(tx: TronRawTransaction, expected: ExpectedBuild, memo?: Uint8Array): void {
  const v = verifyRawTransaction(tx)
  const allowed = new Set(memo ? [...BUILD_FIELDS, 10] : BUILD_FIELDS)
  const top = readFields(v.bytes)
  const extra = top.filter((f) => !allowed.has(f.number)).map((f) => f.number)
  if (extra.length) fail(`raw_data carries field(s) ${[...new Set(extra)].join(', ')}`)
  const contracts = top.filter((f) => f.number === 11)
  if (contracts.length !== 1) fail(`${contracts.length} contracts instead of one`)
  const wrapper = readFields(contracts[0]!.value as Uint8Array).filter((f) => f.number !== 1 && f.number !== 2).map((f) => f.number)
  if (wrapper.length) fail(`the contract carries field(s) ${wrapper.join(', ')}${wrapper.includes(5) ? ' (Permission_id)' : ''}`)

  const c = v.raw_data.contract[0]!
  if (c.type !== expected.type) fail(`${c.type} instead of ${expected.type}`)
  if (c.parameter.type_url !== TYPE_URL_PREFIX + expected.type) fail(`type_url ${c.parameter.type_url}`)
  const p = c.parameter.value
  const unknownKeys = Object.keys(p).filter((k) => !PARAM_KEYS[expected.type].includes(k))
  if (unknownKeys.length) fail(`${expected.type} carries ${unknownKeys.join(', ')}`)
  if (!sameAddress(p.owner_address, expected.owner)) fail('the owner is not this account')

  if (expected.type === 'TransferContract') {
    if (!sameAddress(p.to_address, expected.to)) fail(`recipient ${String(p.to_address)} instead of ${toHexAddress(expected.to)}`)
    if (big(p.amount) !== expected.amount) fail(`amount ${String(p.amount)} instead of ${expected.amount}`)
    if (v.raw_data.fee_limit !== undefined) fail(`a TRX transfer with fee_limit ${v.raw_data.fee_limit}`)
  } else {
    if (!sameAddress(p.contract_address, expected.contract)) fail(`contract ${String(p.contract_address)} instead of ${toHexAddress(expected.contract)}`)
    const want = expected.data.replace(/^0x/, '').toLowerCase()
    if (String(p.data ?? '').toLowerCase() !== want) fail('the calldata differs from the requested call')
    if (big(p.call_value) !== expected.callValue) fail(`call_value ${String(p.call_value ?? 0)} instead of ${expected.callValue}`)
    if (big(v.raw_data.fee_limit) !== expected.feeLimit) fail(`fee_limit ${String(v.raw_data.fee_limit ?? 0)} instead of ${expected.feeLimit}`)
  }

  const data = v.raw_data.data
  if (memo ? data !== bytesToHex(memo) : data !== undefined) fail(memo ? 'the memo differs' : 'an unrequested memo')
}
