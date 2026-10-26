import { describe, expect, it, vi } from 'vitest'
import { parseTransaction, type Hex } from 'viem'
import { Keyring } from '@anywalletkit/keyring'
import { WalletManagerEvm, type WalletAccountEvm } from '@anywalletkit/wallet-evm'
import {
  ApprovalQueue, DEFAULT_NETWORKS, NetworksTable, PermissionStore, RequestRouter, Session, Vault, chromeKeyringStorage, createSignHandler,
  memoryAlarms, memoryApprovalWindow, memoryJsonStorage, memorySessionStorage, memoryVaultStorage, toRelayError, vaultSecretStorage,
  type EvmNetwork, type EvmSigner, type PermissionsState, type SignApproval, type StorageAreaLike,
} from '../src/index.js'

// Audit 2026-10-25 round 3, M16: eth_sendTransaction read the nonce when the request arrived, before
// the review. Two requests waiting at once both showed (and signed) the same nonce: the second
// replaced the first or was refused. The nonce is now read after the approval, under a per-account
// lock, never below the wallet's own next nonce; a fee that rose past what the sheet showed asks again.

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const OTHER = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'
const SITE = 'https://dapp.example'
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) }

function memoryArea(): StorageAreaLike {
  const items = new Map<string, unknown>()
  return {
    async get(keys) { const out: Record<string, unknown> = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (items.has(k)) out[k] = structuredClone(items.get(k)); return out },
    async set(o) { for (const [k, v] of Object.entries(o)) items.set(k, structuredClone(v)) },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) items.delete(k) },
  }
}

async function keyring(): Promise<Keyring> {
  const vault = new Vault({ storage: memoryVaultStorage() })
  const session = new Session({ storage: memorySessionStorage(), alarms: memoryAlarms() })
  await session.unlock(await vault.create('pw-pw-pw-pw'))
  const k = await Keyring.load({ storage: chromeKeyringStorage(memoryArea()), secrets: vaultSecretStorage(vault, session), chains: { evm: { Manager: WalletManagerEvm, config: {} } } })
  await k.importMnemonic(ABANDON)
  return k
}

/** A node whose pending nonce lags the wallet's own broadcasts (load-balanced RPC, slow mempool view). */
function harness(k: Keyring, node: { nonce: bigint; baseFee: bigint }) {
  const window = memoryApprovalWindow()
  let seq = 0
  const approvals = new ApprovalQueue(window, () => `r${++seq}`)
  const sent: Hex[] = []
  const rpc = vi.fn(async (_n: EvmNetwork, method: string, params: unknown[]): Promise<unknown> => {
    switch (method) {
      case 'eth_getTransactionCount': return `0x${node.nonce.toString(16)}`
      case 'eth_getBlockByNumber': return { baseFeePerGas: `0x${node.baseFee.toString(16)}` }
      case 'eth_maxPriorityFeePerGas': return '0x0'
      case 'eth_estimateGas': return '0x5208'
      case 'eth_sendRawTransaction': sent.push(params[0] as Hex); return `0x${String(sent.length).padStart(64, '0')}`
      default: throw new Error(`unexpected rpc ${method}`)
    }
  })
  const signerFor = async (address: string) => {
    const meta = k.listAccounts().find((a) => a.addresses.evm?.toLowerCase() === address.toLowerCase())!
    const h = await k.getAccount<WalletAccountEvm>(meta.id, 'evm')
    const signer: EvmSigner = { signMessage: (m) => h.account.sign(m), signTypedData: (t) => h.account.signTypedData(t), signTransaction: (tx) => h.account.signTransaction(tx) }
    return { signer, dispose: () => h.dispose() }
  }
  const sign = createSignHandler({ approvals, rpc, signerFor })
  const permissions = new PermissionStore(memoryJsonStorage<PermissionsState>())
  const router = new RequestRouter({ permissions, networks: new NetworksTable(memoryJsonStorage<EvmNetwork[]>()), approvals, accounts: async () => [A], rpc, emit: () => undefined, sign })
  const send = (value: string) => router.handle(SITE, 'eip155', 'eth_sendTransaction', [{ from: A, to: OTHER, value }])
  const connect = async () => { const c = router.handle(SITE, 'eip155', 'eth_requestAccounts', undefined); await flush(); approvals.resolve(window.opened[0]!.id, [A]); await c }
  return { window, approvals, sent, send, connect, nonces: () => sent.map((r) => parseTransaction(r).nonce) }
}

describe('eth_sendTransaction: the nonce is taken after the review', () => {
  it('two requests waiting at once get consecutive nonces even when the node has not seen the first yet', async () => {
    const node = { nonce: 5n, baseFee: 1_000_000_000n }
    const h = harness(await keyring(), node)
    await h.connect()
    const first = h.send('0x1')
    const second = h.send('0x2')
    await flush()
    h.approvals.resolve(h.window.opened[1]!.id, null)
    await first
    await flush()
    h.approvals.resolve(h.window.opened[2]!.id, null)
    await second
    expect(h.nonces()).toEqual([5, 6])
  })

  it('a nonce the node moved on to (a send from another wallet) is the one signed', async () => {
    const node = { nonce: 5n, baseFee: 1_000_000_000n }
    const h = harness(await keyring(), node)
    await h.connect()
    const p = h.send('0x1')
    await flush()
    node.nonce = 9n // the same seed sent from another device while the sheet was open
    h.approvals.resolve(h.window.opened[1]!.id, null)
    await p
    expect(h.nonces()).toEqual([9])
  })

  it('approvals answered in any order still sign one after another, never the same nonce', async () => {
    const node = { nonce: 0n, baseFee: 1_000_000_000n }
    const h = harness(await keyring(), node)
    await h.connect()
    const ps = [h.send('0x1'), h.send('0x2')]
    await flush()
    h.approvals.resolve(h.window.opened[1]!.id, null)
    await flush()
    h.approvals.resolve(h.window.opened[2]!.id, null)
    await Promise.all(ps)
    expect(new Set(h.nonces()).size).toBe(2)
  })

  it('a base fee that outgrew the fee cap on the sheet asks again with the new numbers', async () => {
    const node = { nonce: 1n, baseFee: 1_000_000_000n }
    const h = harness(await keyring(), node)
    await h.connect()
    const p = h.send('0x1')
    await flush()
    const shown = (h.window.opened[1]!.payload as SignApproval).prepared!
    node.baseFee = 3_000_000_000n // the shown cap (2 × 1 gwei + tip) no longer covers base + tip
    h.approvals.resolve(h.window.opened[1]!.id, null)
    await flush()
    expect(h.sent).toHaveLength(0)
    const again = h.window.opened[2]!
    expect(again.kind).toBe('send-transaction')
    const fresh = (again.payload as SignApproval).prepared!
    expect(BigInt(fresh.maxFee)).toBeGreaterThan(BigInt(shown.maxFee))
    h.approvals.resolve(again.id, null)
    await p
    expect(parseTransaction(h.sent[0]!).maxFeePerGas).toBe(BigInt(fresh.maxFeePerGas!))
  })

  it('declining the second sheet sends nothing; a small base-fee rise inside the cap signs what was shown', async () => {
    const node = { nonce: 1n, baseFee: 1_000_000_000n }
    const h = harness(await keyring(), node)
    await h.connect()
    const p = h.send('0x1')
    await flush()
    node.baseFee = 3_000_000_000n
    h.approvals.resolve(h.window.opened[1]!.id, null)
    await flush()
    h.approvals.decline(h.window.opened[2]!.id)
    expect(await p.then(() => null, (e: unknown) => toRelayError(e))).toMatchObject({ code: 4001 })
    expect(h.sent).toHaveLength(0)

    node.baseFee = 1_000_000_000n
    const q = h.send('0x1')
    await flush()
    const shown = (h.window.opened[3]!.payload as SignApproval).prepared!
    node.baseFee = 1_200_000_000n // +20 %: still under the shown 2 × base + tip
    h.approvals.resolve(h.window.opened[3]!.id, null)
    await q
    expect(h.window.opened).toHaveLength(4)
    expect(parseTransaction(h.sent[0]!).maxFeePerGas).toBe(BigInt(shown.maxFeePerGas!))
  })
})
