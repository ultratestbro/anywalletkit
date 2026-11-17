/**
 * @anywalletkit/shutter in the Hermes VM: Shutter's own vectors (encrypt with a fixed sigma, decrypt with the
 * epoch secret key), a seal/open round trip under a one-key keyper set, the pairing check of a decryption key, and a
 * recorded mainnet registration's calldata and identity, and the encrypted mempool (a signed transaction encrypted for
 * identityPrefix ‖ sender, opened by the keypers' key; the Sequencer calldata). Timings are printed: pairings are the slow part on a phone.
 */
import { bls12_381 } from '@noble/curves/bls12-381.js'
import { decrypt, deriveIdentity, encrypt, encryptTransaction, identityPoint, mempoolIdentity, registerCalldata, submitEncryptedCalldata, utf8Decode, utf8Encode, verifyDecryptionKey, SHUTTER_GNOSIS } from '@anywalletkit/shutter'
import vectors from '../../packages/shutter/tests/vectors.json'

type Check = (what: string, ok: boolean, detail?: string) => void
const hex = (b: Uint8Array) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export function smokeShutterApi(check: Check, note: (line: string) => void): void {
  for (const v of (vectors as Array<{ name: string; test_data: Record<string, string> }>).filter((x) => /^(en|de)cryption [1-4]$/.test(x.name))) {
    const d = v.test_data
    const got = v.name.startsWith('encryption') ? hex(encrypt({ message: d.message!, identity: d.epoch_id!, eonKey: d.eon_public_key!, sigma: d.sigma! })) : hex(decrypt(d.cipher!, d.epoch_secret_key!))
    check(`shutter: vector ${v.name}`, got === d.expected, got.slice(0, 40))
  }
  const secret = 0x1234567890abcdefn
  const eonKey = hex(bls12_381.G2.Point.BASE.multiply(secret).toBytes(true))
  const identity = deriveIdentity('0x2adba1397da555101237c5fff3ffe9cbb652b19b15edda827346145e4f9fee76', SHUTTER_GNOSIS.apiRegistrant)
  check('shutter: identity of the recorded Gnosis registration', identity === '0x3f27e60a172f2d20232da5042600cafeecd38ce864b60142942547aa9920979c', identity)
  check('shutter: register calldata', registerCalldata({ eon: 1, identityPrefix: '0x2adba1397da555101237c5fff3ffe9cbb652b19b15edda827346145e4f9fee76', revealAt: 0x6afca87c }).endsWith('6afca87c'))
  const t0 = Date.now()
  const ct = encrypt({ message: utf8Encode('gm from Hermes ✨'), identity, eonKey })
  const t1 = Date.now()
  const key = hex(identityPoint(identity).multiply(secret).toBytes(true))
  const ok = verifyDecryptionKey(key, identity, eonKey)
  const t2 = Date.now()
  const text = utf8Decode(decrypt(ct, key))
  const t3 = Date.now()
  check('shutter: decryption key passes the pairing check', ok)
  check('shutter: seal/open round trip', text === 'gm from Hermes ✨', text)
  let refused = false
  try { decrypt(ct, hex(identityPoint(identity).multiply(7n).toBytes(true))) } catch { refused = true }
  check('shutter: a wrong key does not open it', refused)
  note(`[note] shutter: encrypt ${t1 - t0} ms, verify key ${t2 - t1} ms, decrypt ${t3 - t2} ms`)

  const raw = '0x02f86b64078203e8843b9aca00825208940000000000000000000000000000000000aa8080c0'
  const sender = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'
  const t4 = Date.now()
  const sealedTx = encryptTransaction({ signedTransaction: raw, sender, eonKey })
  const t5 = Date.now()
  const preimage = mempoolIdentity(sealedTx.identityPrefix, sender)
  const opened = hex(decrypt(sealedTx.ciphertext, hex(identityPoint(preimage).multiply(secret).toBytes(true))))
  check('shutter: mempool identity is identityPrefix ‖ sender (52 bytes)', preimage.length === 52)
  check('shutter: an encrypted transaction opens with the keypers\' key for its slot identity', opened === raw, opened.slice(0, 20))
  const calldata = submitEncryptedCalldata({ eon: 10, identityPrefix: sealedTx.identityPrefix, ciphertext: sealedTx.ciphertext, gasLimit: 25_200n })
  check('shutter: Sequencer calldata', calldata.startsWith('0x6a69d2e1') && (calldata.length - 10) % 64 === 0, calldata.slice(0, 10))
  note(`[note] shutter: encrypt a transaction ${t5 - t4} ms`)
}
