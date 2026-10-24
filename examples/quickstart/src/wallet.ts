// The Quickstart page of docs.anywallet.tech renders the #region blocks of this file.
// Keep every region self-explanatory: it is read on its own, without the rest of the file.

// #region imports
import { Wallet, type Policies } from '@anywalletkit/kit'
import { getRandomSeedPhrase, isValidSeedPhrase } from '@anywalletkit/core'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import { WalletManagerBtc } from '@anywalletkit/wallet-btc'
import { WalletManagerSolana } from '@anywalletkit/wallet-solana'
import { WalletManagerTon } from '@anywalletkit/wallet-ton'
import { WalletManagerTron } from '@anywalletkit/wallet-tron'
import { WalletManagerNear } from '@anywalletkit/wallet-near'
// #endregion imports

// #region chains
// CAIP-2 chain ids: one string names a chain on any ecosystem.
export const ETHEREUM = 'eip155:1'
export const BASE = 'eip155:8453'
export const BITCOIN = 'bip122:000000000019d6689c085ae165831e93'
export const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
export const TON = 'ton:-239'
export const TRON = 'tron:0x2b6653dc'
export const NEAR = 'near:mainnet'
// #endregion chains

// #region seed
export function newSeedPhrase(): string {
  return getRandomSeedPhrase(12) // or 24
}

export function checkSeedPhrase(words: string): boolean {
  return isValidSeedPhrase(words) // BIP-39 wordlist + checksum
}
// #endregion seed

// #region create
export function createWallet(seedPhrase: string, policies?: Policies): Wallet {
  const wallet = new Wallet(seedPhrase, policies ? { policies } : {})

  // One EVM registration per network: each has its own RPC.
  wallet.registerWallet(ETHEREUM, WalletManagerEvm, { provider: 'https://ethereum-rpc.publicnode.com' })
  wallet.registerWallet(BASE, WalletManagerEvm, { provider: 'https://base-rpc.publicnode.com' })

  // Other ecosystems register by namespace.
  wallet.registerWallet('bip122', WalletManagerBtc, {
    client: { type: 'esplora-http', clientConfig: { url: 'https://mempool.space/api' } },
  })
  wallet.registerWallet('solana', WalletManagerSolana, { provider: 'https://api.mainnet-beta.solana.com' })
  wallet.registerWallet('ton', WalletManagerTon, { tonClient: { url: 'https://toncenter.com/api/v2/jsonRPC' } })
  wallet.registerWallet('tron', WalletManagerTron, { provider: 'https://api.trongrid.io' })
  wallet.registerWallet('near', WalletManagerNear, { provider: 'https://free.rpc.fastnear.com' })

  return wallet
}
// #endregion create

// #region addresses
export async function addresses(wallet: Wallet): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const chain of [ETHEREUM, BASE, BITCOIN, SOLANA, TON, TRON, NEAR]) {
    const account = await wallet.getAccount(chain) // account #0; getAccount(chain, 1) for the next one
    out[chain] = await account.getAddress()
  }
  return out
}
// #endregion addresses

// #region balance
export async function ethBalance(wallet: Wallet): Promise<bigint> {
  const account = await wallet.getAccount(ETHEREUM)
  return account.getBalance() // wei, as bigint
}

export async function usdtBalance(wallet: Wallet): Promise<bigint> {
  const account = await wallet.getAccount(ETHEREUM)
  return account.getTokenBalance('0xdAC17F958D2ee523a2206206994597C13D831ec7') // USDT, 6 decimals
}
// #endregion balance

// #region transfer
export async function sendUsdt(wallet: Wallet, recipient: string, amount: bigint) {
  const account = await wallet.getAccount(ETHEREUM)
  const transfer = { token: '0xdAC17F958D2ee523a2206206994597C13D831ec7', recipient, amount }

  const { fee } = await account.quoteTransfer(transfer) // network fee in wei, nothing is signed
  console.log('fee', fee)

  const { hash } = await account.transfer(transfer) // simulate → sign → broadcast
  const receipt = await account.getTransactionReceipt(hash) // undefined until mined
  return { hash, receipt }
}
// #endregion transfer

// #region sign
export async function signIn(wallet: Wallet, message: string) {
  const account = await wallet.getAccount(ETHEREUM)
  const signature = await account.sign(message) // EIP-191 personal_sign
  const valid = await account.verify(message, signature)
  return { signature, valid }
}
// #endregion sign

// #region policies
export const policies: Policies = {
  // Refuse any Ethereum write whose quoted fee is above 0.005 ETH.
  maxFee: { [ETHEREUM]: 5_000_000_000_000_000n },
  // Never send to these addresses.
  blocklist: { [ETHEREUM]: ['0x000000000000000000000000000000000000dEaD'] },
  // The last word before anything is signed: show your confirmation sheet here.
  confirm: async (intent) => {
    console.log(`${intent.method} on ${intent.chain} → ${intent.to ?? 'contract'}`)
    return true
  },
}
// #endregion policies
