/**
 * Hermes smoke: derive + sign on every chain the way the SDK does, inside the
 * Hermes VM (no Node, no browser APIs). Compares against the golden
 * vectors and prints HERMES_SMOKE_OK. Bundled by run.mjs.
 */
import './shim-globals.js'
import 'fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js'
import './shim-runtime.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { deriveEd25519, deriveSecp256k1, seedFromMnemonicSync } from '@forgewallet/core'
import { derivationVectors } from '@forgewallet/conformance'
import { WalletManagerEvm } from '@forgewallet/wallet-evm'
import { WalletManagerSolana } from '@forgewallet/wallet-solana'
import { WalletManagerTon } from '@forgewallet/wallet-ton'
import { WalletManagerTron } from '@forgewallet/wallet-tron'
import { WalletManagerBtc } from '@forgewallet/wallet-btc'

declare const print: ((s: string) => void) | undefined
const out = (s: string) => (typeof print === 'function' ? print(s) : console.log(s))

let checks = 0
const eq = (what: string, a: unknown, b: unknown) => {
  if (a !== b) throw new Error(`${what}: ${String(a)} !== ${String(b)}`)
  checks++
}

async function main() {
  for (const [seedName, mnemonic] of Object.entries(derivationVectors.seeds)) {
    const seed = seedFromMnemonicSync(mnemonic)
    for (const chain of ['evm', 'btc', 'tron'] as const) {
      for (const v of derivationVectors.vectors[chain][seedName]!.accounts) eq(`${chain} pub`, bytesToHex(deriveSecp256k1(seed, v.path).publicKey), v.publicKey)
    }
    for (const chain of ['ton', 'solana'] as const) {
      for (const v of derivationVectors.vectors[chain][seedName]!.accounts) eq(`${chain} pub`, bytesToHex(deriveEd25519(seed, v.path).publicKey), v.publicKey)
    }
    const evm = new WalletManagerEvm(mnemonic)
    for (const v of derivationVectors.vectors.evm[seedName]!.accounts) {
      const a = await evm.getAccount(v.index)
      eq('evm address', await a.getAddress(), v.address)
      eq('evm sign', await a.sign(derivationVectors.message), v.signMessage)
      const tx = derivationVectors.evmTx as Record<string, string | number>
      eq('evm signTransaction', await a.signTransaction({ ...tx, value: BigInt(tx.value!), gasLimit: BigInt(tx.gasLimit!), maxFeePerGas: BigInt(tx.maxFeePerGas!), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas!) } as never), v.signTransaction)
      eq('evm signTypedData', await a.signTypedData(derivationVectors.evmTypedData as never), v.signTypedData)
    }
    evm.dispose()
    const sol = new WalletManagerSolana(mnemonic)
    for (const v of derivationVectors.vectors.solana[seedName]!.accounts) {
      const a = await sol.getAccount(v.index)
      eq('solana address', await a.getAddress(), v.address)
      eq('solana sign', await a.sign(derivationVectors.message), v.signMessage)
    }
    sol.dispose()
    const ton = new WalletManagerTon(mnemonic)
    for (const v of derivationVectors.vectors.ton[seedName]!.accounts) {
      const a = await ton.getAccount(v.index)
      eq('ton address', await a.getAddress(), v.address)
      eq('ton sign', await a.sign(derivationVectors.message), v.signMessage)
    }
    ton.dispose()
    const tron = new WalletManagerTron(mnemonic)
    for (const v of derivationVectors.vectors.tron[seedName]!.accounts) {
      const a = await tron.getAccount(v.index)
      eq('tron address', await a.getAddress(), v.address)
      eq('tron sign', await a.sign(derivationVectors.message), v.signMessage)
    }
    tron.dispose()
    const btc = new WalletManagerBtc(mnemonic, { network: 'bitcoin' })
    for (const v of derivationVectors.vectors.btc[seedName]!.accounts) {
      const a = await btc.getAccount(v.index)
      eq('btc address', await a.getAddress(), v.address)
      eq('btc sign', await a.sign(derivationVectors.message), v.signMessage)
    }
    btc.dispose()
  }
  out(`HERMES_SMOKE_OK ${checks}`)
}

main().catch((e) => { out(`HERMES_SMOKE_FAIL ${e instanceof Error ? e.stack ?? e.message : String(e)}`) })
