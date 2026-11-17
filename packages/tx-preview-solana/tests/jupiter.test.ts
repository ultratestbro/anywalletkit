import { createHash } from 'node:crypto'
import { getBase58Encoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { decodeInstruction, JUPITER_V6_PROGRAM, TOKEN_2022_PROGRAM, type DecodedInstruction, type PreviewValue } from '../src/index.js'
import { ANCHOR_EVENT_IX_TAG } from '../src/decoders/anchor.js'
import { JUPITER_V6_EVENTS, JUPITER_V6_INSTRUCTIONS } from '../src/decoders/jupiter.js'
import { decodeFixture, fixtureBalanceChanges, loadFixture, type Fixture } from './helpers.js'

const sha8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)
const snake = (name: string): string => name.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase()
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))
const base58 = getBase58Encoder()

type Rec = Record<string, PreviewValue>
const rec = (v: PreviewValue | undefined): Rec => v as Rec
const list = (v: PreviewValue | undefined): Rec[] => v as Rec[]

/** The Jupiter instruction at `index`, decoded. */
function jup(f: Fixture, index: number): DecodedInstruction {
  const ix = decodeFixture(f).instructions[index]!
  expect(ix.programAddress).toBe(JUPITER_V6_PROGRAM)
  expect(ix.decoded).toBe(true)
  return ix
}

const account = (ix: DecodedInstruction, name: string): string | null => ix.accounts.find((a) => a.name === name)?.address ?? null

/** A token account's balance change in the confirmed transaction. */
function tokenDelta(f: Fixture, address: string | null): bigint | undefined {
  return fixtureBalanceChanges(f)?.tokens.find((t) => t.account === address)?.delta
}

/** The program's own inner instructions (its self-CPI events), decoded from the meta. */
function innerEvents(f: Fixture): DecodedInstruction[] {
  const out: DecodedInstruction[] = []
  for (const group of f.meta.innerInstructions as Array<{ instructions: Array<{ programId: string; accounts?: string[]; data?: string }> }>) {
    for (const ix of group.instructions) {
      if (ix.programId !== JUPITER_V6_PROGRAM || !ix.data) continue
      const raw = { programAddress: ix.programId, accounts: (ix.accounts ?? []).map((address) => ({ address, signer: false, writable: false })), data: new Uint8Array(base58.encode(ix.data)) }
      out.push(decodeInstruction(raw, out.length))
    }
  }
  return out
}

describe('Jupiter v6 discriminators', () => {
  it('every instruction is sha256("global:<snake_case>")[0..8], except the one the program sets explicitly', () => {
    expect(JUPITER_V6_INSTRUCTIONS).toHaveLength(21)
    for (const [disc, name] of JUPITER_V6_INSTRUCTIONS) {
      if (name === 'CreateIdempotentAssociatedTokenAccount') expect(disc).toBe('5368c096b4479cc6')
      else expect(disc, name).toBe(sha8(`global:${snake(name)}`))
    }
    expect(new Set(JUPITER_V6_INSTRUCTIONS.map(([d]) => d)).size).toBe(21)
  })

  it('every event is sha256("event:<Name>")[0..8], behind the anchor:event tag', () => {
    expect(ANCHOR_EVENT_IX_TAG).toBe(sha8('anchor:event').match(/../g)!.reverse().join(''))
    expect(JUPITER_V6_EVENTS.map(([, n]) => n)).toEqual(['FeeEvent', 'SwapEvent', 'SwapsEvent', 'CandidateSwapResults', 'CandidateSwapQuoteError', 'BestSwapOutAmountViolation'])
    for (const [disc, name] of JUPITER_V6_EVENTS) expect(disc, name).toBe(sha8(`event:${name}`))
  })

  it('agrees with the discriminators protocol-swap2-jupiter checks /build answers against', () => {
    const byName = Object.fromEntries(JUPITER_V6_INSTRUCTIONS.map(([d, n]) => [n, d]))
    expect(byName.RouteV2).toBe('bb64facc31c4af14')
    expect(byName.SharedAccountsRouteV2).toBe('d19853937cfed8e9')
  })
})

describe('Jupiter v6 routes from mainnet', () => {
  it('RouteV2 in a v1 transaction: split bps, AMM payloads, DynamicV2 candidates, and the source drop equals inAmount', () => {
    const f = loadFixture('jupiter/route-v2-dynamic.json')
    expect(decodeFixture(f).version).toBe(1)
    const ix = jup(f, 1)
    expect(ix.name).toBe('RouteV2')
    expect(ix.args).toMatchObject({ inAmount: 793517795320n, quotedOutAmount: 620345724n, slippageBps: 315, platformFeeBps: 50, positiveSlippageBps: 0 })
    const plan = list(ix.args.routePlan)
    expect(plan.map((s) => rec(s.swap).kind)).toEqual(['MeteoraDlmmSwapV2', 'PumpSwapSellV4', 'GoonFiV4', 'DynamicV2'])
    expect(plan[0]).toEqual({ swap: { kind: 'MeteoraDlmmSwapV2', remainingAccountsInfo: { slices: [] } }, bps: 265, inputIndex: 0, outputIndex: 4 })
    expect(plan[1]).toEqual({ swap: { kind: 'PumpSwapSellV4', closeUserVolumeAccumulator: true }, bps: 9735, inputIndex: 0, outputIndex: 2 })
    expect(rec(plan[2]!.swap)).toEqual({ kind: 'GoonFiV4', isBid: false })
    expect(rec(plan[3]!.swap)).toEqual({
      kind: 'DynamicV2',
      candidateSwaps: [{ candidateSwap: { kind: 'ZeroFiSwapV3' }, bps: 10000 }, { candidateSwap: { kind: 'ZeroFiSwapV3' }, bps: 0 }],
      maxSplitQuoteCalls: 30,
      maxSplitCandidates: 4,
    })
    // The two legs out of the input token split it 265 / 9735 bps.
    expect(plan.filter((s) => s.inputIndex === 0).reduce((n, s) => n + (s.bps as number), 0)).toBe(10_000)

    expect(account(ix, 'userTransferAuthority')).toBe(decodeFixture(f).feePayer)
    expect(account(ix, 'sourceMint')).toBe('9a5uUXxa7LzHkT6YUikttpQsUZm4Etw8qhd2HP7xpump')
    expect(account(ix, 'destinationMint')).toBe('So11111111111111111111111111111111111111112')
    expect(account(ix, 'sourceTokenProgram')).toBe(TOKEN_2022_PROGRAM)
    expect(ix.accounts.slice(0, 10).map((a) => a.name)).toEqual([
      'userTransferAuthority', 'userSourceTokenAccount', 'userDestinationTokenAccount', 'sourceMint', 'destinationMint',
      'sourceTokenProgram', 'destinationTokenProgram', 'destinationTokenAccount', 'eventAuthority', 'program',
    ])
    expect(ix.accounts.slice(10).every((a) => a.name === null)).toBe(true) // the hops' own accounts
    expect(tokenDelta(f, account(ix, 'userSourceTokenAccount'))).toBe(-793517795320n)

    // The SwapsEvent it emits: the two input-token legs add up to inAmount.
    const [event] = innerEvents(f)
    expect(event).toMatchObject({ name: 'SwapsEvent', decoded: true, accounts: [{ name: 'eventAuthority' }] })
    const legs = list(event!.args.swapEvents)
    expect(legs).toHaveLength(4)
    expect(legs.filter((l) => l.inputMint === account(ix, 'sourceMint')).reduce((n, l) => n + (l.inputAmount as bigint), 0n)).toBe(793517795320n)
  })

  it('Route (percent steps) in a v0 transaction: four hops, a u128 Scorch swap id, one SwapEvent per hop', () => {
    const f = loadFixture('jupiter/route-multi-hop.json')
    const ix = jup(f, 2)
    expect(ix.name).toBe('Route')
    expect(ix.args).toMatchObject({ inAmount: 10346586562n, quotedOutAmount: 10347621324n, slippageBps: 1, platformFeeBps: 0 })
    expect(list(ix.args.routePlan)).toEqual([
      { swap: { kind: 'WhirlpoolSwapV2', aToB: true, remainingAccountsInfo: null }, percent: 100, inputIndex: 0, outputIndex: 1 },
      { swap: { kind: 'WhirlpoolSwapV2', aToB: false, remainingAccountsInfo: null }, percent: 100, inputIndex: 1, outputIndex: 2 },
      { swap: { kind: 'BisonFi', aToB: true }, percent: 100, inputIndex: 2, outputIndex: 3 },
      { swap: { kind: 'Scorch', swapId: 1329228946522866320777019288669618096n }, percent: 100, inputIndex: 3, outputIndex: 0 },
    ])
    expect(ix.accounts.slice(0, 9).map((a) => a.name)).toEqual([
      'tokenProgram', 'userTransferAuthority', 'userSourceTokenAccount', 'userDestinationTokenAccount', 'destinationTokenAccount',
      'destinationMint', 'platformFeeAccount', 'eventAuthority', 'program',
    ])
    // Optional accounts the route leaves out hold the program id (Anchor's None).
    expect(account(ix, 'platformFeeAccount')).toBe(JUPITER_V6_PROGRAM)
    const events = innerEvents(f)
    expect(events.map((e) => e.name)).toEqual(['SwapEvent', 'SwapEvent', 'SwapEvent', 'SwapEvent'])
    expect(events[0]!.args).toMatchObject({ inputMint: 'So11111111111111111111111111111111111111112', inputAmount: 10346586562n })
    // A round trip SOL → … → SOL: the account it starts and ends in nets the output minus the input.
    expect(tokenDelta(f, account(ix, 'userSourceTokenAccount'))).toBe((events[3]!.args.outputAmount as bigint) - 10346586562n)
  })

  it('Route with a platform fee: the fee bps, the fee account, and the FeeEvent amount that account received', () => {
    const f = loadFixture('jupiter/route-platform-fee.json')
    const ix = jup(f, 1)
    expect(ix.name).toBe('Route')
    expect(ix.args).toMatchObject({ inAmount: 11937n, quotedOutAmount: 2402368n, slippageBps: 500, platformFeeBps: 100 })
    expect(list(ix.args.routePlan)).toEqual([{ swap: { kind: 'ZeroFiSwapV3' }, percent: 100, inputIndex: 0, outputIndex: 1 }])
    expect(tokenDelta(f, account(ix, 'userSourceTokenAccount'))).toBe(-11937n)
    const feeAccount = account(ix, 'platformFeeAccount')
    expect(feeAccount).toBe('nhp39kZqVrB7DVKWZDQpdPvCvnCFwfvKR2Nbbm6uurp')
    const fee = innerEvents(f).find((e) => e.name === 'FeeEvent')!
    expect(fee.args).toEqual({ account: feeAccount, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: 24264n })
    expect(tokenDelta(f, feeAccount)).toBe(24264n)
    // 100 bps of the swap's output (what the user got plus the fee).
    expect((tokenDelta(f, account(ix, 'userDestinationTokenAccount'))! + 24264n) / 100n).toBe(24264n)
  })

  it('SharedAccountsRouteV2 next to the program\'s own CreateIdempotentAssociatedTokenAccount (custom discriminator)', () => {
    const f = loadFixture('jupiter/shared-accounts-route-v2.json')
    const create = jup(f, 0)
    expect(create.name).toBe('CreateIdempotentAssociatedTokenAccount')
    expect(create.args).toEqual({})
    expect(create.accounts.map((a) => a.name)).toEqual(['payer', 'associatedTokenAccount', 'owner', 'mint', 'associatedTokenProgram', 'systemProgram', 'tokenProgram', 'closeAuthority'])

    const ix = jup(f, 1)
    expect(ix.name).toBe('SharedAccountsRouteV2')
    expect(ix.args).toMatchObject({ id: 7, inAmount: 24500000n, quotedOutAmount: 1375738870222n, slippageBps: 1361, platformFeeBps: 0, positiveSlippageBps: 0 })
    expect(list(ix.args.routePlan).map((s) => s.swap)).toEqual([
      { kind: 'JupiterLendDexSwap', swap0to1: true },
      { kind: 'BisonFiMarketBackedV3', aToB: false },
      { kind: 'MeteoraDlmm' },
    ])
    expect(account(ix, 'destinationTokenAccount')).toBe(account(create, 'associatedTokenAccount'))
    expect(account(ix, 'destinationMint')).toBe(account(create, 'mint'))
    expect(tokenDelta(f, account(ix, 'destinationTokenAccount'))).toBe(1375706636252n)
    // The source pays inAmount into the route plus the two TransferChecked fees the dApp adds after it.
    const transfers = decodeFixture(f).instructions.filter((i) => i.name === 'TransferChecked').map((i) => i.args.amount as bigint)
    expect(transfers).toEqual([225000n, 275000n])
    expect(tokenDelta(f, account(ix, 'sourceTokenAccount'))).toBe(-(24500000n + 275000n + 225000n))
  })

  it('SharedAccountsRoute (v1 layout, id first): three hops, source drop equals inAmount', () => {
    const f = loadFixture('jupiter/shared-accounts-route.json')
    const ix = jup(f, 3)
    expect(ix.name).toBe('SharedAccountsRoute')
    expect(ix.args).toMatchObject({ id: 4, inAmount: 92860515n, quotedOutAmount: 128005n, slippageBps: 100, platformFeeBps: 0 })
    expect(list(ix.args.routePlan).map((s) => rec(s.swap).kind)).toEqual(['RaydiumCP', 'RaydiumClmmV2', 'OneIntro'])
    expect(ix.accounts.slice(0, 13).map((a) => a.name)).toEqual([
      'tokenProgram', 'programAuthority', 'userTransferAuthority', 'sourceTokenAccount', 'programSourceTokenAccount',
      'programDestinationTokenAccount', 'destinationTokenAccount', 'sourceMint', 'destinationMint', 'platformFeeAccount',
      'token2022Program', 'eventAuthority', 'program',
    ])
    expect(tokenDelta(f, account(ix, 'sourceTokenAccount'))).toBe(-92860515n)
    expect(innerEvents(f).at(-1)!.args).toMatchObject({ outputMint: account(ix, 'destinationMint'), outputAmount: 128005n })
  })

  it('SetTokenLedger + RouteWithTokenLedger: no inAmount argument, the ledger account is named', () => {
    const f = loadFixture('jupiter/route-with-token-ledger.json')
    const set = jup(f, 2)
    expect(set.name).toBe('SetTokenLedger')
    expect(set.accounts.map((a) => a.name)).toEqual(['tokenLedger', 'tokenAccount'])
    expect(jup(f, 3).name).toBe('RouteV2')
    const ix = jup(f, 4)
    expect(ix.name).toBe('RouteWithTokenLedger')
    expect(Object.keys(ix.args)).toEqual(['routePlan', 'quotedOutAmount', 'slippageBps', 'platformFeeBps'])
    expect(ix.args).toMatchObject({ quotedOutAmount: 114048114n, slippageBps: 0, platformFeeBps: 0 })
    expect(list(ix.args.routePlan).map((s) => s.swap)).toEqual([
      { kind: 'Riptide', amountIsTokenA: true },
      { kind: 'Scorch', swapId: 5192296858534827628530496547837056n },
      { kind: 'RaydiumClmmV2' },
    ])
    expect(account(ix, 'tokenLedger')).toBe(account(set, 'tokenLedger'))
    // The ledger recorded the account the previous route paid into; this route spends from it.
    expect(account(ix, 'userSourceTokenAccount')).toBe(account(set, 'tokenAccount'))
  })

  it('SharedAccountsRouteWithTokenLedger in a durable-nonce v0 transaction', () => {
    const f = loadFixture('jupiter/shared-accounts-route-with-token-ledger.json')
    const decoded = decodeFixture(f)
    expect(decoded.lifetime.kind).toBe('durable-nonce')
    expect(jup(f, 5)).toMatchObject({ name: 'SharedAccountsRoute', args: { id: 0, inAmount: 234940680n } })
    const ix = jup(f, 6)
    expect(ix.name).toBe('SharedAccountsRouteWithTokenLedger')
    expect(ix.args).toEqual({ id: 0, routePlan: [{ swap: { kind: 'RaydiumClmmV2' }, percent: 100, inputIndex: 0, outputIndex: 1 }], quotedOutAmount: 235006314n, slippageBps: 2, platformFeeBps: 0 })
    expect(account(ix, 'tokenLedger')).toBe(account(jup(f, 4), 'tokenLedger'))
  })

  it('RouteWithAttestation: the 74-byte attestation comes back as base64', () => {
    const f = loadFixture('jupiter/route-with-attestation.json')
    const ix = jup(f, 4)
    expect(ix.name).toBe('RouteWithAttestation')
    expect(ix.args).toMatchObject({ inAmount: 6864451n, quotedOutAmount: 16462408848n, slippageBps: 2000, platformFeeBps: 10, positiveSlippageBps: 0 })
    expect(list(ix.args.routePlan)).toEqual([{ swap: { kind: 'RaydiumLaunchlabBuy', shareFeeRate: 0n }, bps: 10000, inputIndex: 0, outputIndex: 1 }])
    const attestation = ix.args.attestation as string
    expect(Buffer.from(attestation, 'base64')).toHaveLength(74)
    expect(tokenDelta(f, account(ix, 'userDestinationTokenAccount'))).toBe(16425890917n)
  })

  it('Route with a DynamicV1 step: candidate swaps and the optional best position', () => {
    const f = loadFixture('jupiter/route-dynamic-v1.json')
    const ix = jup(f, 1)
    expect(ix.args).toMatchObject({ inAmount: 2366356861n, quotedOutAmount: 2378295482n, slippageBps: 50, platformFeeBps: 0 })
    expect(list(ix.args.routePlan).map((s) => s.swap)).toEqual([
      { kind: 'DynamicV1', candidateSwaps: [{ kind: 'ZeroFiSwapV2' }], bestPosition: 0 },
      { kind: 'BisonFiV2', aToB: true },
    ])
    expect(innerEvents(f)[0]!.args).toMatchObject({ inputAmount: 2366356861n })
  })
})

describe('Jupiter v6 data it cannot fully read', () => {
  const routeV2 = jup(loadFixture('jupiter/route-v2-dynamic.json'), 1)
  const route = jup(loadFixture('jupiter/route-multi-hop.json'), 2)
  const raw = (ix: DecodedInstruction, data: Uint8Array) => ({ programAddress: JUPITER_V6_PROGRAM, accounts: ix.accounts, data })
  const bytes = (ix: DecodedInstruction) => new Uint8Array(Buffer.from(ix.data, 'base64'))

  it('a Swap variant newer than the IDL: the name and the fixed fields stay, the route plan is reported undecoded', () => {
    const data = bytes(routeV2)
    // RouteV2: 8 disc + 8 + 8 + 2 + 2 + 2, then the Vec length (u32), then the first step's Swap tag.
    expect(data[34]).toBe(75) // MeteoraDlmmSwapV2
    data[34] = 250
    const ix = decodeInstruction(raw(routeV2, data), 0)
    expect(ix).toMatchObject({ decoded: true, name: 'RouteV2', args: { inAmount: 793517795320n, slippageBps: 315, routePlan: null } })
    expect(ix.partial).toMatch(/Swap variant 250 is not in the IDL/)
    expect(ix.accounts[1]!.name).toBe('userSourceTokenAccount')
  })

  it('the same in a Route, where the plan comes first: every field after it is null rather than guessed', () => {
    const data = bytes(route)
    expect(data[12]).toBe(47) // WhirlpoolSwapV2, right after the Vec length
    data[12] = 255
    const ix = decodeInstruction(raw(route, data), 0)
    expect(ix).toMatchObject({ decoded: true, name: 'Route', args: { routePlan: null, inAmount: null, quotedOutAmount: null, slippageBps: null, platformFeeBps: null } })
    expect(ix.partial).toMatch(/Swap variant 255 .* routePlan, inAmount, quotedOutAmount, slippageBps, platformFeeBps not decoded/)
  })

  it('truncated data is reported as an error, not thrown; unknown discriminators and short data are undecoded', () => {
    const cut = decodeInstruction(raw(routeV2, bytes(routeV2).subarray(0, 20)), 0)
    expect(cut).toMatchObject({ decoded: false, name: null, programName: 'Jupiter Aggregator v6' })
    expect(cut.error).toBeTruthy()
    const cutPlan = decodeInstruction(raw(route, bytes(route).subarray(0, 40)), 0)
    expect(cutPlan).toMatchObject({ decoded: false })
    expect(cutPlan.error).toBeTruthy()
    expect(decodeInstruction(raw(route, fromHex('0102030405060708aa')), 0)).toMatchObject({ decoded: false, name: null })
    expect(decodeInstruction(raw(route, fromHex('e517cb')), 0)).toMatchObject({ decoded: false, name: null })
    // An event tag with an event the IDL does not list.
    expect(decodeInstruction(raw(route, fromHex(`${ANCHOR_EVENT_IX_TAG}0000000000000000`)), 0)).toMatchObject({ decoded: false })
    expect(cut.error).not.toMatch(/undefined/)
  })
})
