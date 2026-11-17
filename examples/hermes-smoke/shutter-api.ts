/**
 * @anywalletkit/shutter-api in the Hermes VM: Shutter's own vectors (encrypt with a fixed sigma, decrypt with the
 * epoch secret key), a seal/open round trip under a one-key keyper set, the pairing check of a decryption key, and a
 * recorded mainnet registration's calldata and identity. Timings are printed: pairings are the slow part on a phone.
 */
import { bls12_381 } from '@noble/curves/bls12-381.js'
import { decrypt, deriveIdentity, encrypt, identityPoint, registerCalldata, utf8Decode, utf8Encode, verifyDecryptionKey, SHUTTER_GNOSIS } from '@anywalletkit/shutter-api'
import vectors from '../../packages/shutter-api/tests/vectors.json'

type Check = (what: string, ok: boolean, detail?: string) => void
const hex = (b: Uint8Array) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export function smokeShutterApi(check: Check, note: (line: string) => void): void {
  for (const v of (vectors as Array<{ name: string; test_data: Record<string, string> }>).filter((x) => /^(en|de)cryption [1-4]$/.test(x.name))) {
    const d = v.test_data
    const got = v.name.startsWith('encryption') ? hex(encrypt({ message: d.message!, identity: d.epoch_id!, eonKey: d.eon_public_key!, sigma: d.sigma! })) : hex(decrypt(d.cipher!, d.epoch_secret_key!))
    check(`shutter-api: vector ${v.name}`, got === d.expected, got.slice(0, 40))
  }
  const secret = 0x1234567890abcdefn
  const eonKey = hex(bls12_381.G2.Point.BASE.multiply(secret).toBytes(true))
  const identity = deriveIdentity('0x2adba1397da555101237c5fff3ffe9cbb652b19b15edda827346145e4f9fee76', SHUTTER_GNOSIS.apiRegistrant)
  check('shutter-api: identity of the recorded Gnosis registration', identity === '0x3f27e60a172f2d20232da5042600cafeecd38ce864b60142942547aa9920979c', identity)
  check('shutter-api: register calldata', registerCalldata({ eon: 1, identityPrefix: '0x2adba1397da555101237c5fff3ffe9cbb652b19b15edda827346145e4f9fee76', revealAt: 0x6afca87c }).endsWith('6afca87c'))
  const t0 = Date.now()
  const ct = encrypt({ message: utf8Encode('gm from Hermes ✨'), identity, eonKey })
  const t1 = Date.now()
  const key = hex(identityPoint(identity).multiply(secret).toBytes(true))
  const ok = verifyDecryptionKey(key, identity, eonKey)
  const t2 = Date.now()
  const text = utf8Decode(decrypt(ct, key))
  const t3 = Date.now()
  check('shutter-api: decryption key passes the pairing check', ok)
  check('shutter-api: seal/open round trip', text === 'gm from Hermes ✨', text)
  let refused = false
  try { decrypt(ct, hex(identityPoint(identity).multiply(7n).toBytes(true))) } catch { refused = true }
  check('shutter-api: a wrong key does not open it', refused)
  note(`[note] shutter-api: encrypt ${t1 - t0} ms, verify key ${t2 - t1} ms, decrypt ${t3 - t2} ms`)
}
