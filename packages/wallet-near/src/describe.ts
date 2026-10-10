import { argsBytes, actionKey } from './borsh.js'
import { isImplicitAccountId, isValidAccountId } from './address.js'
import { IMPLICIT_ACCOUNT_MIN_DEPOSIT, MAX_GAS, TGAS, type NearAction, type NearFunctionCallAction, type NearTransaction, type NearTxDescription, type NearTxKind, type NearTxWarning } from './types.js'

export interface DescribeContext {
  /** The signing account; adds `self-transfer` and fills `from`. */
  signerId?: string
  /** Whether the receiver account exists; `describeTransactionOnline` fills it from the node. */
  recipientExists?: boolean
}

/** Actions that change the account itself, its keys, or deploy code. Refused unless `allowDangerousActions`. */
export const DANGEROUS_ACTIONS = new Set(['createAccount', 'deployContract', 'stake', 'addKey', 'deleteKey', 'deleteAccount', 'signedDelegate', 'deployGlobalContract', 'useGlobalContract'])

const KIND_OF_DANGEROUS: Record<string, NearTxKind> = {
  createAccount: 'create-account', deployContract: 'deploy-contract', stake: 'stake', addKey: 'add-key', deleteKey: 'delete-key',
  deleteAccount: 'delete-account', signedDelegate: 'delegate', deployGlobalContract: 'global-contract', useGlobalContract: 'global-contract',
}

/** Methods a NEP-141 / NEP-145 token contract exposes that we recognise. */
const FT_METHODS = new Set(['ft_transfer', 'ft_transfer_call', 'storage_deposit', 'storage_withdraw', 'storage_unregister'])

function parseArgs(a: NearFunctionCallAction['functionCall']): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(argsBytes(a.args))) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch { return undefined }
}

/** What a transaction does, decoded offline. Never throws on odd input — it warns. */
export function describeTransaction(tx: NearTransaction, ctx: DescribeContext = {}): NearTxDescription {
  const warnings: NearTxWarning[] = []
  const actions = tx.actions ?? []
  const from = tx.signerId ?? ctx.signerId
  let deposit = 0n
  let gas = 0n
  const methods: string[] = []
  let kind: NearTxKind = 'batch'
  let to: string | undefined = tx.receiverId
  let amount: bigint | undefined
  let token: string | undefined
  let memo: string | undefined
  let contract: string | undefined
  let dangerous: NearTxKind | undefined

  if (!isValidAccountId(tx.receiverId)) warnings.push({ code: 'invalid-account', message: `"${tx.receiverId}" is not a valid NEAR account id.` })

  for (const a of actions) {
    let key: string
    try { key = actionKey(a) } catch { warnings.push({ code: 'dangerous-action', message: 'Unknown action.' }); continue }
    if (DANGEROUS_ACTIONS.has(key)) {
      dangerous ??= KIND_OF_DANGEROUS[key]
      warnings.push({ code: 'dangerous-action', message: `${key} changes the account, its keys or its code.` })
      if (key === 'addKey' && 'fullAccess' in (a as { addKey: { accessKey: { permission: object } } }).addKey.accessKey.permission) {
        warnings.push({ code: 'full-access-key', message: 'Adds a FULL ACCESS key: whoever holds it owns the account.' })
      }
      continue
    }
    if (key === 'transfer') {
      const d = (a as { transfer: { deposit: bigint } }).transfer.deposit
      deposit += d
      amount = (amount ?? 0n) + d
      continue
    }
    if (key === 'functionCall') {
      const f = (a as NearFunctionCallAction).functionCall
      const g = f.gas ?? 30n * TGAS
      gas += g
      deposit += f.deposit ?? 0n
      methods.push(f.methodName)
      contract = tx.receiverId
      if (f.methodName === 'ft_transfer' || f.methodName === 'ft_transfer_call') {
        const args = parseArgs(f)
        token = tx.receiverId
        to = typeof args?.receiver_id === 'string' ? args.receiver_id : undefined
        if (typeof args?.amount === 'string' && /^\d+$/.test(args.amount)) amount = BigInt(args.amount)
        if (typeof args?.memo === 'string') memo = args.memo
        if (to !== undefined && !isValidAccountId(to)) warnings.push({ code: 'invalid-account', message: `"${to}" is not a valid NEAR account id.` })
      }
    }
  }

  const callMethods = methods.filter((m) => m !== 'storage_deposit')
  if (dangerous) kind = dangerous
  else if (actions.length === 1 && methods.length === 0 && amount !== undefined) kind = 'near-transfer'
  else if (methods.length > 0 && callMethods.every((m) => m === 'ft_transfer' || m === 'ft_transfer_call') && callMethods.length === 1 && actions.length === methods.length) kind = 'ft-transfer'
  else if (methods.length === 1 && methods[0] === 'storage_deposit' && actions.length === 1) kind = 'ft-storage-deposit'
  else if (methods.length === 1 && actions.length === 1) kind = 'function-call'
  else kind = 'batch'

  if (kind === 'function-call' && !FT_METHODS.has(methods[0]!)) warnings.push({ code: 'unknown-method', message: `Calls ${tx.receiverId}.${methods[0]} — not a token method we recognise.` })
  if ((kind === 'near-transfer' || kind === 'ft-transfer') && amount === 0n) warnings.push({ code: 'zero-amount', message: 'Transfers nothing.' })
  if (gas > MAX_GAS) warnings.push({ code: 'high-gas', message: `Prepaid gas ${gas} exceeds the 300 Tgas transaction limit.` })
  if (from !== undefined && to !== undefined && from === to && (kind === 'near-transfer' || kind === 'ft-transfer')) warnings.push({ code: 'self-transfer', message: 'Sends to the signing account itself.' })
  if (kind === 'near-transfer' && ctx.recipientExists === false) {
    if (isImplicitAccountId(tx.receiverId)) {
      warnings.push({ code: 'implicit-new-account', message: `Creates the implicit account ${tx.receiverId}${(amount ?? 0n) < IMPLICIT_ACCOUNT_MIN_DEPOSIT ? ' — below the 0.002 NEAR it needs to exist' : ''}.` })
    } else {
      warnings.push({ code: 'invalid-account', message: `Account ${tx.receiverId} does not exist; a transfer to it would fail.` })
    }
  }

  return {
    kind, warnings, deposit, gas, actionCount: actions.length,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(memo !== undefined ? { memo } : {}),
    ...(contract !== undefined ? { contract } : {}),
    ...(methods.length ? { methods } : {}),
  }
}

export const isDangerous = (a: NearAction): boolean => { try { return DANGEROUS_ACTIONS.has(actionKey(a)) } catch { return true } }
