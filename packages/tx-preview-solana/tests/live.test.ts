/**
 * Against mainnet, opt-in: `LIVE=1 SOLANA_RPC_URL=… npx vitest run tests/live.test.ts`. Builds a harmless
 * transaction (a memo plus a 0-lamport self-transfer and a USDC 0-amount self-transfer from a large, long-lived
 * wallet), never signs it, and simulates it with signature checks off: fee, logs, compute units and balances must
 * come back and agree with the decoded transaction.
 */
import {
  appendTransactionMessageInstructions, createNoopSigner, createSolanaRpc, createTransactionMessage, getBase64EncodedWireTransaction, getUtf8Encoder, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, compileTransaction, type Address, type Instruction,
} from '@solana/kit'
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget'
import { getTransferSolInstruction } from '@solana-program/system'
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { describe, expect, it } from 'vitest'
import { describeTransaction, MEMO_PROGRAM, type PreviewRpc } from '../src/index.js'

const live = process.env.LIVE === '1' && !!process.env.SOLANA_RPC_URL
/** A large exchange wallet with SOL and a USDC account for years: it can pay the fee in a simulation. */
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' as Address
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address

describe.skipIf(!live)('live mainnet simulation (LIVE=1)', () => {
  it('a memo + self-transfers: fee, logs, units and balances come back and agree with the decode', async () => {
    const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL!)
    const signer = createNoopSigner(WALLET)
    const [ata] = await findAssociatedTokenPda({ owner: WALLET, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
    const memo: Instruction = { programAddress: MEMO_PROGRAM as Address, accounts: [], data: getUtf8Encoder().encode('tx-preview-solana live check') as Uint8Array }
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions([
        getSetComputeUnitLimitInstruction({ units: 40_000 }),
        getSetComputeUnitPriceInstruction({ microLamports: 25_000n }),
        memo,
        getTransferSolInstruction({ source: signer, destination: WALLET, amount: 0n }),
        getTransferCheckedInstruction({ source: ata, mint: USDC, destination: ata, authority: signer, amount: 0n, decimals: 6 }),
      ], m),
    )
    const wire = getBase64EncodedWireTransaction(compileTransaction(msg))
    const preview = await describeTransaction(wire, { rpc: rpc as unknown as PreviewRpc, signer: WALLET })

    expect(preview.instructions.map((ix) => ix.name)).toEqual(['SetComputeUnitLimit', 'SetComputeUnitPrice', 'Memo', 'TransferSol', 'TransferChecked'])
    // The wallet's signature slot is empty (never signed): reported as missing only for others, not for the signer.
    expect(preview.warnings.map((w) => w.code)).not.toContain('missing-signers')
    const sim = preview.simulation!
    expect(sim.ok, JSON.stringify(sim.error, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + sim.logs.join("\n")).toBe(true)
    expect(sim.logs.some((l) => l.includes(MEMO_PROGRAM))).toBe(true)
    expect(sim.logs.some((l) => l.includes('Memo (len 28)') || l.includes('tx-preview-solana live check'))).toBe(true)
    expect(sim.unitsConsumed).toBeGreaterThan(0n)
    expect(sim.unitsConsumed! <= 40_000n).toBe(true)
    // 5,000 per signature + ceil(40,000 CU × 25,000 µlamports / 10^6) = 5,000 + 1,000
    if (sim.fee !== null) expect(sim.fee).toBe(6_000n)
    const b = sim.balances
    expect(b, 'the RPC returned no pre/post balances').not.toBeNull()
    expect(b!.signer!.address).toBe(WALLET)
    // Nothing moves but the fee, which the simulation charges (2026-11-17 on QuickNode: -6,000, fee 6,000, ~12k CU).
    expect(b!.signer!.sol).toBe(-6_000n)
    expect(b!.sol).toEqual([{ account: WALLET, pre: b!.sol[0]!.pre, post: b!.sol[0]!.pre - 6_000n, delta: -6_000n }])
    expect(b!.signer!.tokens).toEqual([])
  })

  it('a v0 transaction from the fixtures resolves its tables through the RPC', async () => {
    const { loadFixture } = await import('./helpers.js')
    const f = loadFixture('messages/v0-lookup-tables.json')
    const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL!)
    const preview = await describeTransaction(f.wire, { rpc: rpc as unknown as PreviewRpc, simulate: false })
    // Tables can be extended or closed later; the ones still alive must resolve to the same entries.
    for (const t of preview.lookupTables.filter((x) => x.resolved)) {
      const want = f.lookupTables[t.address]!
      const got = preview.accounts.filter((a) => a.lookupTable === t.address).map((a) => a.address)
      expect(got.every((a) => want.includes(a))).toBe(true)
    }
  })
})
