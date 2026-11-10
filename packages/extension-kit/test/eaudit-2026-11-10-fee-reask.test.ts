/**
 * Extension audit 2026-11-09, E34 / E49 (owner decision): a fee that rose after the sheet was shown
 * is not a refusal — the wallet opens a new sheet with the new fee (old → new) and signs only after
 * a fresh approval. The second sheet belongs to a request the user already approved, so the queue's
 * limits (E17) must not refuse it as a new request from the same site; the number of consecutive
 * re-asks is capped; a fee above the wallet's hard ceiling is refused without a sheet.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  APPROVALS_MAX_PENDING_PER_ORIGIN, ApprovalQueue, DEFAULT_NETWORKS, MAX_FEE_REASKS, OriginRefused, QueueLimitError, RELAY_ERRORS, ReviewDeclined, RouterError,
  createSignHandler, memoryApprovalWindow,
  type ApprovalQueueOptions, type EvmNetwork, type EvmSigner, type SignApproval, type SignDeps,
} from '../src/index.js'

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) }
const settled = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof QueueLimitError ? `limit:${e.code}` : e instanceof OriginRefused ? 'refused' : e instanceof ReviewDeclined ? 'declined' : `other:${String(e)}`))
const SITE = 'https://dapp.example'
const input = (origin = SITE, kind: 'send-transaction' | 'chain-send' = 'send-transaction', chain = 'eip155:1') => ({ origin, chain, kind, payload: {} })

function queue(options: ApprovalQueueOptions = {}) {
  const window = memoryApprovalWindow()
  let seq = 0
  const approvals = new ApprovalQueue(window, () => `r${++seq}`, options)
  return { window, approvals }
}

describe('ApprovalQueue: a follow-up sheet for a request the user approved', () => {
  it('passes the per-origin limit and is shown before the requests already waiting', async () => {
    const { window, approvals } = queue({ openRate: false })
    const first = approvals.request(input())
    await flush()
    approvals.resolve(window.opened[0]!.id, null)
    await first
    const waiting = Array.from({ length: APPROVALS_MAX_PENDING_PER_ORIGIN }, () => approvals.request(input()))
    await flush()
    expect(await settled(approvals.request(input()))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    const again = approvals.request({ ...input(), payload: { again: true } }, { followUp: true })
    await flush()
    expect(approvals.pendingFor(SITE)).toBe(APPROVALS_MAX_PENDING_PER_ORIGIN + 1)
    approvals.resolve(approvals.current!.id, null)
    await flush()
    expect(approvals.current!.payload).toEqual({ again: true })
    approvals.resolve(approvals.current!.id, 'yes')
    expect(await again).toBe('yes')
    approvals.declineAll()
    await Promise.allSettled(waiting)
  })

  it('passes the per-site rate limit', async () => {
    const { window, approvals } = queue({ openRate: { burst: 1, refillPerSecond: 0 }, now: () => 1_000 })
    const first = approvals.request(input())
    await flush()
    approvals.resolve(window.opened[0]!.id, null)
    await first
    expect(await settled(approvals.request(input()))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    const again = approvals.request(input(), { followUp: true })
    await flush()
    expect(window.opened).toHaveLength(2)
    approvals.resolve(window.opened[1]!.id, null)
    await again
  })

  it('one approval pays for one follow-up; without one it is an ordinary request', async () => {
    const { window, approvals } = queue({ openRate: { burst: 1, refillPerSecond: 0 }, now: () => 1_000 })
    const first = approvals.request(input())
    await flush()
    approvals.resolve(window.opened[0]!.id, null)
    await first
    const again = approvals.request(input(), { followUp: true })
    await flush()
    // The follow-up is still open: nothing was approved since, so a second one is held to the limits.
    expect(await settled(approvals.request(input(), { followUp: true }))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    approvals.decline(window.opened[1]!.id)
    expect(await settled(again)).toBe('declined')
    // A declined sheet leaves nothing behind either.
    expect(await settled(approvals.request(input(), { followUp: true }))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
  })

  it('is tied to the origin, the kind and the chain of the approved request', async () => {
    const { window, approvals } = queue({ openRate: { burst: 1, refillPerSecond: 0 }, now: () => 1_000, siteOf: () => 'one-site' })
    const first = approvals.request(input())
    await flush()
    approvals.resolve(window.opened[0]!.id, null)
    await first
    expect(await settled(approvals.request(input('https://other.example'), { followUp: true }))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    expect(await settled(approvals.request(input(SITE, 'chain-send'), { followUp: true }))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    expect(await settled(approvals.request(input(SITE, 'send-transaction', 'eip155:10'), { followUp: true }))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    const again = approvals.request(input(), { followUp: true })
    await flush()
    expect(window.opened).toHaveLength(2)
    approvals.resolve(window.opened[1]!.id, null)
    await again
  })

  it('is still refused for an origin the wallet refuses (phishing list)', async () => {
    let listed = false
    const { window, approvals } = queue({ refuse: () => (listed ? 'This site is on the phishing list.' : null) })
    const first = approvals.request(input())
    await flush()
    approvals.resolve(window.opened[0]!.id, null)
    await first
    listed = true
    expect(await settled(approvals.request(input(), { followUp: true }))).toBe('refused')
    expect(window.opened).toHaveLength(1)
  })

  it('locking the wallet (declineAll) drops what earlier approvals paid for', async () => {
    const { window, approvals } = queue({ openRate: { burst: 1, refillPerSecond: 0 }, now: () => 1_000 })
    const first = approvals.request(input())
    await flush()
    approvals.resolve(window.opened[0]!.id, null)
    await first
    approvals.declineAll()
    expect(await settled(approvals.request(input(), { followUp: true }))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
  })
})

const GWEI = 1_000_000_000n
const A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const OTHER = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'
const ETHEREUM = DEFAULT_NETWORKS.find((n) => n.caip2 === 'eip155:1')!
const GAS = 21_000n * 120n / 100n

/** A sign handler over a fake node whose base fee the test moves; the signer records what it was asked to sign. */
function signing(node: { baseFee: bigint }, options: ApprovalQueueOptions = {}, extra: Partial<SignDeps> = {}) {
  const { window, approvals } = queue(options)
  const signed: Array<Parameters<EvmSigner['signTransaction']>[0]> = []
  const sent: string[] = []
  const rpc = vi.fn(async (_n: EvmNetwork, method: string, params: unknown[]): Promise<unknown> => {
    switch (method) {
      case 'eth_getTransactionCount': return '0x1'
      case 'eth_getBlockByNumber': return { baseFeePerGas: `0x${node.baseFee.toString(16)}` }
      case 'eth_maxPriorityFeePerGas': return '0x0'
      case 'eth_estimateGas': return '0x5208'
      case 'eth_sendRawTransaction': sent.push(params[0] as string); return `0x${String(sent.length).padStart(64, '0')}`
      default: throw new Error(`unexpected rpc ${method}`)
    }
  })
  const signer: EvmSigner = { signMessage: async () => '0x', signTypedData: async () => '0x', signTransaction: async (tx) => { signed.push(tx); return `0x${String(signed.length).padStart(4, '0')}` } }
  const sign = createSignHandler({ approvals, rpc, signerFor: async () => ({ signer, dispose: () => undefined }), ...extra })
  const send = () => sign({ origin: SITE, network: ETHEREUM, method: 'eth_sendTransaction', params: [{ from: A, to: OTHER, value: '0x1' }], accounts: [A] })
  const sheet = (i: number) => window.opened[i]!.payload as SignApproval
  return { window, approvals, signed, sent, send, sheet }
}
const cap = (baseFee: bigint) => 2n * baseFee + 100_000_000n

describe('eth_sendTransaction: the fee rose after the sheet (audit E34 / E49)', () => {
  it('a second sheet shows the old and the new max fee; approving it signs at the new cap', async () => {
    const node = { baseFee: 30n * GWEI }
    const h = signing(node)
    const p = h.send()
    await flush()
    const first = h.sheet(0).prepared!
    node.baseFee = 100n * GWEI
    h.approvals.resolve(h.window.opened[0]!.id, null)
    await flush()
    expect(h.window.opened).toHaveLength(2)
    expect(h.signed).toHaveLength(0)
    const second = h.sheet(1)
    expect(second.repriced).toBe(true)
    expect(second.repricedFrom).toBe(first.maxFee)
    expect(second.prepared!.maxFee).toBe((GAS * cap(100n * GWEI)).toString())
    // Same transaction: only the fee fields differ.
    expect(second.request).toEqual(h.sheet(0).request)
    expect(second.prepared!.gasLimit).toBe(first.gasLimit)
    h.approvals.resolve(h.window.opened[1]!.id, null)
    await p
    expect(h.signed).toHaveLength(1)
    expect(h.signed[0]!.maxFeePerGas).toBe(cap(100n * GWEI))
    expect(h.sent).toHaveLength(1)
  })

  it('declining the second sheet signs nothing', async () => {
    const node = { baseFee: 30n * GWEI }
    const h = signing(node)
    const p = h.send()
    await flush()
    node.baseFee = 100n * GWEI
    h.approvals.resolve(h.window.opened[0]!.id, null)
    await flush()
    h.approvals.decline(h.window.opened[1]!.id)
    await expect(p).rejects.toBeInstanceOf(ReviewDeclined)
    expect(h.signed).toHaveLength(0)
    expect(h.sent).toHaveLength(0)
  })

  it('the second sheet is not refused by the queue limits of the site', async () => {
    const node = { baseFee: 30n * GWEI }
    // One sheet per site, no refill: any further ordinary request from the site is refused.
    const h = signing(node, { openRate: { burst: 1, refillPerSecond: 0 }, now: () => 1_000 })
    const p = h.send()
    await flush()
    node.baseFee = 100n * GWEI
    h.approvals.resolve(h.window.opened[0]!.id, null)
    await flush()
    expect(h.window.opened).toHaveLength(2)
    h.approvals.resolve(h.window.opened[1]!.id, null)
    await p
    expect(h.signed).toHaveLength(1)
    // …while a new request of the page still is.
    await expect(h.send()).rejects.toBeInstanceOf(QueueLimitError)
  })

  it(`rising on every sheet: asked again each time, at most ${MAX_FEE_REASKS} times in a row, then stopped with nothing signed`, async () => {
    const node = { baseFee: 30n * GWEI }
    const h = signing(node)
    const p = h.send()
    const outcome = p.then(() => 'sent', (e: unknown) => e)
    for (let i = 0; i <= MAX_FEE_REASKS; i++) {
      await flush()
      expect(h.window.opened).toHaveLength(i + 1)
      if (i > 0) expect(h.sheet(i).repricedFrom).toBe(h.sheet(i - 1).prepared!.maxFee)
      node.baseFee *= 3n
      h.approvals.resolve(h.window.opened[i]!.id, null)
    }
    const e = await outcome
    expect(e).toBeInstanceOf(RouterError)
    expect((e as RouterError).message).toMatch(/kept rising/i)
    expect((e as RouterError).message).toMatch(/nothing was signed/i)
    expect(h.window.opened).toHaveLength(MAX_FEE_REASKS + 1)
    expect(h.signed).toHaveLength(0)
  })

  it('a new fee above the wallet ceiling is refused without a second sheet', async () => {
    const node = { baseFee: 30n * GWEI }
    const ceiling = GAS * cap(60n * GWEI)
    const feeCeiling = vi.fn(() => ceiling)
    const h = signing(node, {}, { feeCeiling })
    const p = h.send()
    await flush()
    node.baseFee = 100n * GWEI
    h.approvals.resolve(h.window.opened[0]!.id, null)
    const e = await p.then(() => 'sent', (x: unknown) => x)
    expect(e).toBeInstanceOf(RouterError)
    expect((e as RouterError).message).toMatch(/above the wallet's limit/i)
    expect(h.window.opened).toHaveLength(1)
    expect(h.signed).toHaveLength(0)
    expect(feeCeiling).toHaveBeenCalledWith(ETHEREUM)
  })

  it('a new fee under the ceiling is asked as usual', async () => {
    const node = { baseFee: 30n * GWEI }
    const h = signing(node, {}, { feeCeiling: () => GAS * cap(100n * GWEI) })
    const p = h.send()
    await flush()
    node.baseFee = 100n * GWEI
    h.approvals.resolve(h.window.opened[0]!.id, null)
    await flush()
    expect(h.window.opened).toHaveLength(2)
    h.approvals.resolve(h.window.opened[1]!.id, null)
    await p
    expect(h.signed).toHaveLength(1)
  })
})
