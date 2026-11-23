import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { PolicyViolationError, applyPolicies, type WriteIntent } from '../src/index.js'
import { isZcashBech32Address } from '../src/destinations.js'

// SDK-371: the F19 guard in intentOf only knew base58, so a shielded (zs1), unified (u1) or TEX (tex1) recipient —
// bech32 / bech32m, which uses '0' and 'l' — came out destinationUnknown and an allowlist refused it.

// A unified address from the ZIP-316 test vectors (bech32m).
const U1_ZIP316 = 'u13j3q8q8f9hx2nx0w9l52dqksy4png7fgm0lqjh8ahn9enyvz5z9xnwzdcdjmpf756s2y88rnyr9px4f4k9w03sl6fr4vwsqcvg8ggfjx'
// Encoded with @scure/base (bech32 for Sapling, bech32m for unified and TEX).
const ZS1 = 'zs1r23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clftj6v9'
const ZS_TEST = 'ztestsapling19vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pcepd74'
const U1 = 'u1tjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23whcr0a'
const U_TEST = 'utest1d5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6pg0kaytjeq8w4ur23clxd5mzfsh79vn6q6mq5'
const TEX = 'tex13clxd5mzfsh79vn6pg0kaytjeq8w4ur25lgqez'
const TEX_TEST = 'textest1n6pg0kaytjeq8w4ur23clxd5mzfsh79v4gtrhw'
const BC1 = 'bc1qzfsh79vn6pg0kaytjeq8w4ur23clxd5ms92mg2'
const T1 = 't1Ju9gpPpCwUZgjiNnCMGxfyLL4TQLK8W5B'
const T3 = 't3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd'
const SHIELDED = [U1_ZIP316, ZS1, ZS_TEST, U1, U_TEST, TEX, TEX_TEST]

const outcome = (p: Promise<unknown>) => p.then(() => 'signed', (e: unknown) => (e instanceof PolicyViolationError ? e.policy : String(e)))
const seen = () => { const intents: WriteIntent[] = []; return { intents, confirm: vi.fn(async (i: WriteIntent) => { intents.push(i); return true }) } }
const zec = () => createMockAccount({ chain: 'zcash:mainnet', address: 't1self' })
const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'q' ? 'p' : 'q') + s.slice(i + 1)

describe('SDK-371: Zcash shielded, unified and TEX recipients are known destinations', () => {
  it('isZcashBech32Address: Zcash HRPs with a valid bech32 / bech32m checksum, one case', () => {
    for (const a of SHIELDED) {
      expect(isZcashBech32Address(a)).toBe(true)
      expect(isZcashBech32Address(a.toUpperCase())).toBe(true)
    }
    for (const a of [
      ZS1 + ' ', ' ' + ZS1, U1 + '﻿', // padded
      ZS1.slice(0, 10) + ZS1.slice(10).toUpperCase(), // mixed case
      flip(ZS1, 20), flip(U1, 60), flip(TEX, 10), // checksum broken
      BC1, // another chain's HRP
      T1, T3, '', 'u1', 'zs1qqqqqq',
    ]) expect(isZcashBech32Address(a)).toBe(false)
  })

  it('a transfer to zs1 / u1 / tex1 (mainnet and testnet) is not destinationUnknown, and an allowlist that lists it lets it through', async () => {
    for (const recipient of SHIELDED) {
      const { intents, confirm } = seen()
      expect(await outcome(applyPolicies(zec(), { confirm }, 'zcash:mainnet').transfer({ recipient, amount: 1n }))).toBe('signed')
      expect(intents[0]!.destinationUnknown).not.toBe(true)
      expect(await outcome(applyPolicies(zec(), { allowlist: { zcash: [recipient] } }, 'zcash:mainnet').transfer({ recipient, amount: 1n }))).toBe('signed')
      // bech32 is one case, either one: the uppercase spelling is the same listed address.
      expect(await outcome(applyPolicies(zec(), { allowlist: { zcash: [recipient] } }, 'zcash:mainnet').transfer({ recipient: recipient.toUpperCase(), amount: 1n }))).toBe('signed')
      expect(await outcome(applyPolicies(zec(), { blocklist: { zcash: [recipient] } }, 'zcash:mainnet').transfer({ recipient, amount: 1n }))).toBe('blocklist')
    }
  })

  it('t1 / t3 stay known', async () => {
    for (const recipient of [T1, T3]) {
      const { intents, confirm } = seen()
      await applyPolicies(zec(), { confirm }, 'zcash:mainnet').transfer({ recipient, amount: 1n })
      expect(intents[0]!.destinationUnknown).not.toBe(true)
      expect(await outcome(applyPolicies(zec(), { allowlist: { zcash: [recipient] } }, 'zcash:mainnet').transfer({ recipient, amount: 1n }))).toBe('signed')
    }
  })

  it('F19 stays closed: padded, mixed-case, broken-checksum and foreign-prefix recipients are unknown', async () => {
    const bad = [ZS1 + ' ', ' ' + U1, U1 + '﻿', TEX + '﻿', ZS1.slice(0, 10) + ZS1.slice(10).toUpperCase(), flip(ZS1, 20), flip(U1, 60), BC1]
    for (const recipient of bad) {
      const { intents, confirm } = seen()
      await applyPolicies(zec(), { confirm }, 'zcash:mainnet').transfer({ recipient, amount: 1n })
      expect(intents[0]).toMatchObject({ destinationUnknown: true })
      // A blocklist without confirm refuses an unknown destination; an allowlist refuses it even when it lists the clean spelling.
      expect(await outcome(applyPolicies(zec(), { blocklist: { zcash: ['t1other'] } }, 'zcash:mainnet').transfer({ recipient, amount: 1n }))).toBe('blocklist')
      expect(await outcome(applyPolicies(zec(), { allowlist: { zcash: [recipient.trim().replace('﻿', ''), ...SHIELDED] } }, 'zcash:mainnet').transfer({ recipient, amount: 1n }))).toBe('allowlist')
    }
  })
})
