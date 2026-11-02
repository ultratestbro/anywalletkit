// LI.FI's Solana routes other than Mayan (Relay, LayerSwap, NEAR Intents, LI.FI Intents) deposit to an order id, an
// address or a program whose recipient lives off chain or in data the device does not read. With `bridgeOut` the guard
// refused all of them (`bridge-missing`), which took those corridors away. The guard now reads a transaction as a Mayan
// route only when it runs one of Mayan's own programs (directly or through the CPI proxy) and keeps every Mayan check
// for those; any other bridge gets exactly what it got without `bridgeOut`: the program allowlist and the SOL / token
// ceilings, no recipient check. The recorded wires are the public li.quest answers of 2026-11-02.
import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getBase64EncodedWireTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { DEFAULT_PROGRAM_ALLOWLIST, MAYAN_CPI_PROXY_PROGRAM_ADDRESS, WalletAccountReadOnlySolana, type BridgeOutExpectation } from '../src/index.js'
import { LIFI_INTENTS, SOL, USDC_OUT, code, fakeRpc, guardFor, live, reviewedTerms, run, sys, tablesFor, type Live } from './helpers/lifi-live.js'

const terms = (q: Live): BridgeOutExpectation => ({ destChain: q.destChain, recipient: q.recipient, destToken: USDC_OUT[q.destChain]!, minAmountOut: 1n, destDecimals: 6, slippageBps: 50 })

describe('audit 2026-11-02 r3: Solana bridges other than Mayan are checked as they were before bridgeOut', () => {
  const other = live.filter((q) => !q.tool.startsWith('mayan'))

  it('every recorded Relay, LayerSwap, NEAR Intents and LI.FI Intents wire gets the same answer with bridgeOut as without it', async () => {
    expect(other.map((q) => q.tool).sort()).toEqual(['layerswap', 'layerswap', 'lifiIntents', 'near', 'relaydepository', 'relaydepository'])
    const got: Record<string, [string, string]> = {}
    for (const q of other) got[q.name] = [await run(q, terms(q)), await run(q, undefined)]
    expect(got).toEqual({
      'sol-base-usdc-layerswap': ['pass', 'pass'], 'sol-base-usdc-relaydepository': ['pass', 'pass'], 'usdc-base-usdc-relaydepository': ['pass', 'pass'],
      'sol-base-usdc': ['pass', 'pass'], 'usdc-arb-usdc': ['pass', 'pass'],
      // LI.FI Intents calls a program outside the default allowlist, with or without bridgeOut; an app that allows it passes.
      'usdc-base-usdc-lifiIntents': ['unknown-program', 'unknown-program'],
    })
    const intents = other.find((q) => q.tool === 'lifiIntents')!
    const allow = { programAllowlist: [...DEFAULT_PROGRAM_ALLOWLIST, LIFI_INTENTS] }
    expect([await run(intents, terms(intents), allow), await run(intents, undefined, allow)]).toEqual(['pass', 'pass'])
  })

  it('they stay held to the SOL ceiling', async () => {
    const relay = other.find((q) => q.name === 'sol-base-usdc-relaydepository')!
    // The simulation shows the input leaving the wallet: within the ceiling it passes, under a lower one it is refused.
    const after = { [relay.sender]: sys(100n * SOL - BigInt(relay.amountIn) - 5_000n) }
    const a = new WalletAccountReadOnlySolana(relay.sender, { provider: fakeRpc({ [relay.sender]: sys(100n * SOL) }, tablesFor(relay), after) })
    expect(await code(a.checkSerialized(relay.wire, { expect: guardFor(relay, terms(relay)) }))).toBe('pass')
    const tight = { ...guardFor(relay, terms(relay)), maxLamportsOut: BigInt(relay.amountIn) / 2n }
    expect(await code(a.checkSerialized(relay.wire, { expect: tight }))).toBe(await code(a.checkSerialized(relay.wire, { expect: { ...guardFor(relay, undefined), maxLamportsOut: tight.maxLamportsOut } })))
    expect(await code(a.checkSerialized(relay.wire, { expect: tight }))).not.toBe('pass')
  })

  it('every recorded Mayan route still passes, and one re-pointed at another recipient or chain is still refused', async () => {
    const mayan = live.filter((q) => q.tool.startsWith('mayan'))
    expect(mayan).toHaveLength(10)
    for (const q of mayan) expect([q.name, await run(q, { destChain: q.destChain, recipient: q.recipient, ...reviewedTerms(q) })]).toEqual([q.name, 'pass'])
    const q = mayan.find((k) => k.name === 'sol-base-usdc-mayan')!
    const bytes = Buffer.from(q.wire, 'base64')
    const at = bytes.indexOf(Buffer.from(q.recipient.slice(2), 'hex'))
    bytes.fill(0x66, at, at + 20)
    expect(await run(q, { destChain: q.destChain, recipient: q.recipient, ...reviewedTerms(q) }, {}, bytes.toString('base64'))).toBe('bridge-recipient')
    expect(await run(q, { destChain: 'eip155:42161', recipient: q.recipient, ...reviewedTerms(q) })).toBe('bridge-recipient')
  })

  it('a wire that runs a Mayan program or the CPI proxy is a Mayan route: without a readable order it is refused', async () => {
    const SENDER = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
    const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
    const wire = (ixs: Instruction[]) => getBase64EncodedWireTransaction(compileTransaction(pipe(createTransactionMessage({ version: 0 }), (x) => setTransactionMessageFeePayer(SENDER, x),
      (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6' as never, lastValidBlockHeight: 100n }, x),
      (x) => appendTransactionMessageInstructions(ixs, x)) as TransactionMessage as never) as Transaction)
    const transfer = getTransferSolInstruction({ source: createNoopSigner(SENDER), destination: OTHER, amount: 50_000_000n })
    const proxied: Instruction = { programAddress: MAYAN_CPI_PROXY_PROGRAM_ADDRESS as Address, accounts: [{ address: transfer.programAddress, role: AccountRole.READONLY }, ...transfer.accounts!], data: transfer.data! }
    const legacyMayan: Instruction = { programAddress: 'FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf' as Address, accounts: [{ address: SENDER, role: AccountRole.WRITABLE_SIGNER }, { address: OTHER, role: AccountRole.WRITABLE }], data: new Uint8Array([0xde, 0xad]) }
    const a = new WalletAccountReadOnlySolana(SENDER, { provider: fakeRpc({ [SENDER]: sys(SOL), [OTHER]: sys(0n) }) })
    const expect_ = { maxLamportsOut: 70_000_000n, bridgeOut: { destChain: 'eip155:8453', recipient: `0x${'33'.repeat(20)}` } }
    expect(await code(a.checkSerialized(wire([proxied]), { expect: expect_ }))).toBe('bridge-missing')
    expect(await code(a.checkSerialized(wire([legacyMayan]), { expect: expect_ }))).toBe('bridge-missing')
    // The same plain transfer is another bridge's deposit: held to the SOL ceiling only, as without bridgeOut.
    expect(await code(a.checkSerialized(wire([transfer]), { expect: expect_ }))).toBe('pass')
    expect(await code(a.checkSerialized(wire([transfer]), { expect: { maxLamportsOut: 70_000_000n } }))).toBe('pass')
  })
})
