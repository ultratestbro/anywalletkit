import { WalletManagerBtc } from '@forgewallet/wallet-btc'
import { WalletManagerEvm } from '@forgewallet/wallet-evm'
import { WalletManagerNear } from '@forgewallet/wallet-near'
import { WalletManagerSolana } from '@forgewallet/wallet-solana'
import { WalletManagerTon } from '@forgewallet/wallet-ton'
import { WalletManagerTron } from '@forgewallet/wallet-tron'
import { Keyring, type KeyringChain, type KeyringState, type KeyringStorage, type SecretStorage, type ChainKey } from '../src/index.js'

export const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

export const CHAINS: Record<ChainKey, KeyringChain> = {
  evm: { Manager: WalletManagerEvm, config: {} },
  solana: { Manager: WalletManagerSolana, config: {} },
  ton: { Manager: WalletManagerTon, config: {} },
  tron: { Manager: WalletManagerTron, config: {} },
  btc: { Manager: WalletManagerBtc, config: {} },
  near: { Manager: WalletManagerNear, config: {} },
}

export class MemoryStorage implements KeyringStorage {
  state: KeyringState | null = null
  saves = 0
  failNext = false
  async load() { return this.state ? structuredClone(this.state) : null }
  async save(s: KeyringState) {
    if (this.failNext) { this.failNext = false; throw new Error('disk full') }
    this.saves++
    this.state = structuredClone(s)
  }
}

export class MemorySecrets implements SecretStorage {
  map = new Map<string, string>()
  reads = 0
  async get(id: string) { this.reads++; return this.map.get(id) ?? null }
  async set(id: string, v: string) { this.map.set(id, v) }
  async delete(id: string) { this.map.delete(id) }
}

export async function fresh(chains: Partial<Record<ChainKey, KeyringChain>> = CHAINS) {
  const storage = new MemoryStorage()
  const secrets = new MemorySecrets()
  const keyring = await Keyring.load({ storage, secrets, chains })
  return { keyring, storage, secrets }
}
