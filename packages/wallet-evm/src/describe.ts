/**
 * "What am I signing?" — pure, offline descriptions of a transaction or an
 * EIP-712 payload, for a confirmation screen or a policy layer. Nothing here
 * touches the network; the account runs the same checks as hard refusals
 * (see ChainMismatchError / UnsafeTransactionError) before it signs.
 */
import { decodeFunctionData, getAddress, maxUint256, zeroAddress, type Hex } from 'viem'
import { ERC20_ABI } from './erc20.js'
import { PERMIT2_ADDRESS, permit2KnownSpender } from './permit2-spenders.js'
import { canonicalData, inferPrimaryType } from './read-only-account.js'
import type { EvmTransaction, TypedDataInput } from './types.js'

/** What an EVM transaction does, read from its fields and calldata. */
export type TxKind =
  | 'native-transfer'
  | 'erc20-transfer'
  | 'erc20-transferFrom'
  | 'erc20-approve'
  | 'contract-call'
  | 'contract-deploy'
  | 'eip7702-delegation'

/**
 * Problems {@link describeTransaction} flags: an unlimited approval, value or calldata to the zero
 * address, a chain id that is not the account's, or legacy fee fields.
 */
export type TxWarningCode = 'approve-unlimited' | 'to-zero-address' | 'chain-mismatch' | 'legacy-fee-fields'
/**
 * Problems {@link describeTypedData} flags: another chain in the domain, an expired deadline, an
 * unlimited permit, or a permit owner that is not the account.
 */
export type TypedDataWarningCode =
  | 'chain-mismatch' | 'deadline-passed' | 'approve-unlimited' | 'owner-mismatch'
  /**
   * A permit or Permit2 grant to a spender the caller did not list in `knownSpenders`. A Permit2 grant to
   * a Uniswap Universal Router of the signed chain (`UNISWAP_UNIVERSAL_ROUTERS`) does not get it either.
   */
  | 'spender-unknown'
  /** A Seaport order pays part (or all) of its consideration to an address other than the signer. */
  | 'consideration-foreign'
  /** A Safe transaction with operation 1 (DELEGATECALL), or one whose operation cannot be read. */
  | 'safe-delegatecall'

/** One flagged problem, with a sentence a wallet can show. */
export interface Warning<Code extends string> {
  /** Machine-readable code. */
  code: Code
  /** Sentence to show the user. */
  message: string
}
/** A warning about a transaction. */
export type TxWarning = Warning<TxWarningCode>
/** A warning about typed data. */
export type TypedDataWarning = Warning<TypedDataWarningCode>

/**
 * An EVM transaction decoded for a confirmation screen, without any network call. For simulated
 * balance changes use `tx-preview-evm`.
 */
export interface TxDescription {
  /** What it does. */
  kind: TxKind
  /** Checksummed `to`, or undefined for a deploy. */
  to: string | undefined
  /** Native value in wei. */
  value: bigint
  /** 4-byte selector of the calldata, when there is calldata. */
  selector: Hex | undefined
  /** ERC-20 contract for the erc20-* kinds. */
  token?: string
  /** Token recipient for the erc20 transfer kinds. */
  recipient?: string
  /** Token amount for erc20-transfer / transferFrom / approve. */
  amount?: bigint
  /** Spender for erc20-approve. */
  spender?: string
  /** Source account for erc20-transferFrom. */
  owner?: string
  /** Delegation targets for an EIP-7702 tx. */
  delegations?: Array<{ chainId: number; address: string }>
  /**
   * For an EIP-7702 tx (kind 'eip7702-delegation'): what its call does, decoded like any other
   * transaction — the token / spender / amount fields and the warnings are the call's.
   */
  call?: TxKind
  /** Chain id named by the transaction, if any. */
  chainId: number | undefined
  /** Problems to show before signing. */
  warnings: TxWarning[]
}

/**
 * What typed data is: an EIP-2612 permit, a Uniswap Permit2 message, a Safe transaction, or
 * anything else.
 */
export type TypedDataKind = 'permit' | 'permit2' | 'seaport' | 'safe-tx' | 'generic'

/** One Permit2 grant entry: the token and amount, plus the allowance's expiry and nonce (AllowanceTransfer). */
export interface Permit2Entry {
  token: string
  /** Base units; an amount that is there but cannot be read is the worst case (uint256 max). */
  amount: bigint
  /** AllowanceTransfer `expiration` (unix seconds, 0 = the block it is used in). */
  expiration?: bigint
  /** AllowanceTransfer per-token `nonce`. */
  nonce?: bigint
}

/** What a Permit2 signature grants, read through its declared schema. */
export interface Permit2Grant {
  /** Who may pull the tokens, as written in the message ('' when it cannot be read). */
  spender: string
  /** The caller's label for a spender listed in `knownSpenders`, or "Uniswap Universal Router" for a pinned router of the signed chain. */
  spenderLabel?: string
  /** Every token granted (empty when the schema is not Permit2's — then it is treated as unlimited). */
  entries: Permit2Entry[]
  /** `sigDeadline` (AllowanceTransfer) or `deadline` (SignatureTransfer), unix seconds. */
  deadline?: bigint
  /** SignatureTransfer `nonce`. */
  nonce?: bigint
  /** True for SignatureTransfer (one pull of these amounts), false for AllowanceTransfer (a standing allowance). */
  transfer: boolean
  /** The witness struct's type name for the *Witness* variants (e.g. a UniswapX order). */
  witness?: string
}

/** One Seaport offer or consideration item. */
export interface SeaportItem {
  /** Seaport ItemType (0 native, 1 ERC-20, 2 ERC-721, 3 ERC-1155, 4/5 criteria-based ERC-721/1155). */
  itemType: number
  kind: 'native' | 'erc20' | 'erc721' | 'erc1155' | 'erc721-criteria' | 'erc1155-criteria' | 'unknown'
  token: string
  /** Token id (or criteria root for the criteria kinds). */
  identifier: bigint
  startAmount: bigint
  endAmount: bigint
}

/** A Seaport order (or every order of a bulk order) decoded: what the offerer gives and who receives what. */
export interface SeaportOrder {
  /** How many orders were read (a BulkOrder signs a tree of them). */
  orders: number
  offerer: string
  /** What the offerer gives. */
  offer: SeaportItem[]
  /** What has to be paid for it, and to whom. */
  consideration: Array<SeaportItem & { recipient: string }>
  startTime?: bigint
  endTime?: bigint
  zone?: string
}

/** A Safe transaction decoded: the call the Safe would make once its owners have signed. */
export interface SafeTxDescription {
  to: string
  value: bigint
  data: string
  /** 0 = CALL, 1 = DELEGATECALL; an operation that cannot be read is reported as 1. */
  operation: number
  safeTxGas: bigint
  baseGas: bigint
  gasPrice: bigint
  gasToken: string
  refundReceiver: string
  nonce: bigint
  /** The inner call, decoded like a transaction from the Safe (ERC-20 transfer / approve / …), when it can be read. */
  call?: Pick<TxDescription, 'kind' | 'token' | 'recipient' | 'amount' | 'spender'>
}

/** EIP-712 typed data decoded for a confirmation screen. */
export interface TypedDataDescription {
  /** What it is. */
  kind: TypedDataKind
  /** The primary type, given or inferred. */
  primaryType: string
  /** The domain fields a user should see. */
  domain: {
    name?: string
    version?: string
    chainId?: number
    verifyingContract?: string
  }
  /** EIP-2612 permit fields (kind 'permit'). */
  permit?: { owner: string; spender: string; value: bigint; nonce: bigint; deadline: bigint; /** The caller's label for a spender listed in `knownSpenders`. */ spenderLabel?: string }
  /** Permit2 grant (kind 'permit2'). */
  permit2?: Permit2Grant
  /** Seaport order (kind 'seaport'). */
  seaport?: SeaportOrder
  /** Safe transaction (kind 'safe-tx'). */
  safeTx?: SafeTxDescription
  /** Problems to show before signing. */
  warnings: TypedDataWarning[]
}

/**
 * Unlimited-approval heuristic: type(uint128).max or more, the SDK-wide threshold (core's
 * UNLIMITED_ALLOWANCE). Every "infinite approval" sentinel in use — uint256 (maxUint256), uint160
 * (Permit2), uint128 max, 2^255 — reaches it; 2^255 − 1 used to slip under the old top-bit check.
 */
export function isUnlimitedAmount(amount: bigint): boolean {
  return amount >= (maxUint256 >> 128n)
}

function toBig(v: bigint | number | string | undefined): bigint {
  return v === undefined ? 0n : BigInt(v)
}

function tryDecodeErc20(data: Hex) {
  try {
    return decodeFunctionData({ abi: ERC20_ABI, data })
  } catch {
    return undefined
  }
}

/**
 * Decode a transaction for a confirmation screen: kind, recipient or spender, amounts and warnings.
 * Offline and synchronous. Pass the account's `chainId` to get a chain-mismatch warning.
 */
export function describeTransaction(tx: EvmTransaction, ctx: { chainId?: number } = {}): TxDescription {
  const warnings: TxWarning[] = []
  const to = tx.to !== undefined ? getAddress(tx.to) : undefined
  const value = toBig(tx.value)
  const data = canonicalData(tx.data) ?? '0x'
  const hasData = data.length > 2
  const selector = hasData && data.length >= 10 ? (data.slice(0, 10) as Hex) : undefined
  // An unrepresentable chainId (a bigint past 2^53) is NaN, so the chain-mismatch warning still fires.
  const chainId = tx.chainId !== undefined ? (num(tx.chainId) ?? Number.NaN) : undefined

  if (chainId !== undefined && ctx.chainId !== undefined && chainId !== ctx.chainId) {
    warnings.push({ code: 'chain-mismatch', message: `Transaction targets chain ${chainId}, account is on chain ${ctx.chainId}.` })
  }
  if (to === zeroAddress && (value > 0n || hasData)) {
    warnings.push({ code: 'to-zero-address', message: 'Recipient is the zero address — funds sent there are destroyed.' })
  }
  if (tx.gasPrice !== undefined && tx.maxFeePerGas === undefined) {
    warnings.push({ code: 'legacy-fee-fields', message: 'Legacy gasPrice transaction; EIP-1559 fee fields are preferred.' })
  }

  const base = { to, value, selector, chainId, warnings }

  if (tx.type === 4 || (tx.authorizationList && tx.authorizationList.length > 0)) {
    // The delegation AND the call it carries: an approve riding in a type 4 is still an approve.
    const { type: _type, authorizationList, ...call } = tx
    const inner = describeTransaction(call, ctx)
    return {
      ...inner,
      kind: 'eip7702-delegation',
      call: inner.kind,
      delegations: (authorizationList ?? []).map((a) => ({ chainId: Number(a.chainId), address: getAddress(a.address) })),
    }
  }
  if (to === undefined) return { ...base, kind: 'contract-deploy' }
  if (!hasData) return { ...base, kind: 'native-transfer', recipient: to }

  const decoded = tryDecodeErc20(data)
  if (decoded?.functionName === 'transfer') {
    const [recipient, amount] = decoded.args as readonly [string, bigint]
    return { ...base, kind: 'erc20-transfer', token: to, recipient: getAddress(recipient), amount }
  }
  if (decoded?.functionName === 'transferFrom') {
    const [owner, recipient, amount] = decoded.args as readonly [string, string, bigint]
    return { ...base, kind: 'erc20-transferFrom', token: to, owner: getAddress(owner), recipient: getAddress(recipient), amount }
  }
  if (decoded?.functionName === 'approve') {
    const [spender, amount] = decoded.args as readonly [string, bigint]
    if (isUnlimitedAmount(amount)) {
      warnings.push({ code: 'approve-unlimited', message: `Unlimited approval: ${getAddress(spender)} may spend any amount of ${to}.` })
    }
    return { ...base, kind: 'erc20-approve', token: to, spender: getAddress(spender), amount }
  }
  return { ...base, kind: 'contract-call' }
}

const PERMIT2_TYPES = new Set(['PermitSingle', 'PermitBatch', 'PermitTransferFrom', 'PermitBatchTransferFrom', 'PermitWitnessTransferFrom', 'PermitBatchWitnessTransferFrom'])

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v.toString()) : undefined
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) return num(BigInt(v)) // dApps send the domain chainId in hex too
  return undefined
}
/** A uint as the signer reads it: viem passes strings and numbers through BigInt() (scan 2026-10-27 F11). */
function big(v: unknown): bigint | undefined {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : undefined
  if (typeof v === 'string' && v.length <= 300) { try { return BigInt(v) } catch { return undefined } }
  return undefined
}
/** An amount that is there but cannot be read is shown as the worst case: unlimited. */
const amountOrMax = (v: unknown): bigint => (v === undefined ? 0n : big(v) ?? maxUint256)

/** Permit2's primary types → the field that carries the grant, its struct and whether it is a list. */
const PERMIT2_GRANT: Readonly<Record<string, { name: 'details' | 'permitted'; struct: 'PermitDetails' | 'TokenPermissions'; list: boolean }>> = {
  PermitSingle: { name: 'details', struct: 'PermitDetails', list: false },
  PermitBatch: { name: 'details', struct: 'PermitDetails', list: true },
  PermitTransferFrom: { name: 'permitted', struct: 'TokenPermissions', list: false },
  PermitWitnessTransferFrom: { name: 'permitted', struct: 'TokenPermissions', list: false },
  PermitBatchTransferFrom: { name: 'permitted', struct: 'TokenPermissions', list: true },
  PermitBatchWitnessTransferFrom: { name: 'permitted', struct: 'TokenPermissions', list: true },
}
const PERMIT2_AMOUNT_TYPE = { PermitDetails: 'uint160', TokenPermissions: 'uint256' } as const

/**
 * The entries a Permit2 signature grants, read through the schema that gets signed (scan 2026-10-30 F4): the
 * primary struct declares the grant field Permit2 uses for that primary type with its struct (one or a list),
 * and that struct declares `token: address` and `amount` with Permit2's type. Null for any other schema.
 */
function permit2Entries(types: TypedDataInput['types'], primaryType: string, m: Record<string, unknown>): Array<Record<string, unknown>> | null {
  const grant = Object.prototype.hasOwnProperty.call(PERMIT2_GRANT, primaryType) ? PERMIT2_GRANT[primaryType] : undefined
  if (!grant) return null
  const declared = new Map((types[primaryType] ?? []).map((f) => [f.name, f.type] as const))
  if (declared.get(grant.name) !== (grant.list ? `${grant.struct}[]` : grant.struct)) return null
  if (declared.has(grant.name === 'details' ? 'permitted' : 'details')) return null
  const struct = new Map((types[grant.struct] ?? []).map((f) => [f.name, f.type] as const))
  if (struct.get('token') !== 'address' || struct.get('amount') !== PERMIT2_AMOUNT_TYPE[grant.struct]) return null
  const value = m[grant.name]
  if (grant.list !== Array.isArray(value) || typeof value !== 'object' || value === null) return null
  // AllowanceTransfer's PermitDetails also carries `expiration` and `nonce`: read only when declared.
  const extra = (['expiration', 'nonce'] as const).filter((f) => struct.has(f))
  return (grant.list ? (value as unknown[]) : [value]).map((e) => {
    if (typeof e !== 'object' || e === null) return {}
    const o = e as Record<string, unknown>
    const out: Record<string, unknown> = { token: o.token, amount: o.amount }
    for (const f of extra) out[f] = o[f]
    return out
  })
}

/** The caller's label for `address` in `known` (case-insensitive), if any. */
function labelOf(known: Readonly<Record<string, string>> | undefined, address: string): string | undefined {
  if (!known || !address) return undefined
  const a = address.toLowerCase()
  for (const [k, v] of Object.entries(known)) if (k.toLowerCase() === a) return v
  return undefined
}

/** The declared type of `field` in struct `struct`, if any. */
function declaredType(types: TypedDataInput['types'], struct: string, field: string): string | undefined {
  return (types[struct] ?? []).find((f) => f.name === field)?.type
}

const SEAPORT_KIND: readonly SeaportItem['kind'][] = ['native', 'erc20', 'erc721', 'erc1155', 'erc721-criteria', 'erc1155-criteria']

function seaportItem(v: unknown): SeaportItem {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const itemType = num(o.itemType) ?? -1
  return {
    itemType,
    kind: SEAPORT_KIND[itemType] ?? 'unknown',
    token: str(o.token) ?? '',
    identifier: big(o.identifierOrCriteria) ?? 0n,
    startAmount: amountOrMax(o.startAmount),
    endAmount: amountOrMax(o.endAmount),
  }
}

/** Every OrderComponents of a BulkOrder `tree` (nested arrays), depth-limited. */
function flattenOrders(v: unknown, depth = 0, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (depth > 24 || out.length > 1024) return out
  if (Array.isArray(v)) for (const x of v) flattenOrders(x, depth + 1, out)
  else if (typeof v === 'object' && v !== null) out.push(v as Record<string, unknown>)
  return out
}

/** The Seaport orders the message signs: an `OrderComponents`, or the tree of a `BulkOrder`. Null for any other schema. */
function seaportOrders(types: TypedDataInput['types'], primaryType: string, m: Record<string, unknown>): Array<Record<string, unknown>> | null {
  const isOrder = ['offerer', 'offer', 'consideration'].every((f) => declaredType(types, 'OrderComponents', f) !== undefined)
  if (!isOrder) return null
  if (primaryType === 'OrderComponents') return [m]
  if (primaryType === 'BulkOrder' && /^OrderComponents(\[\d*\])+$/.test(declaredType(types, 'BulkOrder', 'tree') ?? '')) return flattenOrders(m.tree)
  return null
}

/**
 * Decode EIP-712 typed data for a confirmation screen. Pass the account's `chainId` and address to
 * get chain and owner warnings, and `knownSpenders` (address → label) for the contracts a permit or
 * Permit2 grant may go to without a `spender-unknown` warning. One set is built in, for Permit2 grants
 * only: the Uniswap Universal Router deployments of the chain in the signed domain
 * (`UNISWAP_UNIVERSAL_ROUTERS`); the same address on another chain, or in a token permit, is unknown.
 *
 * Asset-granting forms come back as grants: EIP-2612 / DAI permits (`permit`), every Permit2 primary
 * type (`permit2`: spender, tokens, amounts, expirations, deadline), Seaport orders (`seaport`: offer
 * and consideration with recipients) and Safe transactions (`safeTx`: to, value, data, operation).
 * Anything else is `generic`: the description cannot say what it authorises, so a wallet should not
 * present it as harmless.
 */
export function describeTypedData(typed: TypedDataInput, ctx: { chainId?: number; account?: string; knownSpenders?: Readonly<Record<string, string>> } = {}): TypedDataDescription {
  const warnings: TypedDataWarning[] = []
  const primaryType = typed.primaryType ?? inferPrimaryType(typed.types)
  const d = typed.domain
  const domain: TypedDataDescription['domain'] = {}
  const name = str(d.name); if (name !== undefined) domain.name = name
  const version = str(d.version); if (version !== undefined) domain.version = version
  const chainId = num(d.chainId); if (chainId !== undefined) domain.chainId = chainId
  const verifyingContract = str(d.verifyingContract); if (verifyingContract !== undefined) domain.verifyingContract = verifyingContract
  if (domain.chainId !== undefined && ctx.chainId !== undefined && domain.chainId !== ctx.chainId) {
    warnings.push({ code: 'chain-mismatch', message: `Typed data is for chain ${domain.chainId}, account is on chain ${ctx.chainId}.` })
  }
  const now = BigInt(Math.floor(Date.now() / 1000))
  const spenderCheck = (spender: string, what: string, builtIn?: string): string | undefined => {
    const label = labelOf(ctx.knownSpenders, spender) ?? builtIn
    if (label === undefined) {
      warnings.push({ code: 'spender-unknown', message: spender ? `${what} to ${spender}, which is not a known contract: whoever controls it can take the tokens. Only sign if you trust it.` : `${what} whose spender cannot be read: treat it as a grant to anyone.` })
    }
    return label
  }

  const m = typed.message
  const fields = new Set((typed.types[primaryType] ?? []).map((f) => f.name))
  const isPermit = primaryType === 'Permit' && ['owner', 'spender', 'value', 'nonce', 'deadline'].every((f) => fields.has(f))
  // DAI-style permit: all-or-nothing `allowed` instead of a value, `holder` / `expiry` (0 = never).
  const isDaiPermit = primaryType === 'Permit' && ['holder', 'spender', 'nonce', 'expiry', 'allowed'].every((f) => fields.has(f))

  if (isPermit) {
    const owner = str(m.owner) ?? ''
    const spender = str(m.spender) ?? ''
    const value = amountOrMax(m.value)
    const nonce = big(m.nonce) ?? 0n
    const deadline = big(m.deadline) ?? 0n
    if (isUnlimitedAmount(value)) warnings.push({ code: 'approve-unlimited', message: `Unlimited permit: ${spender} may spend any amount.` })
    if (deadline < now) warnings.push({ code: 'deadline-passed', message: 'Permit deadline is already in the past.' })
    if (ctx.account && owner.toLowerCase() !== ctx.account.toLowerCase()) {
      warnings.push({ code: 'owner-mismatch', message: `Permit owner ${owner} is not this account.` })
    }
    const spenderLabel = spenderCheck(spender, 'Token permit')
    return { kind: 'permit', primaryType, domain, permit: { owner, spender, value, nonce, deadline, ...(spenderLabel !== undefined ? { spenderLabel } : {}) }, warnings }
  }
  if (isDaiPermit) {
    const owner = str(m.holder) ?? ''
    const spender = str(m.spender) ?? ''
    const allowed = m.allowed === true || m.allowed === 'true'
    const value = allowed ? maxUint256 : 0n
    const nonce = big(m.nonce) ?? 0n
    const deadline = big(m.expiry) ?? 0n
    if (allowed) warnings.push({ code: 'approve-unlimited', message: `Unlimited permit: ${spender} may spend any amount.` })
    if (deadline !== 0n && deadline < now) warnings.push({ code: 'deadline-passed', message: 'Permit deadline is already in the past.' })
    if (ctx.account && owner.toLowerCase() !== ctx.account.toLowerCase()) {
      warnings.push({ code: 'owner-mismatch', message: `Permit holder ${owner} is not this account.` })
    }
    const spenderLabel = allowed ? spenderCheck(spender, 'Token permit') : labelOf(ctx.knownSpenders, spender)
    return { kind: 'permit', primaryType, domain, permit: { owner, spender, value, nonce, deadline, ...(spenderLabel !== undefined ? { spenderLabel } : {}) }, warnings }
  }
  if (PERMIT2_TYPES.has(primaryType)) {
    // AllowanceTransfer carries `details`, SignatureTransfer `permitted` (one or a list) — read only through
    // the declared schema: an undeclared `details` next to a signed `permitted` is not signed (scan 2026-10-30 F4).
    const list = permit2Entries(typed.types, primaryType, m)
    // A schema that is not Permit2's: nothing tells what is granted, so the worst case.
    if (list === null) warnings.push({ code: 'approve-unlimited', message: 'Permit2 permit whose amounts cannot be read: treat it as unlimited.' })
    // AllowanceTransfer amounts are uint160: its "unlimited" is that type's max (SignatureTransfer's
    // uint256 max is above it too).
    const entries: Permit2Entry[] = (list ?? []).map((item) => {
      const e: Permit2Entry = { token: str(item.token) ?? '', amount: amountOrMax(item.amount) }
      const expiration = big(item.expiration); if (expiration !== undefined) e.expiration = expiration
      const nonce = big(item.nonce); if (nonce !== undefined) e.nonce = nonce
      return e
    })
    if (entries.some((e) => e.amount >= 2n ** 160n - 1n)) warnings.push({ code: 'approve-unlimited', message: 'Unlimited Permit2 allowance.' })
    const deadline = big(fields.has('sigDeadline') ? m.sigDeadline : undefined) ?? big(fields.has('deadline') ? m.deadline : undefined)
    if (deadline !== undefined && deadline < now) warnings.push({ code: 'deadline-passed', message: 'Permit2 deadline is already in the past.' })
    const transfer = PERMIT2_GRANT[primaryType]!.name === 'permitted'
    const spender = declaredType(typed.types, primaryType, 'spender') === 'address' ? str(m.spender) ?? '' : ''
    // The built-in list answers only for a grant Permit2 would honour: its own address as the verifying
    // contract and a router of the chain the signature is for (the signed domain, not the account's chain).
    const router = domain.verifyingContract?.toLowerCase() === PERMIT2_ADDRESS.toLowerCase() ? permit2KnownSpender(domain.chainId, spender) : undefined
    const spenderLabel = spenderCheck(spender, transfer ? 'Permit2 transfer' : 'Permit2 allowance', router)
    const grant: Permit2Grant = { spender, entries, transfer }
    if (spenderLabel !== undefined) grant.spenderLabel = spenderLabel
    if (deadline !== undefined) grant.deadline = deadline
    const nonce = big(fields.has('nonce') ? m.nonce : undefined); if (nonce !== undefined) grant.nonce = nonce
    const witness = declaredType(typed.types, primaryType, 'witness'); if (witness !== undefined) grant.witness = witness
    return { kind: 'permit2', primaryType, domain, permit2: grant, warnings }
  }
  const orders = seaportOrders(typed.types, primaryType, m)
  if (orders !== null) {
    const order: SeaportOrder = { orders: orders.length, offerer: str(orders[0]?.offerer) ?? '', offer: [], consideration: [] }
    for (const o of orders) {
      const offerer = str(o.offerer) ?? ''
      if (offerer.toLowerCase() !== order.offerer.toLowerCase()) order.offerer = order.offerer || offerer
      for (const it of Array.isArray(o.offer) ? o.offer : []) order.offer.push(seaportItem(it))
      for (const it of Array.isArray(o.consideration) ? o.consideration : []) {
        const recipient = typeof it === 'object' && it !== null ? str((it as Record<string, unknown>).recipient) ?? '' : ''
        order.consideration.push({ ...seaportItem(it), recipient })
      }
      if (ctx.account && offerer.toLowerCase() !== ctx.account.toLowerCase() && !warnings.some((w) => w.code === 'owner-mismatch')) {
        warnings.push({ code: 'owner-mismatch', message: `Order offerer ${offerer || '(unreadable)'} is not this account.` })
      }
    }
    const first = orders[0] ?? {}
    const startTime = big(first.startTime); if (startTime !== undefined) order.startTime = startTime
    const endTime = big(first.endTime); if (endTime !== undefined) order.endTime = endTime
    const zone = str(first.zone); if (zone !== undefined) order.zone = zone
    // The signer is whoever offers: the account when given, else the order's offerer.
    const me = new Set([order.offerer.toLowerCase(), ...(ctx.account ? [ctx.account.toLowerCase()] : [])].filter(Boolean))
    const foreign = [...new Set(order.consideration.filter((c) => !me.has(c.recipient.toLowerCase())).map((c) => c.recipient || '(unreadable)'))]
    const back = order.consideration.some((c) => me.has(c.recipient.toLowerCase()))
    if (order.offer.length > 0 && !back) {
      warnings.push({ code: 'consideration-foreign', message: `You give ${order.offer.length} item${order.offer.length === 1 ? '' : 's'} and receive nothing back: ${foreign.length ? `everything paid goes to ${foreign.join(', ')}` : 'the order asks for no payment'}.` })
    } else if (foreign.length > 0) {
      warnings.push({ code: 'consideration-foreign', message: `Part of the payment goes to ${foreign.join(', ')}, not to you (marketplace fees or royalties?). Check every recipient.` })
    }
    return { kind: 'seaport', primaryType, domain, seaport: order, warnings }
  }
  if (primaryType === 'SafeTx') {
    const declared = (f: string) => fields.has(f)
    const operation = declared('operation') ? num(m.operation) : undefined
    const safeTx: SafeTxDescription = {
      to: str(m.to) ?? '',
      value: amountOrMax(m.value),
      data: typeof m.data === 'string' ? m.data : '0x',
      // Anything but a readable 0 / 1 is the worst case.
      operation: operation === 0 ? 0 : 1,
      safeTxGas: big(m.safeTxGas) ?? 0n,
      baseGas: big(m.baseGas) ?? 0n,
      gasPrice: big(m.gasPrice) ?? 0n,
      gasToken: str(m.gasToken) ?? '',
      refundReceiver: str(m.refundReceiver) ?? '',
      nonce: big(m.nonce) ?? 0n,
    }
    if (operation !== 0) {
      warnings.push({ code: 'safe-delegatecall', message: operation === 1
        ? `DELEGATECALL: the Safe runs the code at ${safeTx.to} as itself — that code can move everything the Safe holds or change its owners. Only sign if you know exactly what it does.`
        : 'The Safe operation cannot be read: treat it as a DELEGATECALL, which can move everything the Safe holds.' })
    }
    try {
      const inner = describeTransaction({ to: safeTx.to as Hex, value: safeTx.value, data: safeTx.data as Hex })
      const call: SafeTxDescription['call'] = { kind: inner.kind }
      if (inner.token !== undefined) call.token = inner.token
      if (inner.recipient !== undefined) call.recipient = inner.recipient
      if (inner.amount !== undefined) call.amount = inner.amount
      if (inner.spender !== undefined) call.spender = inner.spender
      safeTx.call = call
      for (const w of inner.warnings) if (w.code === 'approve-unlimited') warnings.push({ code: 'approve-unlimited', message: w.message })
    } catch { /* not a readable call: to / data are shown raw */ }
    return { kind: 'safe-tx', primaryType, domain, safeTx, warnings }
  }
  return { kind: 'generic', primaryType, domain, warnings }
}
