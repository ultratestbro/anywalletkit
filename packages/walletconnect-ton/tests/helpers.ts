/** A wallet-ton account on an in-memory toncenter (`TonRpc`), recording every broadcast. */
import { Cell } from '@ton/core'
import { WalletManagerTon, type TonConfig, type WalletAccountTon } from '@anywalletkit/wallet-ton'

export const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

export interface FakeTon {
  config: TonConfig
  sent: Cell[]
  calls: string[]
}

export function fakeTon(opts: { state?: 'active' | 'uninitialized'; balance?: bigint; refuseSend?: boolean } = {}): FakeTon {
  const sent: Cell[] = []
  const calls: string[] = []
  const handlers: Record<string, (p: Record<string, unknown>) => unknown> = {
    getAddressInformation: () => ({ '@type': 'raw.fullAccountState', balance: String(opts.balance ?? 5_000_000_000n), state: opts.state ?? 'active', code: '', data: '', last_transaction_id: { '@type': 'internal.transactionId', lt: '1', hash: 'AA==' }, sync_utime: 1 }),
    runGetMethod: (p) => {
      if (p.method === 'seqno') return { '@type': 'smc.runResult', gas_used: 1, exit_code: 0, stack: [['num', '0x' + (7 + sent.length).toString(16)]] }
      throw new Error(`unmocked get method ${String(p.method)}`)
    },
    estimateFee: () => ({ '@type': 'query.fees', source_fees: { '@type': 'fees', in_fwd_fee: 1000, storage_fee: 10, gas_fee: 2000, fwd_fee: 100 }, destination_fees: [] }),
    sendBoc: (p) => {
      if (opts.refuseSend) throw Object.assign(new Error('LITE_SERVER_UNKNOWN: cannot apply external message'), { answered: true })
      sent.push(Cell.fromBase64(p.boc as string))
      return {}
    },
  }
  const config: TonConfig = {
    emulate: false,
    tonClient: { call: async <T>(method: string, params: Record<string, unknown>): Promise<T> => { calls.push(method); const h = handlers[method]; if (!h) throw new Error(`unmocked ${method}`); return h(params) as T } },
  }
  return { config, sent, calls }
}

export async function tonAccount(config: TonConfig = {}, index = 0): Promise<{ account: WalletAccountTon; manager: WalletManagerTon }> {
  const manager = new WalletManagerTon(SEED, config)
  return { account: (await manager.getAccount(index)) as WalletAccountTon, manager }
}

export const now = () => Math.floor(Date.now() / 1000)
