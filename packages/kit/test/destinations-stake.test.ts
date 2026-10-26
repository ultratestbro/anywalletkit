import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies, type WriteIntent } from '../src/index.js'

// Audit 2026-10-25 native-staking round, NS-2: Stake-program instructions were judged by their
// program id. The native-staking README told apps to allowlist `Stake111…`, which then let any
// `Withdraw` or `Authorize` to a foreign address through. Each instruction now names its own
// destinations (both account layouts, as wallet-solana's decodeStakeInstruction reads them).

const STAKE = 'Stake11111111111111111111111111111111111111'
const CLOCK = 'SysvarC1ock11111111111111111111111111111111'
const RENT = 'SysvarRent111111111111111111111111111111111'
const HISTORY = 'SysvarStakeHistory1111111111111111111111111'
const ME = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const SA = 'BQcdHdAQW1hczDbBi9hiegXPR7MzRYNM4gYHBJLjHCkS' // a stake account
const SB = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1' // another stake account
const VOTE = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'
const DRAINER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function key(s: string): number[] {
  let n = 0n
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch))
  const out = new Array<number>(32).fill(0)
  for (let i = 31; i >= 0; i--) { out[i] = Number((n & 0xffn).toString()); n >>= 8n }
  return out
}
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
const u64 = (v: number) => [...u32(v), 0, 0, 0, 0]
const ix = (accounts: string[], data: number[]) => ({ programAddress: STAKE, accounts: accounts.map((address) => ({ address })), data: Uint8Array.from(data) })

async function intentOf(instruction: unknown): Promise<WriteIntent> {
  let seen: WriteIntent | undefined
  await applyPolicies(createMockAccount({ chain: 'solana:mainnet', address: ME }), { confirm: (i) => { seen = i; return true } }, 'solana:mainnet').sendTransaction({ instructions: [instruction] } as never)
  return seen!
}

describe('Stake instructions name their destinations, not the program', () => {
  const cases: Array<[string, unknown, string[]]> = [
    ['Initialize: staker and withdrawer', ix([SA, RENT], [...u32(0), ...key(ME), ...key(DRAINER), ...u64(0), ...u64(0), ...key('11111111111111111111111111111111')]), [ME, DRAINER]],
    ['Initialize with a custodian: the custodian too', ix([SA, RENT], [...u32(0), ...key(ME), ...key(ME), ...u64(9), ...u64(0), ...key(DRAINER)]), [ME, DRAINER]],
    ['Authorize: the new authority', ix([SA, CLOCK, ME], [...u32(1), ...key(DRAINER), ...u32(1)]), [DRAINER]],
    ['DelegateStake: the vote account', ix([SA, VOTE, CLOCK, HISTORY, STAKE, ME], u32(2)), [VOTE]],
    ['Split: the new stake account', ix([SA, SB, ME], [...u32(3), ...u64(5)]), [SB]],
    ['Withdraw: the recipient', ix([SA, DRAINER, CLOCK, HISTORY, ME], [...u32(4), ...u64(5)]), [DRAINER]],
    ['Deactivate: nobody', ix([SA, CLOCK, ME], u32(5)), []],
    ['SetLockup with a custodian', ix([SA, ME], [...u32(6), 0, 0, 1, ...key(DRAINER)]), [DRAINER]],
    ['SetLockup without one', ix([SA, ME], [...u32(6), 1, ...u64(9), 0, 0]), []],
    ['Merge: the destination account', ix([SA, SB, CLOCK, HISTORY, ME], u32(7)), [SA]],
    ['AuthorizeWithSeed: the new authority', ix([SA, ME, CLOCK], [...u32(8), ...key(DRAINER), ...u32(1), ...u64(1), 0x61, ...key(ME)]), [DRAINER]],
    ['InitializeChecked (rent layout): staker and withdrawer', ix([SA, RENT, ME, DRAINER], u32(9)), [ME, DRAINER]],
    ['InitializeChecked (no rent): staker and withdrawer', ix([SA, ME, DRAINER], u32(9)), [ME, DRAINER]],
    ['AuthorizeChecked (clock layout): the new authority', ix([SA, CLOCK, ME, DRAINER], [...u32(10), ...u32(1)]), [DRAINER]],
    ['AuthorizeChecked (no clock): the new authority', ix([SA, ME, DRAINER], [...u32(10), ...u32(1)]), [DRAINER]],
    ['AuthorizeCheckedWithSeed (clock layout)', ix([SA, ME, CLOCK, DRAINER], [...u32(11), ...u32(1), ...u64(1), 0x61, ...key(ME)]), [DRAINER]],
    ['SetLockupChecked: the new custodian', ix([SA, ME, DRAINER], [...u32(12), 0, 0]), [DRAINER]],
    ['MoveStake: the destination account', ix([SA, SB, ME], [...u32(16), ...u64(5)]), [SB]],
    ['MoveLamports: the destination account', ix([SA, SB, ME], [...u32(17), ...u64(5)]), [SB]],
  ]
  for (const [name, instruction, destinations] of cases) {
    it(name, async () => {
      expect(await intentOf(instruction)).toMatchObject({ destinations, destinationUnknown: false })
    })
  }

  it('an unknown tag or truncated data is unknown', async () => {
    expect((await intentOf(ix([SA], u32(99)))).destinationUnknown).toBe(true)
    expect((await intentOf(ix([SA, CLOCK, ME], [...u32(1), 1, 2, 3]))).destinationUnknown).toBe(true)
  })

  it('allowlisting the Stake program no longer lets a Withdraw to a foreign address through', async () => {
    const withdraw = { instructions: [ix([SA, DRAINER, CLOCK, HISTORY, ME], [...u32(4), ...u64(5)])] }
    const toMe = { instructions: [ix([SA, ME, CLOCK, HISTORY, ME], [...u32(4), ...u64(5)])] }
    const g = (list: string[]) => applyPolicies(createMockAccount({ chain: 'solana:mainnet', address: ME }), { allowlist: { solana: list } }, 'solana:mainnet')
    await expect(g([STAKE]).sendTransaction(withdraw as never)).rejects.toMatchObject({ policy: 'allowlist' })
    await expect(g([ME]).sendTransaction(withdraw as never)).rejects.toMatchObject({ policy: 'allowlist' })
    await expect(g([ME]).sendTransaction(toMe as never)).resolves.toBeDefined()
  })
})
