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
}

export function fakeRpc(overrides: Record<string, Handler> = {}, opts: { emulate?: () => unknown; indexer?: () => unknown; failAll?: boolean } = {}): FakeRpc {
  const calls: string[] = []
  const sent: Cell[] = []
  const walletData = beginCell().storeAddress(Address.parse(JETTON_WALLET)).endCell().toBoc().toString('base64')
  const state = { emulations: 0 }
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
    if (url.includes('/emulate')) { state.emulations++; calls.push('emulate'); return json(opts.emulate ? opts.emulate() : { transactions: {} }) }
    if (url.includes('transactionsByMessage')) { calls.push('transactionsByMessage'); return json(opts.indexer ? opts.indexer() : { transactions: [] }) }
    const req = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
    calls.push(req.method)
    const h = handlers[req.method]
    if (!h) return json({ ok: false, error: `unmocked ${req.method}`, code: 500 }, 500)
    try { return json({ ok: true, result: h(req.params) }) } catch (e) { return json({ ok: false, error: (e as Error).message, code: 500 }, 500) }
  }) as typeof fetch
  return { fetch: f, calls, sent, get emulations() { return state.emulations } }
}
