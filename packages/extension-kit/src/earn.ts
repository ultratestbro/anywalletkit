/**
 * Earn plan review — the Earn modules' counterpart of the swap sheet. A module
 * that exposes its plan (Aave / Morpho `planSupply` & co: ERC-20 approvals
 * first, then the call) gets ONE sheet for the whole plan; on approval exactly
 * those calls are pre-approved in the {@link ReviewGate} so the module's own
 * `supply()` / `withdraw()` / … passes through the reviewed account without a
 * second window. Modules without a plan API (Mellow, Lido, SSV, Jito) are
 * reviewed per transaction by the reviewed account itself — still every send.
 */
import { ApprovalQueue } from './approvals.js'
import { ReviewGate, evmCallMatcher, type GateMatcher } from './gate.js'
import type { EvmNetwork } from './networks.js'

export interface EarnTx {
  to: string
  data?: string | undefined
  /** Base units, decimal string. */
  value: string
}

export interface EarnPlan {
  approvals: EarnTx[]
  tx: EarnTx
}

export interface EarnReviewMeta {
  origin: string
  /** The account that sends the plan: the gate passes its calls for this account only. */
  account: string
  /** 'Aave v3', 'Morpho', … */
  module: string
  /** 'Supply', 'Withdraw', 'Borrow', 'Repay', 'Stake', … */
  action: string
  network: EvmNetwork
  /** Human lines the sheet shows (asset, amount, APY, market/vault, health factor…). */
  facts: { k: string; v: string }[]
  /** What the module says about the plan (its own refusals never reach here — they throw before). */
  checks?: { status: 'ok' | 'warn' | 'unknown'; label: string }[]
  /** tx-preview-evm result for approvals + call, attached by the wallet (JSON-safe) or null. */
  preview?: unknown
}

export interface EarnApproval {
  module: string
  action: string
  network: EvmNetwork
  facts: { k: string; v: string }[]
  approvals: EarnTx[]
  tx: EarnTx
  checks: { status: 'ok' | 'warn' | 'unknown'; label: string }[]
  preview: unknown
}

const APPROVE_SELECTOR = '0x095ea7b3'

export function earnPlanMatchers(network: EvmNetwork, plan: EarnPlan): GateMatcher[] {
  return [...plan.approvals, plan.tx].map((t) => evmCallMatcher({ caip2: network.caip2, to: t.to, data: t.data, value: BigInt(t.value) }))
}

export function earnApprovalPayload(plan: EarnPlan, meta: EarnReviewMeta): EarnApproval {
  const checks = [{ status: 'ok' as const, label: `Built by the ${meta.module} module` }, ...(meta.checks ?? [])]
  for (const a of plan.approvals) {
    if (!a.data?.startsWith(APPROVE_SELECTOR)) checks.push({ status: 'warn', label: `Unexpected pre-call to ${a.to.slice(0, 8)}…` })
  }
  if (plan.approvals.length > 1) checks.push({ status: 'ok', label: `${plan.approvals.length} approvals (reset to 0 first)` })
  return { module: meta.module, action: meta.action, network: meta.network, facts: meta.facts, approvals: plan.approvals, tx: plan.tx, checks, preview: meta.preview ?? null }
}

/** One sheet for the plan; approve → pre-approve exactly its calls; decline → ReviewDeclined, nothing sent. */
export async function reviewEarnPlan(approvals: ApprovalQueue, gate: ReviewGate, meta: EarnReviewMeta, plan: EarnPlan): Promise<void> {
  if (typeof meta.account !== 'string' || !meta.account) throw new TypeError('reviewEarnPlan needs meta.account: the gate passes the plan for that account only.')
  await approvals.request({ origin: meta.origin, chain: meta.network.caip2, kind: 'earn', payload: earnApprovalPayload(plan, meta) })
  gate.preApprove(earnPlanMatchers(meta.network, plan), 10 * 60_000, meta.account)
}
