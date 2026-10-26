/**
 * Where a write goes, read off every transaction shape the chain packages
 * accept (scan F16/F17) — not only `to` / `recipient`. The allow/block lists
 * check every destination found here; when a shape cannot be read the write
 * is flagged `unknown` instead of silently passing.
 *
 * Self-contained on purpose (the kit has no chain-package dependencies and
 * runs on Hermes): a minimal reader for each wire format, used ONLY to find
 * destinations. The chain packages still verify the bytes strictly before
 * signing (wallet-tron refuses non-canonical `raw_data_hex`, scan F4), so a
 * transaction this reader understands differently is one they refuse.
 */

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export interface Destinations {
  /** Every destination found (recipients, called contracts / programs, NEAR receivers, TON message targets), in the form the call carries. */
  list: string[]
  /** Part of the write could not be read (an unknown shape, undecodable bytes, an address-lookup-table account): `list` may be incomplete. */
  unknown: boolean
  /**
   * Solana token accounts an SPL transfer pays into. The recipient is their owner, which only the
   * network knows: the policies read it through the account (`getTokenAccountOwner`) and treat the
   * write as `unknown` when they cannot (round 3, M1). Owners of accounts the same transaction
   * creates as associated token accounts are already in `list`.
   */
  tokenAccounts?: string[]
}

/** A table lookup by own key only (`__proto__` / `constructor` from a caller are not entries). */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined)

const known = (list: Array<string | undefined>): Destinations => {
  const out = list.filter((d): d is string => d !== undefined && d !== '')
  return { list: [...new Set(out)], unknown: out.length !== list.length }
}
const UNKNOWN: Destinations = { list: [], unknown: true }

// ── encodings ────────────────────────────────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(s: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s) || s.length > 128) return null
  let zeros = 0
  while (s[zeros] === '1') zeros++
  const le: number[] = [] // base 256, little-endian
  for (const ch of s) {
    let carry = B58.indexOf(ch)
    for (let j = 0; j < le.length; j++) { carry += le[j]! * 58; le[j] = carry & 0xff; carry >>= 8 }
    while (carry > 0) { le.push(carry & 0xff); carry >>= 8 }
  }
  const out = new Uint8Array(zeros + le.length)
  for (let k = 0; k < le.length; k++) out[zeros + k] = le[le.length - 1 - k]!
  return out
}

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const le: number[] = [] // base 58, little-endian
  for (let k = zeros; k < bytes.length; k++) {
    let carry = bytes[k]!
    for (let j = 0; j < le.length; j++) { carry += le[j]! << 8; le[j] = carry % 58; carry = (carry / 58) | 0 }
    while (carry > 0) { le.push(carry % 58); carry = (carry / 58) | 0 }
  }
  let out = '1'.repeat(zeros)
  for (let k = le.length - 1; k >= 0; k--) out += B58[le[k]!]
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Far above any real wire transaction (Solana ≤ 1 232 bytes, NEAR ≤ 4 MiB): longer input is not decoded at all. */
const MAX_BASE64_CHARS = 8 * 1024 * 1024

function base64Decode(s: string): Uint8Array | null {
  if (s.length > MAX_BASE64_CHARS) return null
  // Strip the padding with a linear walk: the old /=+$/ was quadratic on a long '====…A' run (scan 2026-10-23 F11).
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 61 /* = */) end--
  const clean = s.slice(0, end).replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) return null
  const out: number[] = []
  let buf = 0
  let bits = 0
  for (const ch of clean) {
    buf = ((buf << 6) | B64.indexOf(ch)) & 0xffffff
    bits += 6
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff) }
  }
  return Uint8Array.from(out)
}

/** Latin-1 view of bytes: type URLs and NEAR account ids are ASCII (anything else fails their checks). No TextDecoder: Hermes. */
const ascii = (b: Uint8Array) => { let out = ''; for (const x of b) out += String.fromCharCode(x); return out }
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string): Uint8Array | null => {
  const s = h.replace(/^0x/, '')
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return null
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16)
  return out
}

// ── canonical forms (comparison only) ────────────────────────────────────────

/** Tron: any accepted form (base58 T…, hex 41…, 0x41…) → lowercase 21-byte hex `41…`. */
export function tronHexAddress(address: string): string | null {
  if (/^(0x)?41[0-9a-fA-F]{40}$/.test(address)) return address.replace(/^0x/, '').toLowerCase()
  const b = base58Decode(address)
  return b && b.length === 25 && b[0] === 0x41 ? toHex(b.subarray(0, 21)) : null
}

/** TON: raw `wc:hex` or a friendly (base64 / base64url, 36 bytes) address → `wc:hex` lowercase. */
export function tonRawAddress(address: string): string | null {
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(address)
  if (raw) return `${Number(raw[1])}:${raw[2]!.toLowerCase()}`
  if (address.length !== 48) return null
  const b = base64Decode(address)
  if (!b || b.length !== 36) return null
  const wc = b[1]! > 127 ? b[1]! - 256 : b[1]!
  return `${wc}:${toHex(b.subarray(2, 34))}`
}

/** The form the allow/block lists compare in, per chain namespace: EVM lowercase, Tron hex, TON raw; anything else lowercase. */
export function canonicalAddress(chain: string, address: string): string {
  const ns = chain.split(':')[0]
  if (ns === 'tron') return tronHexAddress(address) ?? address.toLowerCase()
  if (ns === 'ton') return tonRawAddress(address) ?? address.toLowerCase()
  return address.toLowerCase()
}

// ── EVM / Tron calldata: who receives tokens or rights inside a standard call ──

/**
 * Standard token calls whose calldata names who gets the tokens or the allowance (round 3, M1),
 * with the ABI words holding that address and the least number of words the call takes. The
 * contract called is a destination too; these add the recipient or spender it pays. Any other
 * call is judged by the contract it calls.
 */
const CALL_RECIPIENTS: Readonly<Record<string, { words: readonly number[]; min: number }>> = {
  '0xa9059cbb': { words: [0], min: 2 }, // transfer(address,uint256) — ERC-20
  '0x4000aea0': { words: [0], min: 3 }, // transferAndCall(address,uint256,bytes) — ERC-677
  '0x23b872dd': { words: [1], min: 3 }, // transferFrom(address,address,uint256) — ERC-20 / ERC-721
  '0x42842e0e': { words: [1], min: 3 }, // safeTransferFrom(address,address,uint256) — ERC-721
  '0xb88d4fde': { words: [1], min: 4 }, // safeTransferFrom(address,address,uint256,bytes) — ERC-721
  '0xf242432a': { words: [1], min: 5 }, // safeTransferFrom(address,address,uint256,uint256,bytes) — ERC-1155
  '0x2eb2c2d6': { words: [1], min: 5 }, // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes) — ERC-1155
  '0x095ea7b3': { words: [0], min: 2 }, // approve(address,uint256)
  '0x39509351': { words: [0], min: 2 }, // increaseAllowance(address,uint256)
  '0xa22cb465': { words: [0], min: 2 }, // setApprovalForAll(address,bool)
  '0x87517c45': { words: [1], min: 4 }, // Permit2 approve(address token,address spender,uint160,uint48)
  '0xd505accf': { words: [1], min: 7 }, // permit(owner,spender,value,deadline,v,r,s) — an EIP-2612 permit sent on chain
}
const ZERO_WORD = '0'.repeat(64)

/** Calldata as 0x-hex: a hex string as given, bytes encoded; anything else undefined. */
export function hexData(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return `0x${toHex(v)}`
  return undefined
}

/**
 * The recipient / spender a standard token call names (20-byte hex, lowercase, no prefix), or
 * null for any other call. A known selector with too few words is `bad`: the reading is
 * incomplete. The zero address (an NFT approval being cleared) and `setApprovalForAll(…, false)`
 * name nobody. Like the contracts that mask, the address is the low 20 bytes of its word.
 */
export function calldataRecipients(data: string): { list: string[]; bad: boolean } | null {
  const hex = data.toLowerCase()
  const rule = own(CALL_RECIPIENTS, hex.slice(0, 10))
  if (!rule) return null
  const words = hex.slice(10)
  if (!/^[0-9a-f]*$/.test(words) || words.length < rule.min * 64) return { list: [], bad: true }
  const word = (i: number) => words.slice(i * 64, i * 64 + 64)
  if (hex.startsWith('0xa22cb465') && word(1) === ZERO_WORD) return { list: [], bad: false }
  return { list: rule.words.map(word).filter((w) => w !== ZERO_WORD).map((w) => w.slice(24)), bad: false }
}

/** An ERC-20 `transfer` / `transferAndCall`: who is paid and how much, for the intent. Null for anything else. */
export function erc20Transfer(data: string): { recipient: string; amount: bigint } | null {
  const hex = data.toLowerCase()
  const words = hex.slice(10)
  if (!(hex.startsWith('0xa9059cbb') || hex.startsWith('0x4000aea0')) || !/^[0-9a-f]*$/.test(words) || words.length < 128) return null
  return { recipient: `0x${words.slice(24, 64)}`, amount: BigInt(`0x${words.slice(64, 128)}`) }
}

// ── Tron: Transaction.raw (protobuf) ─────────────────────────────────────────

class Reader {
  i = 0
  constructor(readonly b: Uint8Array) {}
  get done() { return this.i >= this.b.length }
  varint(): number {
    let v = 0
    let mul = 1
    for (let n = 0; n < 10; n++) {
      if (this.i >= this.b.length) throw new Error('truncated varint')
      const byte = this.b[this.i++]!
      v += (byte & 0x7f) * mul
      if ((byte & 0x80) === 0) return v
      mul *= 128
    }
    throw new Error('varint too long')
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.i + n > this.b.length) throw new Error('truncated')
    const out = this.b.subarray(this.i, this.i + n)
    this.i += n
    return out
  }
  /** Protobuf fields: `[number, wire, value]` with length-delimited values as bytes. */
  fields(): Array<[number, number, Uint8Array | number]> {
    const out: Array<[number, number, Uint8Array | number]> = []
    while (!this.done) {
      const tag = this.varint()
      const number = Math.floor(tag / 8)
      const wire = tag % 8
      if (wire === 0) out.push([number, wire, this.varint()])
      else if (wire === 2) out.push([number, wire, this.bytes(this.varint())])
      else if (wire === 1) out.push([number, wire, this.bytes(8)])
      else if (wire === 5) out.push([number, wire, this.bytes(4)])
      else throw new Error(`wire type ${wire}`)
    }
    return out
  }
}

/** Address-typed fields that name where a Tron contract sends value or calls: to_address (Transfer / TransferAsset), contract_address (TriggerSmartContract), receiver_address (DelegateResource / UnDelegateResource). */
const TRON_DESTINATION_FIELDS: Record<string, number[]> = {
  TransferContract: [2],
  TransferAssetContract: [3],
  TriggerSmartContract: [2],
  DelegateResourceContract: [4],
  UnDelegateResourceContract: [4],
}
/** Contracts that move nothing to anyone else (stake, vote, withdraw to self): no destination, and not "unknown". */
const TRON_SELF_CONTRACTS = new Set(['FreezeBalanceContract', 'UnfreezeBalanceContract', 'FreezeBalanceV2Contract', 'UnfreezeBalanceV2Contract', 'WithdrawExpireUnfreezeContract', 'CancelAllUnfreezeV2Contract', 'WithdrawBalanceContract', 'VoteWitnessContract'])
const TRON_TYPE_BY_ENUM: Record<number, string> = { 1: 'TransferContract', 2: 'TransferAssetContract', 4: 'VoteWitnessContract', 11: 'FreezeBalanceContract', 12: 'UnfreezeBalanceContract', 13: 'WithdrawBalanceContract', 31: 'TriggerSmartContract', 54: 'FreezeBalanceV2Contract', 55: 'UnfreezeBalanceV2Contract', 56: 'WithdrawExpireUnfreezeContract', 57: 'DelegateResourceContract', 58: 'UnDelegateResourceContract', 59: 'CancelAllUnfreezeV2Contract' }

/** Destinations of `raw_data_hex` — the bytes the signature covers. */
export function tronRawDestinations(rawHex: string): Destinations {
  try {
    const bytes = fromHex(rawHex)
    if (!bytes || bytes.length === 0) return UNKNOWN
    const out: Array<string | undefined> = []
    let contracts = 0
    for (const [n, w, v] of new Reader(bytes).fields()) {
      if (n !== 11 || w !== 2) continue
      contracts++
      let enumType: number | undefined
      let typeUrl: string | undefined
      let param: Uint8Array | undefined
      for (const [cn, cw, cv] of new Reader(v as Uint8Array).fields()) {
        if (cn === 1 && cw === 0) enumType = cv as number
        else if (cn === 2 && cw === 2) {
          for (const [an, aw, av] of new Reader(cv as Uint8Array).fields()) {
            if (an === 1 && aw === 2) typeUrl = ascii(av as Uint8Array)
            else if (an === 2 && aw === 2) param = av as Uint8Array
          }
        }
      }
      const type = typeUrl?.split('.').pop() ?? (enumType !== undefined ? TRON_TYPE_BY_ENUM[enumType] : undefined)
      if (!type || !param) { out.push(undefined); continue }
      if (TRON_SELF_CONTRACTS.has(type)) continue
      const wanted = own(TRON_DESTINATION_FIELDS, type)
      if (!wanted) { out.push(undefined); continue }
      const fields = new Reader(param).fields()
      const found = fields.filter(([pn, pw, pv]) => wanted.includes(pn) && pw === 2 && (pv as Uint8Array).length === 21)
      if (found.length === 0) out.push(undefined)
      for (const [, , pv] of found) out.push(toHex(pv as Uint8Array))
      if (type === 'TriggerSmartContract') {
        // The TRC-20 recipient or spender inside the call data (field 4), as a 41… address (round 3, M1).
        const data = fields.find(([pn, pw]) => pn === 4 && pw === 2)
        const r = data ? calldataRecipients(`0x${toHex(data[2] as Uint8Array)}`) : null
        if (r) { for (const w of r.list) out.push(`41${w}`); if (r.bad) out.push(undefined) }
      }
    }
    if (contracts === 0) return UNKNOWN
    return known(out)
  } catch {
    return UNKNOWN
  }
}

// ── NEAR: borsh Transaction / SignedTransaction prefix ───────────────────────

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

/** Function calls whose JSON args name who receives tokens (NEP-141 / NEP-171) or storage (NEP-145), and the arg that names them (round 3, M1). */
const NEAR_RECIPIENT_ARG: Readonly<Record<string, string>> = {
  ft_transfer: 'receiver_id', ft_transfer_call: 'receiver_id', nft_transfer: 'receiver_id', nft_transfer_call: 'receiver_id', storage_deposit: 'account_id',
}

/**
 * The recipient a function call's args name, read off the bytes wallet-near signs: objects go
 * through JSON.stringify first, exactly as wallet-near encodes them (a `toJSON` cannot show one
 * receiver and sign another). `storage_deposit` without `account_id` deposits for the caller.
 */
function nearArgRecipient(method: string, args: unknown): Array<string | undefined> {
  const key = own(NEAR_RECIPIENT_ARG, method)
  if (!key) return []
  try {
    const json = args instanceof Uint8Array ? ascii(args) : typeof args === 'string' ? args : JSON.stringify(args)
    const parsed = obj(JSON.parse(json))
    if (parsed[key] === undefined && method === 'storage_deposit') return []
    return [str(parsed[key])]
  } catch {
    return [undefined]
  }
}

/** One NEAR action → who it pays besides the transaction's receiver: token recipients, the deleted account's beneficiary, a delegated action's receivers. */
function nearActionRecipients(action: unknown, depth = 0): Array<string | undefined> {
  const a = obj(action)
  const call = obj(a.functionCall)
  if (a.functionCall !== undefined) return nearArgRecipient(str(call.methodName) ?? '', call.args)
  if (a.deleteAccount !== undefined) return [str(obj(a.deleteAccount).beneficiaryId)]
  if (a.signedDelegate !== undefined) {
    if (depth > 0) return [undefined]
    const d = obj(obj(a.signedDelegate).delegateAction)
    const inner = Array.isArray(d.actions) ? d.actions.flatMap((x: unknown) => nearActionRecipients(x, depth + 1)) : [undefined]
    return [str(d.receiverId), ...inner]
  }
  return []
}

/** Destinations of a base64 borsh NEAR transaction (unsigned or signed: the transaction comes first). */
function nearBorshDestinations(b64: string): Destinations {
  const b = base64Decode(b64)
  if (!b) return UNKNOWN
  let i = 0
  const need = (n: number) => { if (!(n >= 0) || i + n > b.length) throw new Error('truncated') }
  const skip = (n: number) => { need(n); i += n }
  const u8 = () => { need(1); return b[i++]! }
  const u32 = () => { need(4); const v = b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24); i += 4; return v >>> 0 }
  const bytes = () => { const n = u32(); need(n); const out = b.subarray(i, i + n); i += n; return out }
  const string = (max: number) => { const s = bytes(); if (s.length > max) throw new Error('bad string'); return ascii(s) }
  const account = () => { const s = string(64); if (!NEAR_ACCOUNT.test(s)) throw new Error('bad account id'); return s }
  const publicKey = () => { const t = u8(); if (t !== 0 && t !== 1) throw new Error('key type'); skip(t === 0 ? 32 : 64) }
  /** One action's recipients; null for an action not read here (Delegate, global contracts…): reading stops. */
  const action = (): Array<string | undefined> | null => {
    switch (u8()) {
      case 0: return [] // CreateAccount
      case 1: bytes(); return [] // DeployContract
      case 2: { const method = string(256); const args = bytes(); skip(8 + 16); return nearArgRecipient(method, args) } // FunctionCall
      case 3: skip(16); return [] // Transfer: to the receiver
      case 4: skip(16); publicKey(); return [] // Stake
      case 5: { // AddKey
        publicKey(); skip(8)
        const permission = u8()
        if (permission === 0) { if (u8() === 1) skip(16); string(64); const n = u32(); for (let k = 0; k < n; k++) string(256) } else if (permission !== 1) throw new Error('permission')
        return []
      }
      case 6: publicKey(); return [] // DeleteKey
      case 7: return [account()] // DeleteAccount: the beneficiary
      default: return null
    }
  }
  try {
    account() // signer
    publicKey()
    skip(8) // nonce
    const out: Array<string | undefined> = [account()] // receiver
    skip(32) // block hash
    const n = u32()
    for (let k = 0; k < n; k++) {
      const r = action()
      if (r === null) { out.push(undefined); break }
      out.push(...r)
    }
    return known(out)
  } catch {
    return UNKNOWN
  }
}

// ── Solana: wire transaction / message / kit TransactionMessage ─────────────

const SYSTEM = '11111111111111111111111111111111'
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
/** Programs that move nothing to anyone: compute budget, memo, associated-token-account creation (rent only). */
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const STAKE = 'Stake11111111111111111111111111111111111111'
const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111'
const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111'

/**
 * A Stake-program instruction → whom it gives stake, lamports or authority (NS-2): Withdraw its
 * recipient, Authorize* the new authority, Initialize* staker and withdrawer (and a custodian),
 * SetLockup* the custodian, DelegateStake the vote account, Split / Move* the destination account,
 * Merge the account merged into. Deactivate and the read-only ones name nobody. Checked forms are
 * read in both account layouts (with or without the CLOCK / RENT sysvar), as wallet-solana's
 * decodeStakeInstruction reads them. Unknown tags, truncated data and the retired Redelegate are unknown.
 */
function stakeIxDestinations(ix: SolIx): Array<string | undefined> {
  const d = ix.data
  const at = (n: number) => ix.accounts[n]
  const keyAt = (offset: number) => (d.length >= offset + 32 ? base58Encode(d.subarray(offset, offset + 32)) : undefined)
  if (d.length < 4) return [undefined]
  const tag = d[0]! | (d[1]! << 8) | (d[2]! << 16) | (d[3]! << 24)
  switch (tag) {
    case 0: { // Initialize(Authorized { staker, withdrawer }, Lockup { unix_timestamp, epoch, custodian })
      if (d.length < 116) return [undefined]
      const custodian = keyAt(84)
      return [keyAt(4), keyAt(36), ...(custodian !== SYSTEM ? [custodian] : [])]
    }
    case 1: case 8: return [keyAt(4)] // Authorize / AuthorizeWithSeed: new authority first in the data
    case 2: return [at(1)] // DelegateStake: the vote account
    case 3: case 4: case 16: case 17: return [at(1)] // Split / Withdraw / MoveStake / MoveLamports: the account paid
    case 5: case 13: case 14: return [] // Deactivate, GetMinimumDelegation, DeactivateDelinquent
    case 6: { // SetLockup(LockupArgs { Option<i64>, Option<u64>, Option<Pubkey> })
      let i = 4
      for (const size of [8, 8]) { if (d[i] === undefined) return [undefined]; i += d[i] === 1 ? 1 + size : 1 }
      if (d[i] === undefined) return [undefined]
      return d[i] === 1 ? [keyAt(i + 1)] : []
    }
    case 7: return [at(0)] // Merge: the destination stake account
    case 9: { const legacy = at(1) === SYSVAR_RENT; return [at(legacy ? 2 : 1), at(legacy ? 3 : 2)] } // InitializeChecked
    case 10: return [at(at(1) === SYSVAR_CLOCK ? 3 : 2)] // AuthorizeChecked
    case 11: return [at(at(2) === SYSVAR_CLOCK ? 3 : 2)] // AuthorizeCheckedWithSeed
    case 12: return at(2) !== undefined ? [at(2)] : [] // SetLockupChecked: the new custodian when given
    default: return [undefined]
  }
}
const SOLANA_NEUTRAL = new Set(['ComputeBudget111111111111111111111111111111', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', ATA_PROGRAM])

interface SolIx { program: string | undefined; accounts: Array<string | undefined>; data: Uint8Array }

/**
 * One instruction → where it sends: the recipient of a SOL transfer, a delegate, a close
 * destination, else the program called. An SPL transfer pays a token account whose owner is the
 * recipient: that account goes to `tokenAccounts` for the policies to resolve (round 3, M1).
 */
function solanaIxDestinations(ix: SolIx, tokenAccounts: string[]): Array<string | undefined> {
  if (ix.program === undefined) return [undefined]
  if (SOLANA_NEUTRAL.has(ix.program)) return []
  const d = ix.data
  if (ix.program === SYSTEM) {
    const disc = d.length >= 4 ? d[0]! | (d[1]! << 8) | (d[2]! << 16) | (d[3]! << 24) : -1
    if (disc === 2 || disc === 0 || disc === 3) return [ix.accounts[1]] // Transfer, CreateAccount(WithSeed): the funded account
    if (disc === 11) return [ix.accounts[2]] // TransferWithSeed
    if (disc === 4) return [] // AdvanceNonceAccount
    return [undefined] // Assign / Allocate / nonce authority changes: not something a destination list can judge
  }
  if (ix.program === STAKE) return stakeIxDestinations(ix)
  if (ix.program === TOKEN || ix.program === TOKEN_2022) {
    const pay = (account: string | undefined) => { if (account === undefined) return [undefined]; tokenAccounts.push(account); return [] }
    switch (d[0]) {
      case 3: return pay(ix.accounts[1]) // Transfer: into a token account
      case 12: return pay(ix.accounts[2]) // TransferChecked: into a token account
      case 4: case 9: return [ix.accounts[1]] // Approve (delegate), CloseAccount (lamports to)
      case 13: return [ix.accounts[2]] // ApproveChecked (delegate)
      case 1: case 5: case 16: case 17: case 18: return [] // InitializeAccount(2/3), Revoke, SyncNative
      default: return [undefined]
    }
  }
  return [ix.program]
}

function shortvec(b: Uint8Array, at: { i: number }): number {
  let v = 0
  for (let n = 0; n < 3; n++) {
    const byte = b[at.i++]
    if (byte === undefined) throw new Error('truncated')
    v |= (byte & 0x7f) << (7 * n)
    if ((byte & 0x80) === 0) return v
  }
  throw new Error('shortvec too long')
}

function solanaMessageInstructions(msg: Uint8Array): SolIx[] {
  const at = { i: 0 }
  if (msg[0]! & 0x80) at.i = 1 // versioned (v0): lookup-table accounts are not resolvable here
  at.i += 3 // header
  const nKeys = shortvec(msg, at)
  const keys: string[] = []
  for (let k = 0; k < nKeys; k++) {
    if (at.i + 32 > msg.length) throw new Error('truncated')
    keys.push(base58Encode(msg.subarray(at.i, at.i + 32)))
    at.i += 32
  }
  at.i += 32 // recent blockhash
  const nIx = shortvec(msg, at)
  const out: SolIx[] = []
  for (let n = 0; n < nIx; n++) {
    const program = keys[msg[at.i++]!]
    const nAcc = shortvec(msg, at)
    const accounts: Array<string | undefined> = []
    for (let a = 0; a < nAcc; a++) accounts.push(keys[msg[at.i++]!])
    const len = shortvec(msg, at)
    if (at.i + len > msg.length) throw new Error('truncated')
    out.push({ program, accounts, data: msg.subarray(at.i, at.i + len) })
    at.i += len
  }
  return out
}

function solanaWireInstructions(wire: Uint8Array): SolIx[] {
  const at = { i: 0 }
  const nSigs = shortvec(wire, at)
  return solanaMessageInstructions(wire.subarray(at.i + 64 * nSigs))
}

function fromIxList(list: SolIx[]): Destinations {
  if (list.length === 0) return UNKNOWN
  // An associated token account the same transaction creates: the program checks it is the ATA of
  // the owner it names (else the whole transaction fails), so that owner is the recipient.
  const ataOwner = new Map<string, string>()
  for (const ix of list) {
    const [ata, owner] = [ix.accounts[1], ix.accounts[2]]
    if (ix.program === ATA_PROGRAM && (ix.data.length === 0 || ix.data[0] === 0 || ix.data[0] === 1) && ata !== undefined && owner !== undefined) ataOwner.set(ata, owner)
  }
  const pending: string[] = []
  const out = known(list.flatMap((ix) => solanaIxDestinations(ix, pending)))
  const unresolved = [...new Set(pending.filter((t) => !ataOwner.has(t)))]
  const owners = pending.flatMap((t) => { const o = ataOwner.get(t); return o !== undefined ? [o] : [] })
  return { list: [...new Set([...out.list, ...owners])], unknown: out.unknown, ...(unresolved.length > 0 ? { tokenAccounts: unresolved } : {}) }
}

function solanaDestinations(arg: unknown): Destinations {
  try {
    if (typeof arg === 'string') {
      const b = base64Decode(arg)
      return b ? fromIxList(solanaWireInstructions(b)) : UNKNOWN
    }
    // wallet-solana's own order (guards.ts): a compiled transaction has messageBytes AND signatures,
    // a native transfer has `to` AND `value`, a message has `instructions`. An object that fits two
    // of these is not judged by either reading (round 3, H2).
    const a = obj(arg)
    const compiled = 'messageBytes' in a && 'signatures' in a
    const native = 'to' in a && 'value' in a
    const message = Array.isArray(a.instructions)
    if (Number(compiled) + Number(native) + Number(message) !== 1) return UNKNOWN
    if (compiled) return a.messageBytes instanceof Uint8Array ? fromIxList(solanaMessageInstructions(a.messageBytes)) : UNKNOWN
    if (native) { const to = str(a.to); return to !== undefined ? known([to]) : UNKNOWN }
    return fromIxList((a.instructions as unknown[]).map((raw) => {
      const ix = obj(raw)
      const data = ix.data instanceof Uint8Array ? ix.data : new Uint8Array()
      const accounts = Array.isArray(ix.accounts) ? ix.accounts.map((acc) => str(obj(acc).address)) : []
      return { program: str(ix.programAddress), accounts, data }
    }))
  } catch {
    return UNKNOWN
  }
}

// ── per chain ────────────────────────────────────────────────────────────────

/** TRC-20 / TRC-721 calls by their exact `functionSelector`: the index of the parameter that receives the tokens or the allowance. */
const TRON_CALL_RECIPIENT: Readonly<Record<string, number>> = {
  'transfer(address,uint256)': 0, 'approve(address,uint256)': 0, 'increaseAllowance(address,uint256)': 0,
  'transferFrom(address,address,uint256)': 1, 'safeTransferFrom(address,address,uint256)': 1, 'safeTransferFrom(address,address,uint256,bytes)': 1,
  'setApprovalForAll(address,bool)': 0,
}

function tronDestinations(arg: unknown): Destinations {
  let a: Record<string, unknown>
  if (typeof arg === 'string') {
    try { a = obj(JSON.parse(arg)) } catch { return UNKNOWN }
  } else a = obj(arg)
  // wallet-tron's own order (shape.ts): prebuilt when `txID` is a string, a contract call when
  // `functionSelector` is, otherwise a TRX send to `to`. Fields of another shape riding along make
  // the reading ambiguous (round 3, H2).
  const prebuilt = typeof a.txID === 'string'
  const call = typeof a.functionSelector === 'string'
  const foreign = (...keys: string[]) => keys.some((k) => a[k] !== undefined)
  if (prebuilt) {
    // Only the signed bytes count, never the JSON copy next to them (scan F17).
    if (call || foreign('to', 'contractAddress', 'value')) return UNKNOWN
    return typeof a.raw_data_hex === 'string' ? tronRawDestinations(a.raw_data_hex) : UNKNOWN
  }
  if (foreign('raw_data', 'raw_data_hex', 'txID')) return UNKNOWN
  if (call) {
    if (foreign('to', 'value')) return UNKNOWN
    const c = str(a.contractAddress)
    if (c === undefined) return UNKNOWN
    // A TRC-20 call names its recipient or spender in `parameters` (round 3, M1). The selector is
    // hashed as written, so only the exact signature counts; the address must be typed `address`.
    const at = own(TRON_CALL_RECIPIENT, str(a.functionSelector)!)
    if (at === undefined) return known([c])
    const p = obj(Array.isArray(a.parameters) ? a.parameters[at] : undefined)
    return known([c, p.type === 'address' ? str(p.value) : undefined])
  }
  if (foreign('contractAddress')) return UNKNOWN
  const to = str(a.to)
  return to !== undefined ? known([to]) : UNKNOWN
}

function nearDestinations(arg: unknown): Destinations {
  if (typeof arg === 'string') return nearBorshDestinations(arg)
  // wallet-near builds from `receiverId` and nothing else (round 3, review); its actions can pay others (M1).
  const a = obj(arg)
  const to = str(a.receiverId)
  if (to === undefined) return UNKNOWN
  return known([to, ...(Array.isArray(a.actions) ? a.actions.flatMap((x: unknown) => nearActionRecipients(x)) : [undefined])])
}

// ── TON: message bodies that pay someone other than `to` (round 3, M1) ────────

const TON_JETTON_TRANSFER = 0x0f8a7ea5n // TEP-74 transfer: query_id, amount, destination, response_destination
const TON_NFT_TRANSFER = 0x5fcc3d14n // TEP-62 transfer: query_id, new_owner, response_destination
const TON_JETTON_BURN = 0x595f07bcn // TEP-74 burn: query_id, amount, response_destination

interface BitReader { length: number; uint(n: number): bigint; coins(): bigint; address(): string | null | undefined }

function bitReader(bit: (i: number) => boolean, length: number): BitReader {
  let i = 0
  const uint = (n: number): bigint => {
    if (i + n > length) throw new Error('truncated')
    let v = 0n
    for (let k = 0; k < n; k++) v = (v << 1n) | (bit(i++) ? 1n : 0n)
    return v
  }
  return {
    length,
    uint,
    coins: () => uint(Number(uint(4).toString()) * 8), // 4-bit byte count, bounded 0..15
    // MsgAddress: addr_none → null; addr_std → "wc:hex"; anycast, extern or var → undefined (not read here).
    address: () => {
      const tag = uint(2)
      if (tag === 0n) return null
      if (tag !== 2n || uint(1) !== 0n) return undefined
      const wc = uint(8)
      return `${wc >= 128n ? wc - 256n : wc}:${uint(256).toString(16).padStart(64, '0')}`
    },
  }
}

/** The root cell of a base64 BoC (data bits only), or undefined when the bytes are not a plain BoC. */
function bocRootReader(b64: string): BitReader | undefined {
  const b = base64Decode(b64)
  if (!b || b.length < 6 || b[0] !== 0xb5 || b[1] !== 0xee || b[2] !== 0x9c || b[3] !== 0x72) return undefined
  let i = 4
  const flags = b[i++]!
  const size = flags & 0x07
  const offBytes = b[i++]!
  if (size < 1 || size > 4 || offBytes < 1 || offBytes > 8) return undefined
  const int = (n: number) => { if (i + n > b.length) throw new Error('truncated'); let v = 0; for (let k = 0; k < n; k++) v = v * 256 + b[i++]!; return v }
  try {
    const cells = int(size)
    const roots = int(size)
    int(size) // absent
    int(offBytes) // total cells size
    if (roots < 1) return undefined
    const root = int(size)
    i += (roots - 1) * size
    if (flags & 0x80) i += cells * offBytes // index
    for (let c = 0; c <= root && c < cells; c++) {
      if (i + 2 > b.length) return undefined
      const d1 = b[i++]!
      const d2 = b[i++]!
      const len = Math.ceil(d2 / 2)
      if (i + len > b.length) return undefined
      const data = b.subarray(i, i + len)
      i += len + (d1 & 7) * size
      if (c !== root) continue
      if (d1 & 8) return undefined // exotic
      let bits = len * 8
      if (d2 % 2 === 1) {
        const last = data[len - 1]
        if (!last) return undefined
        let t = 0
        while (((last >> t) & 1) === 0) t++
        bits -= t + 1 // completion tag
      }
      return bitReader((k) => ((data[k >> 3]! >> (7 - (k & 7))) & 1) === 1, bits)
    }
  } catch {
    return undefined
  }
  return undefined
}

/** A TON Cell (as @ton/core builds it): read through its `bits`. Anything else undefined. */
function cellReader(v: unknown): BitReader | undefined {
  const bits = obj(obj(v).bits) as { length?: unknown; at?: unknown }
  if (typeof bits.at !== 'function' || typeof bits.length !== 'number' || bits.length > 1023) return undefined
  const at = bits.at as (i: number) => boolean
  return bitReader((k) => at.call(bits, k) === true, bits.length)
}

/** Who a message body pays besides `to`: a jetton transfer's destination and excess receiver, an NFT's new owner, a burn's excess receiver. */
function tonBodyRecipients(m: Record<string, unknown>): Array<string | undefined> {
  // wallet-ton's order: `body` (a string is a text comment) wins over `bodyBoc`.
  if (typeof m.body === 'string' || (m.body === undefined && m.bodyBoc === undefined)) return []
  const r = m.body !== undefined ? cellReader(m.body) : typeof m.bodyBoc === 'string' ? bocRootReader(m.bodyBoc) : undefined
  if (!r) return [undefined]
  const named = (...a: Array<string | null | undefined>) => a.filter((x): x is string | undefined => x !== null)
  try {
    if (r.length < 32) return []
    const op = r.uint(32)
    if (op === TON_JETTON_TRANSFER) { r.uint(64); r.coins(); return named(r.address(), r.address()) }
    if (op === TON_NFT_TRANSFER) { r.uint(64); return named(r.address(), r.address()) }
    if (op === TON_JETTON_BURN) { r.uint(64); r.coins(); return named(r.address()) }
    return []
  } catch {
    return [undefined]
  }
}

function tonMessageDestinations(m: unknown): Array<string | undefined> {
  const o = obj(m)
  return [str(o.to), ...tonBodyRecipients(o)]
}

function tonDestinations(arg: unknown): Destinations {
  if (Array.isArray(arg)) return arg.length ? known(arg.flatMap(tonMessageDestinations)) : UNKNOWN
  // wallet-ton builds from `to` and nothing else (round 3, review).
  if (str(obj(arg).to) === undefined) return UNKNOWN // a Cell (prebuilt external) is not read here
  return known(tonMessageDestinations(arg))
}

/** One EVM call: the contract it calls, and the recipient or spender a standard token call names in its calldata (round 3, M1). */
function evmCallDestinations(call: unknown): Array<string | undefined> {
  const c = obj(call)
  const data = hexData(c.data)
  const r = data !== undefined ? calldataRecipients(data) : null
  return [str(c.to), ...(r ? r.list.map((w) => `0x${w}`) : []), ...(r?.bad ? [undefined] : [])]
}

/** EVM: the transaction goes to `to` — no `to` is a contract deployment (round 3, H2) — and to whoever its calldata pays (M1). */
function evmDestinations(arg: unknown): Destinations {
  if (Array.isArray(arg)) return arg.length ? known(arg.flatMap(evmCallDestinations)) : UNKNOWN
  if (str(obj(arg).to) === undefined) return UNKNOWN
  return known(evmCallDestinations(arg))
}

function evmLikeDestinations(arg: unknown): Destinations {
  if (Array.isArray(arg)) return arg.length ? known(arg.map((c) => str(obj(c).to))) : UNKNOWN
  const a = obj(arg)
  const to = str(a.to) ?? str(a.recipient)
  return to !== undefined ? known([to]) : UNKNOWN
}

/** Destinations of a value-moving write (`kind: 'send'`) on `chain` (CAIP-2). */
export function sendDestinations(chain: string, arg: unknown): Destinations {
  switch (chain.split(':')[0]) {
    case 'tron': return tronDestinations(arg)
    case 'near': return nearDestinations(arg)
    case 'ton': return tonDestinations(arg)
    case 'solana': return solanaDestinations(arg)
    case 'eip155': return evmDestinations(arg)
    default: return evmLikeDestinations(arg)
  }
}
