import { describe, expect, it } from 'vitest'
import SplStakePoolProtocolSolana, { codec } from '../index.js'
// @ts-expect-error plain ESM
import { MAX_PREFUNDED_SLOTS } from '../src/spl-stake-pool-protocol-solana.js'

// scan 2026-10-30 F16: anyone could pre-fund every predictable delayed-exit slot address (System-owned,
// no data, ~0.036 SOL for the whole window) and the module skipped them for good. A pre-funded slot is
// now usable: the exit takes its SOL back to the wallet (TransferWithSeed) before creating the account.
const HOLDER = '9hNaQ3crLjWihWa5BeQgSYfrPY3eoDmHJAX2sTWE8nUC'
const RENT_0 = 890_880

async function protocolWith(n: number, owner: string, data = '') {
  const held = new Set<string>()
  for (let i = 0; i < n; i++) held.add(await codec.findUnstakeAccount(HOLDER, 'Jito', i))
  const provider = {
    async request(method: string, params: any[]) {
      if (method === 'getEpochInfo') return { epoch: 900, slotIndex: 1, slotsInEpoch: 432_000 }
      if (method === 'getMultipleAccounts') return { value: params[0].map((a: string) => (held.has(a) ? { data: [data, 'base64'], lamports: RENT_0, owner } : null)) }
      throw new Error(`unexpected ${method}`)
    },
  }
  return new SplStakePoolProtocolSolana({ async getAddress() { return HOLDER } }, { provider }) as any
}

describe('scan 2026-10-30 F16: pre-funded delayed-exit slots are reclaimed, not skipped', () => {
  it('every slot of the old window pre-funded: the first one is free, with the SOL to take back', async () => {
    const p = await protocolWith(8 + MAX_PREFUNDED_SLOTS, codec.SYSTEM_PROGRAM)
    const { freeIndex, freeLamports, prefunded, skipped } = await p._getUnstakeSlots()
    expect(freeIndex).toBe(0)
    expect(freeLamports).toBe(BigInt(RENT_0))
    expect(prefunded).toHaveLength(8) // the tracked window only: pre-funded slots count as usable
    expect(skipped).toEqual([])
  })

  it('control: an untouched wallet has slot 0 free with nothing to reclaim', async () => {
    const { freeIndex, freeLamports } = await (await protocolWith(0, codec.SYSTEM_PROGRAM))._getUnstakeSlots()
    expect([freeIndex, freeLamports]).toEqual([0, 0n])
  })

  it('a System account carrying data is not taken for a pre-funded slot (TransferWithSeed would fail): skipped', async () => {
    const { freeIndex, skipped } = await (await protocolWith(3, codec.SYSTEM_PROGRAM, 'AAAA'))._getUnstakeSlots()
    expect(freeIndex).toBe(3)
    expect(skipped).toEqual([0, 1, 2])
  })

  it('the reclaim instruction is TransferWithSeed from the slot, base and destination the wallet, derivation owner Stake', async () => {
    const slot = await codec.findUnstakeAccount(HOLDER, 'Jito', 0)
    const seed = codec.unstakeSeed('Jito', 0)
    const ix = codec.ixTransferWithSeed({ from: slot, base: HOLDER, seed, fromOwner: codec.STAKE_PROGRAM, to: HOLDER, lamports: 5n })
    expect(ix.programAddress).toBe(codec.SYSTEM_PROGRAM)
    expect(ix.accounts!.map((a: { address: string; role: number }) => [a.address, a.role])).toEqual([[slot, 1], [HOLDER, 2], [HOLDER, 1]])
    expect([...ix.data!]).toEqual([11, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, seed.length, 0, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode(seed), ...codec.addressToBytes(codec.STAKE_PROGRAM)])
  })
})
