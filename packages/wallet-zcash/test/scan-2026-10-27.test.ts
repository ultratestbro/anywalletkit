import { describe, expect, it } from 'vitest'
import { decodeAddress } from '../src/index.js'

// 2026-10-27 key/signing scan: the exploit inputs from the report, refused before anything is signed.

const T3 = 't3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd'

describe('scan 2026-10-27 G13 (F19): a Zcash address is decoded exactly as given, never trimmed', () => {
  it('padding with U+FEFF, spaces, tabs or newlines is refused, not trimmed into the blocklisted address', () => {
    for (const padded of [T3 + '﻿', ' ' + T3, T3 + ' ', '\t' + T3, T3 + '\n', ' ' + T3]) {
      expect(() => decodeAddress(padded, 'mainnet'), JSON.stringify(padded)).toThrow(/Invalid Zcash address|whitespace/)
    }
    expect(decodeAddress(T3, 'mainnet').kind).toBe('p2sh')
  })
})
