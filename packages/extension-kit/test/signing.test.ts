import { describe, expect, it, vi } from 'vitest'
import { parseTransaction, recoverMessageAddress, recoverTypedDataAddress, type Hex } from 'viem'
import { Keyring } from '@anywalletkit/keyring'
import { WalletManagerEvm, type WalletAccountEvm } from '@anywalletkit/wallet-evm'
import {
  ApprovalQueue,
  DEFAULT_NETWORKS,
  NetworksTable,
  PermissionStore,
  RequestRouter,
  Session,
  Vault,
  chromeKeyringStorage,
  classifySignRequest,
  createSignHandler,
  memoryAlarms,
  memoryApprovalWindow,
  memoryJsonStorage,
  memorySessionStorage,
  memoryVaultStorage,
  messageText,
  toRelayError,
  vaultSecretStorage,
  type EvmNetwork,
  type EvmSigner,
  type PermissionsState,
  type SignApproval,
  type StorageAreaLike,
} from '../src/index.js'

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const OTHER = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'
const SITE = 'https://dapp.example'
const ETH = DEFAULT_NETWORKS[0]!
const flush = () => new Promise((r) => setTimeout(r, 0))
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => toRelayError(e))

function memoryArea(): StorageAreaLike {
  const items = new Map<string, unknown>()
  return {
    async get(keys) { const out: Record<string, unknown> = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (items.has(k)) out[k] = structuredClone(items.get(k)); return out },
    async set(o) { for (const [k, v] of Object.entries(o)) items.set(k, structuredClone(v)) },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) items.delete(k) },
  }
}

describe('classifySignRequest', () => {
  const input = (method: string, params: unknown[]) => classifySignRequest({ network: ETH, method, params, accounts: [A] })
  it('personal_sign: owned address, either parameter order, hex decoded when printable', () => {
    expect(input('personal_sign', ['0x68656c6c6f', A])).toMatchObject({ kind: 'sign-message', account: A, text: 'hello', raw: '0x68656c6c6f' })
    expect(input('personal_sign', [A.toLowerCase(), 'plain text'])).toMatchObject({ kind: 'sign-message', account: A, text: 'plain text' })
    expect(input('personal_sign', ['0x68656c6c6f', OTHER])).toMatchObject({ code: 4100 })
    expect(messageText('0x' + 'ff'.repeat(32))).toBe('0x' + 'ff'.repeat(32)) // a hash stays hex
  })
  it('typed data: owned address, valid JSON, domain chainId must match the connected chain', () => {
    const typed = { domain: { name: 'X', chainId: 1 }, types: { M: [{ name: 'v', type: 'uint256' }] }, message: { v: '1' }, primaryType: 'M' }
    expect(input('eth_signTypedData_v4', [A, JSON.stringify(typed)])).toMatchObject({ kind: 'sign-typed-data', account: A })
    expect(input('eth_signTypedData_v4', [A, typed])).toMatchObject({ kind: 'sign-typed-data' })
    expect(input('eth_signTypedData_v4', [OTHER, JSON.stringify(typed)])).toMatchObject({ code: 4100 })
    expect(input('eth_signTypedData_v4', [A, '{nope'])).toMatchObject({ code: -32602 })
    expect(input('eth_signTypedData_v4', [A, JSON.stringify({ ...typed, domain: { chainId: 8453 } })])).toMatchObject({ code: 4901 })
    expect(input('eth_signTypedData_v4', [A, JSON.stringify({ ...typed, domain: { chainId: '0x1' } })])).toMatchObject({ kind: 'sign-typed-data' })
  })
  it('eth_sendTransaction: owned from, a `to`, matching chainId, sane value and data', () => {
    expect(input('eth_sendTransaction', [{ from: A, to: OTHER, value: '0xde0b6b3a7640000' }])).toMatchObject({ kind: 'send-transaction', tx: { to: OTHER, value: '1000000000000000000', data: null, gas: null } })
    expect(input('eth_sendTransaction', [{ from: OTHER, to: A }])).toMatchObject({ code: 4100 })
    expect(input('eth_sendTransaction', [{ to: A }])).toMatchObject({ code: 4100 })
    expect(input('eth_sendTransaction', [{ from: A, data: '0x60806040' }])).toMatchObject({ code: -32602, message: /deployment/ })
    expect(input('eth_sendTransaction', [{ from: A, to: OTHER, chainId: '0x2105' }])).toMatchObject({ code: 4901 })
    expect(input('eth_sendTransaction', [{ from: A, to: OTHER, value: 'lots' }])).toMatchObject({ code: -32602 })
    expect(input('eth_sendTransaction', [{ from: A, to: OTHER, data: 'zz' }])).toMatchObject({ code: -32602 })
    expect(input('eth_sendTransaction', [{ from: A, to: OTHER, gas: '0x5208', data: '0xa9059cbb' }])).toMatchObject({ tx: { gas: '0x5208', data: '0xa9059cbb' } })
    expect(input('eth_sign', [A, '0x00'])).toMatchObject({ code: 4200 })
  })
})

async function wallet() {
  const vault = new Vault({ storage: memoryVaultStorage() })
  const session = new Session({ storage: memorySessionStorage(), alarms: memoryAlarms() })
  await session.unlock(await vault.create('pw-pw-pw-pw'))
  const keyring = await Keyring.load({ storage: chromeKeyringStorage(memoryArea()), secrets: vaultSecretStorage(vault, session), chains: { evm: { Manager: WalletManagerEvm, config: {} } } })
  await keyring.importMnemonic(ABANDON)
  return { keyring, session }
}

function harness(keyring: Keyring) {
  const window = memoryApprovalWindow()
  let seq = 0
  const approvals = new ApprovalQueue(window, () => `r${++seq}`)
  const broadcast: string[] = []
  const rpc = vi.fn(async (_n: EvmNetwork, method: string, params: unknown[]): Promise<unknown> => {
    switch (method) {
      case 'eth_getTransactionCount': return '0x5'
      case 'eth_getBlockByNumber': return { baseFeePerGas: '0x3b9aca00' } // 1 gwei
      case 'eth_maxPriorityFeePerGas': return '0x0' // quiet node → floor applies
      case 'eth_estimateGas': return '0x5208'
      case 'eth_sendRawTransaction': broadcast.push(params[0] as string); return '0x' + 'ab'.repeat(32)
      default: throw new Error(`unexpected rpc ${method}`)
    }
  })
  let disposed = 0
  const signerFor = async (address: string) => {
    const meta = keyring.listAccounts().find((a) => a.addresses.evm?.toLowerCase() === address.toLowerCase())!
    const h = await keyring.getAccount<WalletAccountEvm>(meta.id, 'evm')
    const signer: EvmSigner = {
      signMessage: (m) => h.account.sign(m),
      signTypedData: (t) => h.account.signTypedData(t),
      signTransaction: (tx) => h.account.signTransaction(tx),
    }
    return { signer, dispose: () => { disposed++; h.dispose() } }
  }
  const preview = vi.fn(async () => ({ simulation: { status: 'ok' } }))
  const sign = createSignHandler({ approvals, rpc, signerFor, preview })
  const permissions = new PermissionStore(memoryJsonStorage<PermissionsState>())
  const router = new RequestRouter({ permissions, networks: new NetworksTable(memoryJsonStorage<EvmNetwork[]>()), approvals, accounts: async () => [A], rpc, emit: () => undefined, sign })
  return { window, approvals, rpc, broadcast, preview, router, disposed: () => disposed, call: (method: string, params: unknown) => router.handle(SITE, 'eip155', method, params), connect: async () => { const c = router.handle(SITE, 'eip155', 'eth_requestAccounts', undefined); await flush(); approvals.resolve(window.opened[0]!.id, [A]); await c } }
}

describe('sign handler', () => {
  it('eth_sendTransaction: prepared on the wallet RPC, reviewed with the preview, signed by the keyring account, broadcast; key disposed', async () => {
    const { keyring } = await wallet()
    const h = harness(keyring)
    await h.connect()
    const p = h.call('eth_sendTransaction', [{ from: A, to: OTHER, value: '0xde0b6b3a7640000', data: '0x' }])
    await flush(); await flush()
    const shown = h.window.opened[1]!
    expect(shown.kind).toBe('send-transaction')
    const payload = shown.payload as SignApproval
    expect(payload.request).toMatchObject({ kind: 'send-transaction', account: A, tx: { to: OTHER, value: '1000000000000000000' } })
    expect(payload.prepared).toEqual({ chainId: 1, nonce: 5, gasLimit: '0x6270', maxFeePerGas: '0x7d2b7500', maxPriorityFeePerGas: '0x5f5e100', maxFee: (25200n * 2_100_000_000n).toString() })
    expect(payload.preview).toEqual({ simulation: { status: 'ok' } })
    expect(h.preview).toHaveBeenCalledWith(expect.objectContaining({ network: expect.objectContaining({ caip2: 'eip155:1' }), accounts: [A] }))
    expect(h.broadcast).toEqual([]) // nothing signed before approval
    h.approvals.resolve(shown.id, null)
    expect(await p).toBe('0x' + 'ab'.repeat(32))
    expect(h.broadcast).toHaveLength(1)
    const tx = parseTransaction(h.broadcast[0] as Hex)
    expect(tx).toMatchObject({ type: 'eip1559', chainId: 1, nonce: 5, to: OTHER.toLowerCase(), value: 10n ** 18n, gas: 25200n, maxFeePerGas: 2_100_000_000n, maxPriorityFeePerGas: 100_000_000n })
    expect(h.disposed()).toBe(1)
  })

  it('decline → 4001 and nothing is signed; forged from → 4100; no `to` → -32602; typed-data chain mismatch → 4901', async () => {
    const { keyring } = await wallet()
    const h = harness(keyring)
    await h.connect()
    const p = h.call('eth_sendTransaction', [{ from: A, to: OTHER, value: '0x1' }])
    await flush(); await flush()
    h.approvals.decline(h.window.opened[1]!.id)
    expect(await failure(p)).toMatchObject({ code: 4001 })
    expect(h.broadcast).toEqual([])
    expect(h.disposed()).toBe(0)
    expect(await failure(h.call('eth_sendTransaction', [{ from: OTHER, to: A }]))).toMatchObject({ code: 4100 })
    expect(await failure(h.call('eth_sendTransaction', [{ from: A }]))).toMatchObject({ code: -32602 })
    const typed = { domain: { name: 'X', chainId: 8453 }, types: { M: [{ name: 'v', type: 'uint256' }] }, message: { v: '1' }, primaryType: 'M' }
    expect(await failure(h.call('eth_signTypedData_v4', [A, JSON.stringify(typed)]))).toMatchObject({ code: 4901 })
    expect(h.window.opened).toHaveLength(2) // refusals never open a window
  })

  it('personal_sign and typed data produce signatures that recover to the account', async () => {
    const { keyring } = await wallet()
    const h = harness(keyring)
    await h.connect()
    const m = h.call('personal_sign', ['0x68656c6c6f', A])
    await flush(); await flush()
    expect((h.window.opened[1]!.payload as SignApproval).request).toMatchObject({ kind: 'sign-message', text: 'hello' })
    h.approvals.resolve(h.window.opened[1]!.id, null)
    const sig = (await m) as Hex
    expect(await recoverMessageAddress({ message: 'hello', signature: sig })).toBe(A)

    const typed = { domain: { name: 'X', version: '1', chainId: 1 }, types: { M: [{ name: 'v', type: 'uint256' }] }, message: { v: '7' }, primaryType: 'M' as const }
    const t = h.call('eth_signTypedData_v4', [A, JSON.stringify(typed)])
    await flush(); await flush()
    h.approvals.resolve(h.window.opened[2]!.id, null)
    const tsig = (await t) as Hex
    expect(await recoverTypedDataAddress({ ...typed, message: { v: 7n }, signature: tsig })).toBe(A)
    expect(h.disposed()).toBe(2)
  })

  it('legacy-fee chain (no base fee) uses gasPrice; a page gas limit is used as is', async () => {
    const { keyring } = await wallet()
    const h = harness(keyring)
    h.rpc.mockImplementation(async (_n, method, params) => {
      switch (method) {
        case 'eth_getTransactionCount': return '0x0'
        case 'eth_getBlockByNumber': return { baseFeePerGas: null }
        case 'eth_gasPrice': return '0x3b9aca00'
        case 'eth_sendRawTransaction': h.broadcast.push(params[0] as string); return '0x' + 'cd'.repeat(32)
        default: throw new Error(`unexpected rpc ${method}`)
      }
    })
    await h.connect()
    const p = h.call('eth_sendTransaction', [{ from: A, to: OTHER, gas: '0x7530' }])
    await flush(); await flush()
    expect((h.window.opened[1]!.payload as SignApproval).prepared).toMatchObject({ gasLimit: '0x7530', gasPrice: '0x3b9aca00', maxFee: (30000n * 1_000_000_000n).toString() })
    h.approvals.resolve(h.window.opened[1]!.id, null)
    await p
    expect(parseTransaction(h.broadcast[0] as Hex)).toMatchObject({ type: 'legacy', gas: 30000n, gasPrice: 1_000_000_000n })
  })
})
