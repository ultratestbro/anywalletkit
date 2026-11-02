import { describe, expect, it, vi } from 'vitest'
import { parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { Keyring } from '@anywalletkit/keyring'
import { WalletManagerEvm, type WalletAccountEvm } from '@anywalletkit/wallet-evm'
import {
  ApprovalQueue, DEFAULT_NETWORKS, NetworksTable, PermissionStore, RequestRouter, Session, Vault, chromeKeyringStorage, createSignHandler,
  memoryAlarms, memoryApprovalWindow, memoryJsonStorage, memorySessionStorage, memoryVaultStorage, toRelayError, vaultSecretStorage,
  type EvmNetwork, type EvmSigner, type PermissionsState, type SignApproval, type StorageAreaLike,
} from '../src/index.js'

// A fee cap shown during a spike that passed while the sheet was open (base fee down more than 4x)
// is lowered to the current fees at signing, with no second sheet: a signer that holds caller-set
// fees against the network quote (a provider-backed WalletAccountEvm) then signs what was approved.

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

const BLOCK = { number: '0x10', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
/** EIP-1193 view of the same node, for a provider-backed signing account. */
function nodeProvider(node: { baseFee: bigint }): EIP1193Provider {
  const tip = 1_000_000_000n
  return { request: async ({ method }: { method: string }) => {
    switch (method) {
      case 'eth_chainId': return '0x1'
      case 'eth_getBlockByNumber': return { ...BLOCK, baseFeePerGas: `0x${node.baseFee.toString(16)}` }
      case 'eth_maxPriorityFeePerGas': return `0x${tip.toString(16)}`
      case 'eth_gasPrice': return `0x${(node.baseFee + tip).toString(16)}`
      default: throw new Error(`unexpected rpc ${method}`)
    }
  } } as unknown as EIP1193Provider
}

/** A node whose pending nonce lags the wallet's own broadcasts (load-balanced RPC, slow mempool view). */
function harness(k: Keyring, node: { nonce: bigint; baseFee: bigint }, withProvider = false) {
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
    if (withProvider) {
      // The integrator's own provider-backed account: its fee-rate check reads the same node.
      const account = await new WalletManagerEvm(ABANDON, { provider: nodeProvider(node), chainId: 1 }).getAccount(0)
      const signer: EvmSigner = { signMessage: (m) => account.sign(m), signTypedData: (t) => account.signTypedData(t), signTransaction: (tx) => account.signTransaction(tx) }
      return { signer, dispose: () => account.dispose() }
    }
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

const GWEI = 1_000_000_000n

describe('eth_sendTransaction: a cap from a passed fee spike', () => {
  for (const withProvider of [false, true]) {
    it(`base fee falls 300 → 30 gwei while the sheet is open: signed at the current fees, no second sheet${withProvider ? ' (provider-backed signer)' : ''}`, async () => {
      const node = { nonce: 1n, baseFee: 300n * GWEI }
      const h = harness(await keyring(), node, withProvider)
      await h.connect()
      const p = h.send('0x1')
      await flush()
      const shown = (h.window.opened[1]!.payload as SignApproval).prepared!
      node.baseFee = 30n * GWEI
      h.approvals.resolve(h.window.opened[1]!.id, null)
      await p
      expect(h.window.opened).toHaveLength(2)
      const signed = parseTransaction(h.sent[0]!)
      expect(signed.maxFeePerGas).toBeLessThan(BigInt(shown.maxFeePerGas!))
      expect(signed.maxFeePerGas).toBe(2n * 30n * GWEI + 100_000_000n) // 2 × base + the 0.1 gwei tip floor
    })
  }

  it('control: a fall inside 4x keeps the cap that was shown', async () => {
    const node = { nonce: 1n, baseFee: 30n * GWEI }
    const h = harness(await keyring(), node)
    await h.connect()
    const p = h.send('0x1')
    await flush()
    const shown = (h.window.opened[1]!.payload as SignApproval).prepared!
    node.baseFee = 10n * GWEI
    h.approvals.resolve(h.window.opened[1]!.id, null)
    await p
    expect(parseTransaction(h.sent[0]!).maxFeePerGas).toBe(BigInt(shown.maxFeePerGas!))
  })
})
