import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@forgewallet/conformance'
import { LocalSigner, UserRejectedError, deriveSecp256k1, privateKeySigner, seedFromMnemonicSync, SignerError } from '@forgewallet/core'
import { WalletManagerBtc } from '@forgewallet/wallet-btc'
import { walletOnDevice, walletsOnService, type Device } from '../src/signer.ts'

const SEED = seedFromMnemonicSync(derivationVectors.seeds['bip39-abandon-12']!)
const golden = (chain: 'evm' | 'solana' | 'btc') => derivationVectors.vectors[chain]['bip39-abandon-12']!.accounts[0]!

/** A device stand-in: a LocalSigner per path, and a user who taps approve or reject. */
function fakeDevice(approve: boolean, prompts: string[]): Device {
  const key = (path: string) => LocalSigner.leafFromSeed(SEED, 'secp256k1', path)
  return {
    publicKey: async (path) => key(path).publicKey,
    signDigest: async (path, digest, prompt) => {
      prompts.push(prompt)
      return approve ? key(path).sign(digest, { scheme: 'ecdsa-recoverable' }) : 'rejected'
    },
  }
}

/** A signing-service stand-in behind fetch: checks the token, signs with the scheme asked. */
function fakeService(token: string) {
  const secp = LocalSigner.leafFromSeed(SEED, 'secp256k1', "m/44'/60'/0'/0/0")
  const ed = LocalSigner.leafFromSeed(SEED, 'ed25519', "m/44'/501'/0'/0'")
  const contexts: (string | null)[] = []
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    if (init.headers.authorization !== `Bearer ${token}`) return new Response('', { status: 403 })
    const { payload, scheme, context } = JSON.parse(init.body) as { payload: string; scheme: 'ecdsa-recoverable' | 'ecdsa' | 'ed25519'; context: string | null }
    contexts.push(context)
    const bytes = Uint8Array.from(payload.match(/../g)!.map((x) => parseInt(x, 16)))
    const sig = await (scheme === 'ed25519' ? ed : secp).sign(bytes, { scheme })
    return Response.json({ signature: Buffer.from(sig).toString('hex') })
  }) as unknown as typeof fetch
  return { secp, ed, fetchImpl, contexts }
}

describe('Custom signer guide (docs) — offline', () => {
  it('a hardware-style signer: same address and signature as the seed, the device sees the prompt, a rejection is UserRejectedError', async () => {
    const prompts: string[] = []
    const wallet = await walletOnDevice(fakeDevice(true, prompts), { confirm: async () => true })
    const account = await wallet.getAccount('eip155:1')
    expect(await account.getAddress()).toBe(golden('evm').address)
    expect(await account.sign(derivationVectors.message)).toBe(golden('evm').signMessage)
    expect(prompts).toEqual(['Sign message'])
    const refusing = await walletOnDevice(fakeDevice(false, []), { confirm: async () => true })
    await expect((await refusing.getAccount('eip155:1')).sign('x')).rejects.toBeInstanceOf(UserRejectedError)
  })

  it('a remote signing service: EVM, Bitcoin and Solana addresses match the seed; the context reaches the service; a bad token is a refusal', async () => {
    const svc = fakeService('t0k3n')
    const service = { url: 'https://signer.example/sign', secpKey: svc.secp.publicKey, edKey: svc.ed.publicKey, fetch: svc.fetchImpl }
    const { evmAndBitcoin, solana } = walletsOnService({ ...service, token: 't0k3n' })
    {
      const evm = await evmAndBitcoin.getAccount('eip155:1')
      expect(await evm.getAddress()).toBe(golden('evm').address)
      expect(await evm.sign(derivationVectors.message)).toBe(golden('evm').signMessage)
      expect(svc.contexts).toEqual(['evm-191'])
      const btc = await evmAndBitcoin.getAccount('bip122:000000000019d6689c085ae165831e93')
      // One key serves both: the BTC address is THIS key's SegWit address, not the m/84' one a seed wallet shows.
      const sameKey = await new WalletManagerBtc(privateKeySigner('secp256k1', deriveSecp256k1(SEED, "m/44'/60'/0'/0/0").privateKey), {}).getAccount(0)
      expect(await btc.getAddress()).toBe(await sameKey.getAddress())
      expect(await btc.getAddress()).not.toBe(golden('btc').address)
      const sol = await solana.getAccount('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
      expect(await sol.getAddress()).toBe(golden('solana').address)
      await expect(evmAndBitcoin.getAccount('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).rejects.toThrow()

      const { evmAndBitcoin: wrong } = walletsOnService({ ...service, token: 'stolen' })
      await expect((await wrong.getAccount('eip155:1')).sign('x')).rejects.toBeInstanceOf(UserRejectedError)
    }
  })

  it('an external signer holds one key: account 0 only', async () => {
    const wallet = await walletOnDevice(fakeDevice(true, []), { confirm: async () => true })
    await expect(wallet.getAccount('eip155:1', 1)).rejects.toBeInstanceOf(SignerError)
  })
})
