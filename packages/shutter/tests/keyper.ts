import { bls12_381 } from '@noble/curves/bls12-381.js'
import { identityPoint } from '../src/index.js'
import { toHex } from '../src/bytes.js'

/** A keyper set of one: master secret s, eon key s·G2, decryption key for an identity s·Q. */
export function keyper(secret = 0x1234567890abcdefn) {
  return {
    eonKey: toHex(bls12_381.G2.Point.BASE.multiply(secret).toBytes(true)),
    keyFor: (identity: string) => toHex(identityPoint(identity).multiply(secret).toBytes(true)),
  }
}

