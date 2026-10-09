import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { NetworkError } from '@forgewallet/core'
import { SimulationError, UnsafeTransactionError, WalletManagerTon, parseTonapiRisk, parseTonapiTrace, resolveEmulate } from '../src/index.js'
import { fakeRpc, tonapiOk } from './fake-rpc.js'

const SEED = 'test test test test test test test test test test test junk'
const RECIPIENT = 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi'
const manager = (f: ReturnType<typeof fakeRpc>, extra: Record<string, unknown> = {}) =>
  new WalletManagerTon(SEED, { tonClient: { url: 'http://fake/jsonRPC' }, fetch: f.fetch, ...extra })

const failedTx = (address: string, exitCode: number) => ({
  transaction: { hash: 'x', account: { address }, success: false, aborted: false, compute_phase: { skipped: false, success: false, exit_code: exitCode }, action_phase: { success: false, result_code: 0 } },
})

describe('emulation via tonapi', () => {
  it('is the default: POST /wallet/emulate on tonApiUrl, verdict ok, risk exposed, source tonapi', async () => {
    const f = fakeRpc({}, { tonapi: () => tonapiOk({ risk: { ton: 1_234, jettons: [{ quantity: '5000000', wallet_address: { address: '0:0a' }, jetton: { address: '0:0b', symbol: 'USDT', decimals: 6 } }] } }) })
    const a = await manager(f, { tonApiUrl: 'http://fake-tonapi/v2' }).getAccount(0)
    const sim = await a.simulateTransaction({ to: RECIPIENT, value: 1n })
    expect(sim).toMatchObject({ ok: true, emulated: true, source: 'tonapi', exitCode: 0, actionSuccess: true, warnings: [] })
    expect(sim.risk).toEqual({ ton: 1234n, transferAllRemainingBalance: false, jettons: [{ address: '0:0b', walletAddress: '0:0a', amount: 5_000_000n, symbol: 'USDT', decimals: 6 }] })
    expect(f.lastEmulateUrl).toBe('http://fake-tonapi/v2/wallet/emulate?ignore_signature_check=true')
    expect(f.calls).toContain('tonapi:wallet/emulate')
    expect(resolveEmulate({})).toEqual({ kind: 'tonapi' })
  })

  it('compute failure (exit 34) → SimulationError before signing; the signer is never asked and nothing is broadcast', async () => {
    const f = fakeRpc({}, { tonapi: () => tonapiOk({ root: { success: false, compute_phase: { skipped: false, success: false, exit_code: 34, exit_code_description: 'action list invalid' }, action_phase: undefined } }) })
    const m = manager(f)
    const a = await m.getAccount(0)
    let signed = 0
    const orig = a.signer.sign.bind(a.signer)
    a.signer.sign = async (...args: Parameters<typeof orig>) => { signed++; return orig(...args) }
    const err = await a.transfer({ recipient: RECIPIENT, amount: 1n }).catch((e) => e)
    expect(err).toBeInstanceOf(SimulationError)
    expect((err as SimulationError).exitCode).toBe(34)
    expect(err.message).toMatch(/exit_code 34/)
    expect(signed).toBe(0)
    expect(f.sent).toHaveLength(0)
  })

  it('a non-bounceable transfer that funds a nonexistent account is ok (aborted + cskip_no_state, success true)', () => {
    // tonapi shape seen live 2026-10-09 for a TON deposit to a fresh NEAR Intents address.
    const credited = { transaction: { hash: 'c', account: { address: '0:eac4' }, success: true, aborted: true, compute_phase: { skipped: true, skip_reason: 'cskip_no_state' }, end_status: 'uninit', orig_status: 'nonexist' } }
    const trace = { ...tonapiOk().trace, children: [credited] }
    expect(parseTonapiTrace(trace)).toMatchObject({ ok: true, warnings: [] })
    // the bounceable twin bounces: still fatal
    const bounced = { transaction: { ...credited.transaction, success: false, bounce_phase: 'TrPhaseBounceOk' } }
    expect(parseTonapiTrace({ ...tonapiOk().trace, children: [bounced] })).toMatchObject({ ok: false })
    expect(parseTonapiTrace({ ...tonapiOk().trace, children: [bounced] }).reason).toMatch(/internal message failed/)
  })

  it('a bounced/failed child deeper than the first hop is a warning; a failed first hop is fatal', async () => {
    const deep = fakeRpc({}, { tonapi: () => tonapiOk({ children: [{ ...(tonapiOk().trace.children[0] as Record<string, unknown>), children: [failedTx('0:deep', 709)] }] }) })
    const a = await manager(deep).getAccount(0)
    const sim = await a.simulateTransaction({ to: RECIPIENT, value: 1n })
    expect(sim.ok).toBe(true)
    expect(sim.warnings).toEqual(['0:deep: compute exit_code 709'])
    await a.transfer({ recipient: RECIPIENT, amount: 1n })
    expect(deep.sent).toHaveLength(1)

    const first = fakeRpc({}, { tonapi: () => tonapiOk({ children: [failedTx('0:jw', 65535)] }) })
    const b = await manager(first).getAccount(0)
    const bad = await b.simulateTransaction({ to: RECIPIENT, value: 1n })
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.reason).toMatch(/internal message failed — 0:jw: compute exit_code 65535/)
    await expect(b.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toBeInstanceOf(SimulationError)
    expect(first.sent).toHaveLength(0)
  })

  it('malformed responses are NetworkErrors, never a silent pass', async () => {
    const noTrace = fakeRpc({}, { tonapi: () => ({ event: {}, risk: {} }) })
    const a = await manager(noTrace).getAccount(0)
    await expect(a.simulateTransaction({ to: RECIPIENT, value: 1n })).rejects.toBeInstanceOf(NetworkError)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toBeInstanceOf(NetworkError)
    expect(noTrace.sent).toHaveLength(0)
    expect(() => parseTonapiTrace({ transaction: { hash: 'r' } })).toThrow(NetworkError)
    expect(() => parseTonapiRisk({ ton: 'abc' })).toThrow(NetworkError)
    const noRisk = fakeRpc({}, { tonapi: () => ({ trace: tonapiOk().trace, event: {} }) })
    const b = await manager(noRisk).getAccount(0)
    await expect(b.simulateTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(/risk/)
  })

  it('404 on /wallet/emulate falls back to /traces/emulate (verdict without risk)', async () => {
    const f = fakeRpc({}, { walletEmulate404: true, traces: () => tonapiOk().trace })
    const a = await manager(f).getAccount(0)
    const sim = await a.simulateTransaction({ to: RECIPIENT, value: 1n })
    expect(sim).toMatchObject({ ok: true, source: 'tonapi', exitCode: 0 })
    expect(sim.risk).toBeUndefined()
    expect(f.calls.filter((c) => c.startsWith('tonapi:'))).toEqual(['tonapi:wallet/emulate', 'tonapi:traces/emulate'])
    expect(f.lastEmulateUrl).toBe('https://tonapi.io/v2/traces/emulate?ignore_signature_check=true')
  })

  it('emulate: false → estimate-only (no emulator call, fee cap still applies)', async () => {
    const f = fakeRpc()
    const a = await manager(f, { emulate: false }).getAccount(0)
    const sim = await a.simulateTransaction({ to: RECIPIENT, value: 1n })
    expect(sim).toMatchObject({ ok: true, emulated: false, source: 'estimate-only', warnings: [] })
    expect(f.emulations).toBe(0)
    await a.transfer({ recipient: RECIPIENT, amount: 1n })
    expect(f.sent).toHaveLength(1)
    const capped = await manager(f, { emulate: false, transferMaxFee: 1n }).getAccount(0)
    await expect(capped.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/maximum fee/)
  })

  it('toncenter-v3 path: explicit config and the legacy emulateUrl both work; source toncenter-v3', async () => {
    const good = () => ({ transactions: [{ description: { aborted: false, compute_ph: { success: true, exit_code: 0 }, action: { success: true } } }] })
    const f = fakeRpc({}, { emulate: good })
    const a = await manager(f, { emulate: { kind: 'toncenter-v3', url: 'http://fake/api/emulate/v1/emulateTrace' } }).getAccount(0)
    expect(await a.simulateTransaction({ to: RECIPIENT, value: 1n })).toMatchObject({ ok: true, source: 'toncenter-v3', exitCode: 0, actionSuccess: true, warnings: [] })
    expect(f.calls).toContain('emulate')
    expect(f.calls).not.toContain('tonapi:wallet/emulate')
    const legacy = fakeRpc({}, { emulate: good })
    const b = await manager(legacy, { emulateUrl: 'http://fake/api/emulate/v1/emulateTrace' }).getAccount(0)
    expect(await b.simulateTransaction({ to: RECIPIENT, value: 1n })).toMatchObject({ ok: true, source: 'toncenter-v3' })
    expect(resolveEmulate({ emulateUrl: 'u' })).toEqual({ kind: 'toncenter-v3', url: 'u' })
    expect(resolveEmulate({ emulate: { kind: 'tonapi', url: 'x' }, emulateUrl: 'u' })).toEqual({ kind: 'tonapi', url: 'x' })
  })

  it('sends the tonapi key as a bearer header', async () => {
    const f = fakeRpc()
    const a = await manager(f, { tonApiKey: 'k3y' }).getAccount(0)
    await a.simulateTransaction({ to: RECIPIENT, value: 1n })
    expect(f.lastEmulateHeaders.authorization).toBe('Bearer k3y')
    const g = fakeRpc()
    const b = await manager(g).getAccount(0)
    await b.simulateTransaction({ to: RECIPIENT, value: 1n })
    expect(g.lastEmulateHeaders.authorization).toBeUndefined()
  })

  it('risk.transfer_all_remaining_balance → UnsafeTransactionError("drain") unless allowDrainingTransactions', async () => {
    const f = fakeRpc({}, { tonapi: () => tonapiOk({ risk: { transfer_all_remaining_balance: true } }) })
    const a = await manager(f).getAccount(0)
    const sim = await a.simulateTransaction({ to: RECIPIENT, value: 1n })
    expect(sim.ok).toBe(true) // the emulation itself passes; the refusal is the account's
    expect(sim.risk?.transferAllRemainingBalance).toBe(true)
    const err = await a.transfer({ recipient: RECIPIENT, amount: 1n }).catch((e) => e)
    expect(err).toBeInstanceOf(UnsafeTransactionError)
    expect((err as UnsafeTransactionError).code).toBe('drain')
    expect(f.sent).toHaveLength(0)
    const b = await manager(f, { allowDrainingTransactions: true }).getAccount(0)
    await b.transfer({ recipient: RECIPIENT, amount: 1n })
    expect(f.sent).toHaveLength(1)
  })

  it('HTTP errors from tonapi are a failed verdict with the status, not a throw', async () => {
    const f = fakeRpc()
    const original = f.fetch
    const fetch429 = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('/wallet/emulate') ? new Response(JSON.stringify({ error: 'rate limit' }), { status: 429, headers: { 'content-type': 'application/json' } }) : original(input, init)) as typeof fetch
    const a = new WalletManagerTon(SEED, { tonClient: { url: 'http://fake/jsonRPC' }, fetch: fetch429 }).getAccount(0)
    const sim = await (await a).simulateTransaction({ to: RECIPIENT, value: 1n })
    expect(sim.ok).toBe(false)
    expect(sim.ok === false && sim.reason).toBe('HTTP 429: rate limit')
  })
})
