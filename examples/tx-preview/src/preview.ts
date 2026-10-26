// The "Transaction preview" guide on docs.anywallet.tech renders the #region blocks of this file.

// #region imports
import { previewEvmTx, type PreviewCall, type Rpc, type TxPreview } from '@anywalletkit/tx-preview-evm'
import type { Policies, WriteIntent } from '@anywalletkit/kit'
import type { Swap2ExecutionPlan } from '@anywalletkit/protocol-swap2-core'
import { encodeFunctionData, erc20Abi, formatUnits, type Hex } from 'viem'
// #endregion imports

// #region rpc

/** The module takes any JSON-RPC transport: (method, params) → result. */
export function jsonRpc(url: string): Rpc {
  return async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: string } }
    // Keep code and data: the module reads them to tell "no eth_simulateV1" from a revert.
    if (body.error) throw Object.assign(new Error(body.error.message), body.error)
    return body.result
  }
}
// #endregion rpc

// #region preview
const WETH_BASE = '0x4200000000000000000000000000000000000006'

export async function previewWrap(from: string, amount: bigint): Promise<TxPreview> {
  return previewEvmTx({
    chainId: 8453,
    from,
    rpc: jsonRpc('https://base-rpc.publicnode.com'),
    own: [from], // every address of this user: sends between them are not "foreign"
    known: { [WETH_BASE]: 'Wrapped Ether' }, // contracts you trust, with the name to show
    calls: [{ to: WETH_BASE, data: '0xd0e30db0', value: amount }], // WETH deposit()
    // Simulate as if the account held 1 ETH: preview a flow before it is funded.
    stateOverrides: { [from]: { balance: 10n ** 18n } },
  })
}
// #endregion preview

// #region verdict
export type Verdict = { level: 'ok' | 'warn' | 'danger'; lines: string[] }

/** Checks are codes, not prose: the wording (and the language) is yours. */
export function verdict(preview: TxPreview): Verdict {
  const lines: string[] = []
  let level: Verdict['level'] = 'ok'
  const raise = (to: Verdict['level']) => { if (to === 'danger' || level === 'ok') level = to }
  for (const check of preview.checks) {
    const d = check.detail ?? {}
    switch (check.code) {
      case 'simulation-reverted':
        raise('danger'); lines.push(`This transaction will fail: ${d.reason}`); break
      case 'simulation-unavailable':
        raise('warn'); lines.push('This network cannot simulate it. Check the details yourself.'); break
      case 'approval-unlimited':
        raise('danger'); lines.push(`${d.label ?? d.spender} could spend ALL of this token, now and later.`); break
      case 'approval-excess':
        raise('warn'); lines.push(`Approves ${d.amount}, but the swap needs only ${d.expected}.`); break
      case 'approval-unchecked':
        raise('warn'); lines.push(`Approves ${d.amount} to ${d.label ?? d.spender}; nothing says how much is needed.`); break
      case 'approval-unknown-spender':
        raise('warn'); lines.push(`Unknown spender ${d.spender}.`); break
      case 'contract-unknown':
        raise('warn'); lines.push(`Unknown contract ${d.address}.`); break
      case 'recipient-foreign':
        lines.push(`Sends to ${d.address}, which is not one of your accounts.`); break
      default:
        break // the "ok" codes need no line
    }
  }
  return { level, lines }
}

/** Balance changes for the sheet: "-0.01 ETH", "+0.01 WETH". */
export function balanceLines(preview: TxPreview): string[] {
  if (preview.simulation.status !== 'ok') return []
  return preview.simulation.changes.map((c) => {
    const sign = c.delta < 0n ? '-' : '+'
    const abs = c.delta < 0n ? -c.delta : c.delta
    const amount = c.decimals === null ? abs.toString() : formatUnits(abs, c.decimals)
    return `${sign}${amount} ${c.symbol ?? c.token}`
  })
}
// #endregion verdict

// #region confirm

/** The EVM calls behind a kit write, when it has any. */
function callsOf(intent: WriteIntent): PreviewCall[] | null {
  const raw = intent.raw as Record<string, unknown>
  if (intent.method === 'sendTransaction' || intent.method === 'signTransaction') {
    const txs = (Array.isArray(raw) ? raw : [raw]) as { to: string; data?: string; value?: bigint }[]
    return txs.map(({ to, data, value }) => ({ to, ...(data ? { data } : {}), value: BigInt(value ?? 0) }))
  }
  if ((intent.kind === 'approval' || intent.kind === 'revoke') && intent.method === 'approve') {
    const { token, spender, amount } = raw as { token: string; spender: string; amount: bigint }
    return [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as Hex, amount] }) }]
  }
  return null // messages, typed data, other chains: confirm without a simulation
}

/** Policies whose confirm step simulates EVM writes before asking the user. */
export function previewPolicies(
  rpcFor: (chainId: number) => Rpc,
  own: string[],
  ask: (intent: WriteIntent, preview: TxPreview | null) => Promise<boolean>,
): Policies {
  return {
    confirm: async (intent) => {
      const calls = intent.chain.startsWith('eip155:') ? callsOf(intent) : null
      if (!calls) return ask(intent, null)
      const chainId = Number(intent.chain.split(':')[1])
      const preview = await previewEvmTx({ chainId, from: intent.from, rpc: rpcFor(chainId), own, calls })
      return ask(intent, preview)
    },
  }
}
// #endregion confirm

// #region swap

/** A swap's approvals and source call, previewed as the one sequence they will run as. */
export async function previewSwap(plan: Swap2ExecutionPlan, from: string, rpc: Rpc): Promise<TxPreview | null> {
  if (plan.source.kind !== 'call') return null // serialized / typed-order legs are checked by the provider module
  const approvals: PreviewCall[] = plan.approvals.map((a) => ({
    to: a.token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.spender as Hex, a.amount] }),
  }))
  return previewEvmTx({
    chainId: Number(plan.fromChain.split(':')[1]),
    from,
    rpc,
    own: [from],
    // The router the provider named is the contract the user is trusting.
    known: Object.fromEntries([plan.source.to, ...plan.approvals.map((a) => a.spender)].map((a) => [a, plan.provider])),
    calls: [...approvals, { to: plan.source.to, ...(plan.source.data ? { data: plan.source.data } : {}), value: plan.source.value }],
    expectedApproval: plan.sourceAmount, // anything above the swap input is flagged
    ...(plan.destChain === plan.fromChain ? { expectedRecipient: plan.recipient } : {}),
  })
}
// #endregion swap
