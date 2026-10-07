/**
 * A fake `fetch` speaking toncenter v2 JSON-RPC (+ the v3 indexer and an
 * emulation endpoint), recording calls and broadcast BoCs.
 */
import { Buffer } from 'buffer'
import { Address, Cell, beginCell } from '@ton/core'

export const JETTON_WALLET = new Address(0, Buffer.alloc(32, 7)).toString()

export type Handler = (params: Record<string, unknown>) => unknown

export interface FakeRpc {
  fetch: typeof fetch
  calls: string[]
  sent: Cell[]
  emulations: number
  /** Request headers of the last emulation call. */
  lastEmulateHeaders: Record<string, string>
  lastEmulateUrl: string
}

/** A clean tonapi `MessageConsequences`: root ok, one successful child, nothing risky. */
export function tonapiOk(extra: { risk?: Record<string, unknown>; children?: unknown[]; root?: Record<string, unknown> } = {}) {
  return {
    trace: {
      transaction: { hash: 'root', account: { address: '0:00' }, success: true, aborted: false, compute_phase: { skipped: false, success: true, exit_code: 0 }, action_phase: { success: true, result_code: 0 }, ...(extra.root ?? {}) },
      interfaces: ['wallet_v5r1'],
      children: extra.children ?? [{ transaction: { hash: 'c1', account: { address: '0:01' }, success: true, aborted: false, compute_phase: { skipped: false, success: true, exit_code: 0 }, action_phase: { success: true, result_code: 0 } } }],
    },
    event: {},
    risk: { transfer_all_remaining_balance: false, ton: 1, jettons: [], nfts: [], ...(extra.risk ?? {}) },
  }
}

export function fakeRpc(overrides: Record<string, Handler> = {}, opts: { emulate?: () => unknown; tonapi?: () => unknown; traces?: () => unknown; walletEmulate404?: boolean; indexer?: () => unknown; failAll?: boolean } = {}): FakeRpc {
  const calls: string[] = []
  const sent: Cell[] = []
  const walletData = beginCell().storeAddress(Address.parse(JETTON_WALLET)).endCell().toBoc().toString('base64')
  const state = { emulations: 0, lastEmulateHeaders: {} as Record<string, string>, lastEmulateUrl: '' }
  const handlers: Record<string, Handler> = {
    getAddressInformation: () => ({ '@type': 'raw.fullAccountState', balance: '1000000000', state: 'active', code: '', data: '', last_transaction_id: { '@type': 'internal.transactionId', lt: '1', hash: 'AA==' }, sync_utime: 1 }),
    runGetMethod: (p) => {
      if (p.method === 'seqno') return { '@type': 'smc.runResult', gas_used: 1, exit_code: 0, stack: [['num', '0x7']] }
      if (p.method === 'get_wallet_address') return { '@type': 'smc.runResult', gas_used: 1, exit_code: 0, stack: [['cell', { bytes: walletData }]] }
      if (p.method === 'get_wallet_data') return { '@type': 'smc.runResult', gas_used: 1, exit_code: 0, stack: [['num', '0x3e8']] }
      throw new Error(`unmocked get method ${String(p.method)}`)
    },
    estimateFee: () => ({ '@type': 'query.fees', source_fees: { '@type': 'fees', in_fwd_fee: 1000, storage_fee: 10, gas_fee: 2000, fwd_fee: 100 }, destination_fees: [] }),
    sendBoc: (p) => { sent.push(Cell.fromBase64(p.boc as string)); return {} },
    ...overrides,
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (opts.failAll) throw new Error('boom')
    if (url.includes('/wallet/emulate') || url.includes('/traces/emulate') || url.includes('/emulate')) {
      state.emulations++
      state.lastEmulateUrl = url
      state.lastEmulateHeaders = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
      if (url.includes('/wallet/emulate')) {
        calls.push('tonapi:wallet/emulate')
        if (opts.walletEmulate404) return json({ error: 'not found' }, 404)
        return json(opts.tonapi ? opts.tonapi() : tonapiOk())
      }
      if (url.includes('/traces/emulate')) { calls.push('tonapi:traces/emulate'); return json(opts.traces ? opts.traces() : tonapiOk().trace) }
      calls.push('emulate')
      return json(opts.emulate ? opts.emulate() : { transactions: {} })
    }
    if (url.includes('transactionsByMessage')) { calls.push('transactionsByMessage'); return json(opts.indexer ? opts.indexer() : { transactions: [] }) }
    const req = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
    calls.push(req.method)
    const h = handlers[req.method]
    if (!h) return json({ ok: false, error: `unmocked ${req.method}`, code: 500 }, 500)
    try { return json({ ok: true, result: h(req.params) }) } catch (e) { return json({ ok: false, error: (e as Error).message, code: 500 }, 500) }
  }) as typeof fetch
  return { fetch: f, calls, sent, get emulations() { return state.emulations }, get lastEmulateHeaders() { return state.lastEmulateHeaders }, get lastEmulateUrl() { return state.lastEmulateUrl } }
}
