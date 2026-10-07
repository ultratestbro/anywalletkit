/**
 * "What am I signing?" — pure, offline descriptions of a transaction or an
 * EIP-712 payload, for a confirmation screen or a policy layer. Nothing here
 * touches the network; the account runs the same checks as hard refusals
 * (see ChainMismatchError / UnsafeTransactionError) before it signs.
 */
import { decodeFunctionData, getAddress, maxUint256, zeroAddress, type Hex } from 'viem'
import { ERC20_ABI } from './erc20.js'
import { inferPrimaryType } from './read-only-account.js'
import type { EvmTransaction, TypedDataInput } from './types.js'

export type TxKind =
  | 'native-transfer'
  | 'erc20-transfer'
  | 'erc20-transferFrom'
  | 'erc20-approve'
  | 'contract-call'
  | 'contract-deploy'
  | 'eip7702-delegation'

export type TxWarningCode = 'approve-unlimited' | 'to-zero-address' | 'chain-mismatch' | 'legacy-fee-fields'
export type TypedDataWarningCode = 'chain-mismatch' | 'deadline-passed' | 'approve-unlimited' | 'owner-mismatch'

export interface Warning<Code extends string> {
  code: Code
  message: string
}
export type TxWarning = Warning<TxWarningCode>
export type TypedDataWarning = Warning<TypedDataWarningCode>

export interface TxDescription {
  kind: TxKind
  /** Checksummed `to`, or undefined for a deploy. */
  to: string | undefined
  /** Native value in wei. */
  value: bigint
  /** 4-byte selector of the calldata, when there is calldata. */
  selector: Hex | undefined
  /** ERC-20 contract for the erc20-* kinds. */
  token?: string
  recipient?: string
  /** Token amount for erc20-transfer / transferFrom / approve. */
  amount?: bigint
  spender?: string
  /** Source account for erc20-transferFrom. */
  owner?: string
  /** Delegation targets for an EIP-7702 tx. */
  delegations?: Array<{ chainId: number; address: string }>
  chainId: number | undefined
  warnings: TxWarning[]
}

export type TypedDataKind = 'permit' | 'permit2' | 'safe-tx' | 'generic'

export interface TypedDataDescription {
  kind: TypedDataKind
  primaryType: string
  domain: {
    name?: string
    version?: string
    chainId?: number
    verifyingContract?: string
  }
  /** EIP-2612 permit fields (kind 'permit'). */
  permit?: { owner: string; spender: string; value: bigint; nonce: bigint; deadline: bigint }
  warnings: TypedDataWarning[]
}

/** Unlimited-approval heuristic: the canonical max or anything in the top bit range. */
export function isUnlimitedAmount(amount: bigint): boolean {
  return amount === maxUint256 || amount >= 2n ** 255n
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

export function describeTransaction(tx: EvmTransaction, ctx: { chainId?: number } = {}): TxDescription {
  const warnings: TxWarning[] = []
  const to = tx.to !== undefined ? getAddress(tx.to) : undefined
  const value = toBig(tx.value)
  const data = (tx.data ?? '0x') as Hex
  const hasData = data.length > 2
  const selector = hasData && data.length >= 10 ? (data.slice(0, 10) as Hex) : undefined
  const chainId = tx.chainId !== undefined ? Number(tx.chainId) : undefined

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
    return {
      ...base,
      kind: 'eip7702-delegation',
      delegations: (tx.authorizationList ?? []).map((a) => ({ chainId: Number(a.chainId), address: getAddress(a.address) })),
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

const PERMIT2_TYPES = new Set(['PermitSingle', 'PermitBatch', 'PermitTransferFrom', 'PermitBatchTransferFrom', 'PermitWitnessTransferFrom'])

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return undefined
}
function big(v: unknown): bigint | undefined {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' || (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v))) return BigInt(v)
  return undefined
}

export function describeTypedData(typed: TypedDataInput, ctx: { chainId?: number; account?: string } = {}): TypedDataDescription {
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

  const m = typed.message
  const fields = new Set((typed.types[primaryType] ?? []).map((f) => f.name))
  const isPermit = primaryType === 'Permit' && ['owner', 'spender', 'value', 'nonce', 'deadline'].every((f) => fields.has(f))

  if (isPermit) {
    const owner = str(m.owner) ?? ''
    const spender = str(m.spender) ?? ''
    const value = big(m.value) ?? 0n
    const nonce = big(m.nonce) ?? 0n
    const deadline = big(m.deadline) ?? 0n
    if (isUnlimitedAmount(value)) warnings.push({ code: 'approve-unlimited', message: `Unlimited permit: ${spender} may spend any amount.` })
    if (deadline < BigInt(Math.floor(Date.now() / 1000))) warnings.push({ code: 'deadline-passed', message: 'Permit deadline is already in the past.' })
    if (ctx.account && owner.toLowerCase() !== ctx.account.toLowerCase()) {
      warnings.push({ code: 'owner-mismatch', message: `Permit owner ${owner} is not this account.` })
    }
    return { kind: 'permit', primaryType, domain, permit: { owner, spender, value, nonce, deadline }, warnings }
  }
  if (PERMIT2_TYPES.has(primaryType)) {
    const details = m.details as Record<string, unknown> | Array<Record<string, unknown>> | undefined
    const list = Array.isArray(details) ? details : details ? [details] : []
    // Permit2 amounts are uint160: its "unlimited" is that type's max.
    for (const item of list) {
      const amount = big(item.amount)
      if (amount !== undefined && amount >= 2n ** 160n - 1n) { warnings.push({ code: 'approve-unlimited', message: 'Unlimited Permit2 allowance.' }); break }
    }
    const deadline = big(m.sigDeadline) ?? big(m.deadline)
    if (deadline !== undefined && deadline < BigInt(Math.floor(Date.now() / 1000))) warnings.push({ code: 'deadline-passed', message: 'Permit2 deadline is already in the past.' })
    return { kind: 'permit2', primaryType, domain, warnings }
  }
  if (primaryType === 'SafeTx') return { kind: 'safe-tx', primaryType, domain, warnings }
  return { kind: 'generic', primaryType, domain, warnings }
}
