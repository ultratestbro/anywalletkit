import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { NativeStakingProtocolMonad } from '../src/index.js'
import { FakeMonad, WALLET } from './fake-monad.js'

// Audit 2026-10-25 round 3, NS-7: positions came from getDelegations only, and the precompile drops
// a validator from that list once the wallet's stake there is zero. After a full exit the rewards
// still waiting at that validator vanished from listPositions / getStakedBalance — and with them the
// prompt to claim them. Positions now come from delegations ∪ the configured list ∪ validators this
// instance unstaked from ∪ the ones passed in; a row with rewards > 0 is kept.
const MON = 10n ** 18n
const make = (node: FakeMonad, config: Record<string, unknown> = {}) =>
  new NativeStakingProtocolMonad(createMockAccount({ chain: 'eip155:143', address: WALLET }), { provider: node, ...config } as never)

describe('rewards left behind by a full exit stay visible', () => {
  it('a configured validator with no stake but unclaimed rewards is listed', async () => {
    const node = new FakeMonad()
    Object.assign(node.delegator(97n), { stake: 0n, rewards: 3n * MON }) // fully exited, rewards unclaimed
    const p = make(node, { validators: [{ id: 97n, name: 'Ours' }], defaultValidator: 97n })
    const positions = await p.listPositions()
    expect(positions.map((x) => [x.validatorId, x.unclaimedRewards])).toEqual([[97n, 3n * MON]])
    expect((await p.getStakedBalance()).unclaimedRewards).toBe(3n * MON)
  })

  it("in 'any' mode, a validator passed in is looked at; one without anything is still left out", async () => {
    const node = new FakeMonad()
    Object.assign(node.delegator(21n), { stake: 0n, rewards: MON })
    const p = make(node, { validators: 'any' })
    expect(await p.listPositions()).toEqual([])
    expect((await p.listPositions({ validators: [21n, 5n] })).map((x) => x.validatorId)).toEqual([21n])
  })
})
