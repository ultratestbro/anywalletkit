import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { LocalSigner, seedFromMnemonicSync } from '@forgewallet/core'
import {
  WalletAccountNear, WalletAccountReadOnlyNear, decodeAnyTransaction, decodeSignedTransaction, decodeTransaction, describeTransaction, encodeSignedTransaction,
  encodeTransaction, fromBase64, nep413Bytes, parsePublicKey, publicKeyToString, toBase64, type NearBuiltTransaction,
} from '../src/index.js'

// Golden values recorded with @near-js/transactions + @near-js/crypto (scratch script, 2026-10-10):
// account 0 of the BIP-39 "abandon…about" seed at m/44'/397'/0', nonce 42, block hash 0x07×32,
// actions [storage_deposit(alice.near, 0.00125 NEAR, 30 Tgas), ft_transfer(alice.near, 1500000, "hi", 1 yocto, 30 Tgas), transfer(123456789)].
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ACCOUNT0 = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
const PUBSTR = 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25'
const TXHEX = '4000000035353130653262343463616536656238303765336530653435643537396464613035386332373461626362613135653563623834363336663564316565343132005510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee4122a0000000000000016000000757364742e7465746865722d746f6b656e2e6e656172070707070707070707070707070707070707070707070707070707070707070703000000020f00000073746f726167655f6465706f736974340000007b226163636f756e745f6964223a22616c6963652e6e656172222c22726567697374726174696f6e5f6f6e6c79223a747275657d00e057eb481b00000000485637193cc34300000000000000020b00000066745f7472616e736665723b0000007b2272656365697665725f6964223a22616c6963652e6e656172222c22616d6f756e74223a2231353030303030222c226d656d6f223a226869227d00e057eb481b0000010000000000000000000000000000000315cd5b07000000000000000000000000'
const TXHASH = '9FyX8T923vdCntjLuem9AmuiYPpokUFPxGS5zRt1EpqV'
const SIGNEDB64 = 'QAAAADU1MTBlMmI0NGNhZTZlYjgwN2UzZTBlNDVkNTc5ZGRhMDU4YzI3NGFiY2JhMTVlNWNiODQ2MzZmNWQxZWU0MTIAVRDitEyubrgH4+DkXVed2gWMJ0q8uhXly4Rjb10e5BIqAAAAAAAAABYAAAB1c2R0LnRldGhlci10b2tlbi5uZWFyBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcDAAAAAg8AAABzdG9yYWdlX2RlcG9zaXQ0AAAAeyJhY2NvdW50X2lkIjoiYWxpY2UubmVhciIsInJlZ2lzdHJhdGlvbl9vbmx5Ijp0cnVlfQDgV+tIGwAAAABIVjcZPMNDAAAAAAAAAAILAAAAZnRfdHJhbnNmZXI7AAAAeyJyZWNlaXZlcl9pZCI6ImFsaWNlLm5lYXIiLCJhbW91bnQiOiIxNTAwMDAwIiwibWVtbyI6ImhpIn0A4FfrSBsAAAEAAAAAAAAAAAAAAAAAAAADFc1bBwAAAAAAAAAAAAAAAAD9+73nt2MMQmzSd210sPiJhNn62sLQhq59eRdnl+FctcuniRFX6MAJzsW0RYetdx/E0C9MXzkEHIsgoa2HAqMI'

const built = (): NearBuiltTransaction => ({
  signerId: ACCOUNT0,
  publicKey: parsePublicKey(PUBSTR),
  nonce: 42n,
  receiverId: 'usdt.tether-token.near',
  blockHash: new Uint8Array(32).fill(7),
  actions: [
    { functionCall: { methodName: 'storage_deposit', args: { account_id: 'alice.near', registration_only: true }, gas: 30_000_000_000_000n, deposit: 1_250_000_000_000_000_000_000n } },
    { functionCall: { methodName: 'ft_transfer', args: { receiver_id: 'alice.near', amount: '1500000', memo: 'hi' }, gas: 30_000_000_000_000n, deposit: 1n } },
    { transfer: { deposit: 123_456_789n } },
  ],
})

describe('borsh', () => {
  it('encodes a transaction exactly like @near-js/transactions and hashes it to the same tx hash', () => {
    const tx = built()
    expect(bytesToHex(encodeTransaction(tx))).toBe(TXHEX)
    expect(WalletAccountReadOnlyNear.txHash(tx)).toBe(TXHASH)
    expect(publicKeyToString(tx.publicKey)).toBe(PUBSTR)
    expect(bytesToHex(tx.publicKey.data)).toBe(ACCOUNT0)
  })

  it('round-trips through decode', () => {
    const tx = decodeTransaction(hexToBytes(TXHEX))
    expect(tx.signerId).toBe(ACCOUNT0)
    expect(tx.nonce).toBe(42n)
    expect(tx.receiverId).toBe('usdt.tether-token.near')
    expect(tx.actions).toHaveLength(3)
    expect(bytesToHex(encodeTransaction(tx))).toBe(TXHEX)
    const d = describeTransaction(tx, { signerId: ACCOUNT0 })
    expect(d.kind).toBe('batch') // ft_transfer + storage_deposit + a native transfer
    expect(d.methods).toEqual(['storage_deposit', 'ft_transfer'])
    expect(d.deposit).toBe(1_250_000_000_000_000_000_000n + 1n + 123_456_789n)
  })

  it('signs sha256(borsh) with the seed key and matches the reference signed transaction byte for byte', async () => {
    const signer = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'ed25519', "m/44'/397'/0'")
    const a = new WalletAccountNear(signer, signer.publicKey, "m/44'/397'/0'")
    expect(a.address).toBe(ACCOUNT0)
    const signed = await a.signBuilt(built())
    expect(toBase64(encodeSignedTransaction(signed))).toBe(SIGNEDB64)
    const back = decodeSignedTransaction(fromBase64(SIGNEDB64))
    expect(back.signature.keyType).toBe('ed25519')
    expect(bytesToHex(back.signature.data)).toBe(bytesToHex(signed.signature.data))
    const any = decodeAnyTransaction(hexToBytes(TXHEX))
    expect(any.signature).toBeUndefined()
    a.dispose()
  })

  it('decodes every action variant it encodes (dangerous ones included)', () => {
    const pk = parsePublicKey(PUBSTR)
    const tx: NearBuiltTransaction = {
      ...built(),
      actions: [
        { createAccount: {} },
        { deployContract: { code: new Uint8Array([1, 2, 3]) } },
        { stake: { stake: 5n, publicKey: pk } },
        { addKey: { publicKey: pk, accessKey: { nonce: 0n, permission: { functionCall: { allowance: 10n, receiverId: 'x.near', methodNames: ['a', 'b'] } } } } },
        { addKey: { publicKey: pk, accessKey: { nonce: 1n, permission: { fullAccess: {} } } } },
        { deleteKey: { publicKey: pk } },
        { deleteAccount: { beneficiaryId: 'bob.near' } },
        { deployGlobalContract: { code: new Uint8Array([9]), deployMode: 'accountId' } },
        { useGlobalContract: { accountId: 'lib.near' } },
        { useGlobalContract: { codeHash: new Uint8Array(32).fill(3) } },
        { signedDelegate: { delegateAction: { senderId: 'a.near', receiverId: 'b.near', actions: [{ transfer: { deposit: 1n } }], nonce: 7n, maxBlockHeight: 99n, publicKey: pk }, signature: { keyType: 'ed25519', data: new Uint8Array(64).fill(4) } } },
      ],
    }
    const bytes = encodeTransaction(tx)
    const back = decodeTransaction(bytes)
    expect(bytesToHex(encodeTransaction(back))).toBe(bytesToHex(bytes))
    const d = describeTransaction(back)
    expect(d.kind).toBe('create-account')
    expect(d.warnings.some((w) => w.code === 'full-access-key')).toBe(true)
    expect(d.warnings.filter((w) => w.code === 'dangerous-action')).toHaveLength(11)
  })

  it('NEP-413 payload: prefix 2^31+413, then borsh {message, nonce[32], recipient, callbackUrl?}', () => {
    const bytes = nep413Bytes({ message: 'hi', nonce: new Uint8Array(32).fill(1), recipient: 'intents.near' })
    expect(bytesToHex(bytes.subarray(0, 4))).toBe('9d010080') // 2147484061 LE
    expect(bytesToHex(bytes.subarray(4, 10))).toBe('020000006869')
    expect(bytes[bytes.length - 1]).toBe(0) // callbackUrl = None
  })
})
