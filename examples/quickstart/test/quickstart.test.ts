import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@forgewallet/conformance'
import { PolicyViolationError } from '@forgewallet/kit'
import { UserRejectedError } from '@forgewallet/core'
import { BASE, BITCOIN, ETHEREUM, NEAR, SOLANA, TON, TRON, addresses, checkSeedPhrase, createWallet, newSeedPhrase, policies, signIn } from '../src/wallet.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!
const golden = (chain: keyof typeof derivationVectors.vectors) => derivationVectors.vectors[chain]['bip39-abandon-12']!.accounts[0]!.address

describe('Quickstart (docs) — offline', () => {
  it('seed phrases', () => {
    const words = newSeedPhrase()
    expect(words.split(' ')).toHaveLength(12)
    expect(checkSeedPhrase(words)).toBe(true)
    expect(checkSeedPhrase('abandon abandon abandon')).toBe(false)
  })

  it('addresses match the golden vectors on every chain', async () => {
    const wallet = createWallet(SEED)
    try {
      const a = await addresses(wallet)
      expect(a[ETHEREUM]).toBe(golden('evm'))
      expect(a[BASE]).toBe(golden('evm')) // same key on every EVM network
      expect(a[BITCOIN]).toBe(golden('btc'))
      expect(a[SOLANA]).toBe(golden('solana'))
      expect(a[TON]).toBe(golden('ton'))
      expect(a[TRON]).toBe(golden('tron'))
      expect(a[NEAR]).toBe(golden('near'))
    } finally {
      wallet.dispose()
    }
  })

  it('signs and verifies a message', async () => {
    const wallet = createWallet(SEED)
    try {
      const { signature, valid } = await signIn(wallet, derivationVectors.message)
      expect(signature).toBe(derivationVectors.vectors.evm['bip39-abandon-12']!.accounts[0]!.signMessage)
      expect(valid).toBe(true)
    } finally {
      wallet.dispose()
    }
  })

  it('policies: blocklist refuses before anything is signed', async () => {
    const wallet = createWallet(SEED, { blocklist: policies.blocklist! })
    try {
      const eth = await wallet.getAccount(ETHEREUM)
      await expect(eth.transfer({ recipient: '0x000000000000000000000000000000000000dEaD', amount: 1n }))
        .rejects.toBeInstanceOf(PolicyViolationError)
    } finally {
      wallet.dispose()
    }
  })

  it('policies: confirm = false rejects the write', async () => {
    const wallet = createWallet(SEED, { confirm: () => false })
    try {
      const eth = await wallet.getAccount(ETHEREUM)
      await expect(eth.sign('hello')).rejects.toBeInstanceOf(UserRejectedError)
    } finally {
      wallet.dispose()
    }
  })
})
