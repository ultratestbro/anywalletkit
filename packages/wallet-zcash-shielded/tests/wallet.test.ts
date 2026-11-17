import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AddressCheckError, NotImplementedError, ZcashShieldedWallet, decodeUnifiedAddress, transparentReceiverAddress, type NativeBalanceEvent, type NativeSynchronizer, type NativeZcash } from '../src/index.js'

const UA_VECTORS = (JSON.parse(readFileSync(new URL('./fixtures/unified_address.json', import.meta.url), 'utf8')) as string[][]).slice(2)
const UA = UA_VECTORS[0]![6]!
const UA_T = transparentReceiverAddress(decodeUnifiedAddress(UA))!

type Callbacks = Parameters<NativeSynchronizer['subscribe']>[0]

function fakeNative(addresses = { unifiedAddress: UA, saplingAddress: 'zs1test', transparentAddress: UA_T }) {
  let callbacks: Callbacks | undefined
  let opened: Parameters<NativeZcash['makeSynchronizer']>[0] | undefined
  let stopped = 0
  const sync: NativeSynchronizer = {
    subscribe: (c) => { callbacks = c },
    deriveUnifiedAddress: async () => addresses,
    getLatestNetworkHeight: async () => 3_581_000,
    stop: async () => { stopped++ },
  }
  const native: NativeZcash = { makeSynchronizer: async (config) => { opened = config; return sync } }
  return { native, emit: () => callbacks!, opened: () => opened!, stopped: () => stopped }
}

const BALANCE: NativeBalanceEvent = {
  transparentAvailableZatoshi: '100', transparentTotalZatoshi: '150',
  saplingAvailableZatoshi: '0', saplingTotalZatoshi: '0',
  orchardAvailableZatoshi: '7', orchardTotalZatoshi: '7',
  ironwoodAvailableZatoshi: '50000', ironwoodTotalZatoshi: '60000',
}

const open = (native: NativeZcash) => ZcashShieldedWallet.open('test words', { native, server: { host: 'zec.rocks', port: 443 }, birthdayHeight: 3_580_000, alias: 'proto-1' })

describe('ZcashShieldedWallet', () => {
  it('opens the synchronizer with the phrase, birthday and alias, on mainnet by default', async () => {
    const f = fakeNative()
    const w = await open(f.native)
    expect(f.opened()).toMatchObject({ networkName: 'mainnet', defaultHost: 'zec.rocks', defaultPort: 443, mnemonicSeed: 'test words', alias: 'proto-1', birthdayHeight: 3_580_000 })
    expect(w.network).toBe('mainnet')
  })

  it('refuses a bad birthday or alias before touching the SDK', async () => {
    const f = fakeNative()
    await expect(ZcashShieldedWallet.open('w', { native: f.native, server: { host: 'h', port: 1 }, birthdayHeight: 0, alias: 'a' })).rejects.toThrow(/birthdayHeight/)
    await expect(ZcashShieldedWallet.open('w', { native: f.native, server: { host: 'h', port: 1 }, birthdayHeight: 1, alias: '../x' })).rejects.toThrow(/alias/)
  })

  it('reports the balance per pool in bigint zatoshi, pending = total − spendable', async () => {
    const f = fakeNative()
    const w = await open(f.native)
    const pending = w.getBalance()
    f.emit().onBalanceChanged(BALANCE)
    const b = await pending
    expect(b.transparent).toEqual({ spendable: 100n, total: 150n, pending: 50n })
    expect(b.orchard).toEqual({ spendable: 7n, total: 7n, pending: 0n })
    expect(b.ironwood).toEqual({ spendable: 50_000n, total: 60_000n, pending: 10_000n })
    expect(b.total).toEqual({ spendable: 50_107n, total: 60_157n, pending: 10_050n })
  })

  it('refuses a non-integer amount from the SDK instead of guessing', async () => {
    const f = fakeNative()
    const w = await open(f.native)
    const seen: unknown[] = []
    const errors: string[] = []
    w.onBalance((b) => seen.push(b))
    w.onError((e) => errors.push(e.message))
    f.emit().onBalanceChanged({ ...BALANCE, ironwoodTotalZatoshi: '1.5' })
    expect(seen).toHaveLength(0)
    expect(errors).toEqual([expect.stringMatching(/non-integer/)])
    await expect(w.getBalance({ timeoutMs: 10 })).rejects.toThrow(/non-integer/)
  })

  it('times out a balance that never comes, with the last sync error when there is one', async () => {
    const f = fakeNative()
    const w = await open(f.native)
    f.emit().onError({ alias: 'proto-1', level: 'critical', message: 'lightwalletd unreachable' })
    await expect(w.getBalance({ timeoutMs: 10 })).rejects.toThrow(/lightwalletd unreachable/)
  })

  it('tracks sync progress and status; synced means 100 %', async () => {
    const f = fakeNative()
    const w = await open(f.native)
    const seen: string[] = []
    const off = w.onSyncProgress((p) => seen.push(`${p.status}:${p.percent}:${p.networkHeight}`))
    f.emit().onStatusChanged({ alias: 'proto-1', name: 'SYNCING' })
    f.emit().onUpdate({ alias: 'proto-1', scanProgress: 42.5, networkBlockHeight: 3_581_000 })
    f.emit().onUpdate({ alias: 'proto-1', scanProgress: 250, networkBlockHeight: 0 })
    f.emit().onStatusChanged({ alias: 'proto-1', name: 'SYNCED' })
    off()
    f.emit().onStatusChanged({ alias: 'proto-1', name: 'STOPPED' })
    expect(seen).toEqual(['disconnected:0:0', 'syncing:0:0', 'syncing:42.5:3581000', 'syncing:100:3581000', 'synced:100:3581000'])
  })

  it('returns the unified address with its decoded receivers', async () => {
    const w = await open(fakeNative().native)
    const a = await w.getAddress()
    expect(a.unified).toBe(UA)
    expect(a.transparent).toBe(UA_T)
    expect(a.receivers.map((r) => r.kind)).toEqual(['p2pkh', 'sapling'])
    expect(a.canReceiveIronwood).toBe(false)
  })

  it('marks an address with an Orchard-format receiver as able to receive Ironwood', async () => {
    const withOrchard = UA_VECTORS.find((v) => v[3] !== null && v[0] !== null)!
    const t = transparentReceiverAddress(decodeUnifiedAddress(withOrchard[6]!))!
    const w = await open(fakeNative({ unifiedAddress: withOrchard[6]!, saplingAddress: 'zs1', transparentAddress: t }).native)
    const a = await w.getAddress()
    expect(a.receivers.map((r) => r.kind)).toContain('orchard')
    expect(a.canReceiveIronwood).toBe(true)
  })

  it('refuses a unified address whose transparent receiver is not the account address', async () => {
    const w = await open(fakeNative({ unifiedAddress: UA, saplingAddress: 'zs1', transparentAddress: 't1QFUFYoKXSqa7c367ieJnuwHhsawVZtU1x' }).native)
    await expect(w.getAddress()).rejects.toBeInstanceOf(AddressCheckError)
  })

  it('refuses a unified address with no shielded receiver', async () => {
    const tOnly = UA_VECTORS.find((v) => v[2] === null && v[3] === null && v[6])
    if (!tOnly) return // ZIP-316 forbids transparent-only UAs; the vectors have none
    const w = await open(fakeNative({ unifiedAddress: tOnly[6]!, saplingAddress: '', transparentAddress: '' }).native)
    await expect(w.getAddress()).rejects.toBeInstanceOf(AddressCheckError)
  })

  it('send, shield, migrateOrchard and describeTransaction are typed but not implemented', async () => {
    const w = await open(fakeNative().native)
    await expect(w.send({ recipient: UA, amount: 1n }, 'w')).rejects.toBeInstanceOf(NotImplementedError)
    await expect(w.shield('w')).rejects.toBeInstanceOf(NotImplementedError)
    await expect(w.migrateOrchard('w')).rejects.toBeInstanceOf(NotImplementedError)
    await expect(w.describeTransaction('AA==')).rejects.toBeInstanceOf(NotImplementedError)
  })

  it('close stops the synchronizer once', async () => {
    const f = fakeNative()
    const w = await open(f.native)
    await w.close()
    await w.close()
    expect(f.stopped()).toBe(1)
  })
})
