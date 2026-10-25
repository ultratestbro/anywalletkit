import { describe, expect, it } from 'vitest'
import { deriveEd25519, deriveSecp256k1, privateKeySigner, seedFromMnemonicSync, type IWalletAccount, type Signer, type SignerCurve, type WalletManager } from '@anywalletkit/core'
import { type ChainKey, derivationVectors } from './vectors.js'

export interface ChainSuiteOptions<M extends WalletManager<IWalletAccount, object>> {
  /** Which vector set to compare against. */
  chain: ChainKey
  /** Build a manager for a seed. Must NOT need the network for getAccount/getAddress/sign. */
  create: (seed: string) => M | Promise<M>
  /** Compare the recorded `sign(message)` encoding too (default true). */
  checkSignMessage?: boolean
  /** Hex of the account's public key; omit if the account does not expose one. */
  publicKeyOf?: (account: IWalletAccount) => Promise<Uint8Array | string | undefined>
  /** Build a manager from a Signer (multi-keyring import). With `curve`, the single-key account rules are checked. */
  fromSigner?: (signer: Signer) => M | Promise<M>
  curve?: SignerCurve
}

/**
 * The conformance suite every chain package must pass. Call it inside a test
 * file; it registers `describe`/`it` blocks with vitest.
 */
export function describeChainModule<M extends WalletManager<IWalletAccount, object>>(name: string, o: ChainSuiteOptions<M>): void {
  const sets = derivationVectors.vectors[o.chain]
  describe(`${name}: conformance (${o.chain})`, () => {
    for (const [seedName, set] of Object.entries(sets)) {
      const mnemonic = derivationVectors.seeds[seedName]!
      describe(seedName, () => {
        for (const vec of set.accounts) {
          it(`account #${vec.index} resolves the pinned address ${vec.address}`, async () => {
            const m = await o.create(mnemonic)
            try {
              const a = await m.getAccount(vec.index)
              expect(await a.getAddress()).toBe(vec.address)
              expect(await (await m.getAccountByPath(vec.path)).getAddress()).toBe(vec.address)
              if (o.publicKeyOf) {
                const pk = await o.publicKeyOf(a)
                const hex = pk instanceof Uint8Array ? Array.from(pk, (b) => b.toString(16).padStart(2, '0')).join('') : pk
                expect(hex).toBe(vec.publicKey)
              }
              if (o.checkSignMessage !== false) expect(await a.sign(derivationVectors.message)).toBe(vec.signMessage)
            } finally { m.dispose() }
          })
        }
      })
    }

    it('read-only account cannot sign', async () => {
      const m = await o.create(derivationVectors.seeds['bip39-abandon-12']!)
      try {
        const ro = (await m.getAccount(0)).toReadOnlyAccount() as Partial<IWalletAccount>
        expect(ro.sendTransaction).toBeUndefined()
        expect(ro.sign).toBeUndefined()
        expect(ro.signTransaction).toBeUndefined()
      } finally { m.dispose() }
    })

    it('dispose() makes the account unusable', async () => {
      const m = await o.create(derivationVectors.seeds['bip39-abandon-12']!)
      const a = await m.getAccount(0)
      m.dispose()
      await expect(a.sign('after dispose')).rejects.toThrow()
    })

    it('no private key, seed or phrase is reachable from the manager or the account (logs, serializers, crash reports)', async () => {
      const mnemonic = derivationVectors.seeds['bip39-abandon-12']!
      const vec = sets['bip39-abandon-12']!.accounts[0]!
      const seed = seedFromMnemonicSync(mnemonic)
      const key = (CURVES[o.chain] === 'secp256k1' ? deriveSecp256k1(seed, vec.path) : deriveEd25519(seed, vec.path)).privateKey
      const m = await o.create(mnemonic)
      try {
        const a = await m.getAccount(0)
        await a.getAddress()
        // After a signature too: anything a chain caches lazily while signing (a keypair, an encoded secret) is walked as well.
        await a.sign('secret walk')
        for (const root of [m, a]) {
          const found = findSecret(root, [key, seed], mnemonic)
          expect(found, `secret reachable at ${found}`).toBeUndefined()
        }
      } finally { m.dispose() }
    })

    it('accounts 0..4 from one seed are distinct and stable (multi-account)', async () => {
      const m = await o.create(derivationVectors.seeds['bip39-abandon-12']!)
      try {
        const first: string[] = []
        for (let i = 0; i < 5; i++) first.push(await (await m.getAccount(i)).getAddress())
        expect(new Set(first).size).toBe(5)
        for (let i = 4; i >= 0; i--) expect(await (await m.getAccount(i)).getAddress()).toBe(first[i])
      } finally { m.dispose() }
    })

    if (o.fromSigner && o.curve) {
      const fromSigner = o.fromSigner
      const curve = o.curve
      it('an imported private key is exactly one account, unusable after dispose', async () => {
        const key = new Uint8Array(32).fill(7)
        const m = await fromSigner(privateKeySigner(curve, key))
        const a = await m.getAccount(0)
        expect(await a.getAddress()).toBeTruthy()
        await expect(m.getAccount(1)).rejects.toThrow()
        m.dispose()
        expect(key.every((b) => b === 0)).toBe(true) // the key buffer is zeroized
        await expect(a.sign('after dispose')).rejects.toThrow()
      })

      it('one account per path under concurrent calls; none is handed out once dispose() ran', async () => {
        // A signer whose public key arrives later (a hardware wallet, MPC, a backend) and whose
        // dispose() does not stop it signing: the manager itself must refuse.
        const slow = () => {
          const inner = privateKeySigner(curve, new Uint8Array(32).fill(9))
          let release!: () => void
          const gate = new Promise<void>((r) => { release = r })
          const signer: Signer = {
            kind: 'external', curve, schemes: inner.schemes,
            getPublicKey: async () => { await gate; return inner.getPublicKey() },
            sign: (payload, options) => inner.sign(payload, options),
            dispose: () => undefined,
          }
          return { signer, release }
        }
        const one = slow()
        const m = await fromSigner(one.signer)
        const pair = Promise.all([m.getAccount(0), m.getAccount(0)])
        one.release()
        const [a, b] = await pair
        expect(a).toBe(b)
        m.dispose()

        const two = slow()
        const late = await fromSigner(two.signer)
        const pending = late.getAccount(0)
        late.dispose()
        two.release()
        await expect(pending).rejects.toThrow()
        await expect(late.getAccount(0)).rejects.toThrow()
      })
    }

    it('rejects an invalid seed phrase', async () => {
      await expect(Promise.resolve().then(() => o.create('not a seed phrase at all'))).rejects.toThrow()
    })
  })
}

const CURVES: Record<ChainKey, SignerCurve> = { evm: 'secp256k1', btc: 'secp256k1', tron: 'secp256k1', zcash: 'secp256k1', solana: 'ed25519', ton: 'ed25519', near: 'ed25519' }

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** Same bytes, or `needle` inside `hay` (a key embedded in a 64-byte ed25519 secret). */
function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

/**
 * Walks every own property (enumerable or not, string or symbol keys), Map and
 * Set entries, and array items reachable from `root`, the way a logger, a
 * serializer or a crash reporter would. Returns the path of the first secret
 * found: a byte array holding a secret, or a string holding its hex or the words.
 */
function findSecret(root: unknown, secrets: Uint8Array[], mnemonic: string): string | undefined {
  const hexes = secrets.map(toHex)
  const seen = new Set<unknown>()
  const visit = (v: unknown, path: string, depth: number): string | undefined => {
    if (typeof v === 'string') {
      const low = v.toLowerCase()
      return hexes.some((h) => low.includes(h)) || v.includes(mnemonic) ? path : undefined
    }
    if (typeof v !== 'object' || v === null || seen.has(v) || depth > 12) return undefined
    seen.add(v)
    if (v instanceof Uint8Array) return secrets.some((s) => containsBytes(v, s)) ? path : undefined
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return undefined
    if (v instanceof Map) {
      for (const [k, x] of v) { const hit = visit(k, `${path}<key>`, depth + 1) ?? visit(x, `${path}.get(${String(k)})`, depth + 1); if (hit) return hit }
      return undefined
    }
    if (v instanceof Set) {
      for (const x of v) { const hit = visit(x, `${path}<item>`, depth + 1); if (hit) return hit }
      return undefined
    }
    for (const k of Reflect.ownKeys(v)) {
      let x: unknown
      try { x = (v as Record<PropertyKey, unknown>)[k] } catch { continue }
      if (typeof x === 'function') continue
      const hit = visit(x, `${path}.${String(k)}`, depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  return visit(root, 'root', 0)
}
