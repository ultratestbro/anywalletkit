import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies, type WriteIntent } from '../src/index.js'

// Audit 2026-10-25 round 3, H2: the kit read a write's destination from another field than the one
// the chain package builds the transaction from, so an allowlisted field next to a drainer passed:
// - Tron: `{ contractAddress: ALLOWED, to: DRAINER, value }` (no functionSelector) is a TRX send to
//   DRAINER; `{ raw_data_hex, to }` without `txID` is not prebuilt either;
// - Solana: `{ to: DRAINER, value, instructions: [→ ALLOWED] }` is a {to, value} transfer;
//   `messageBytes` without `signatures` is not a compiled transaction;
// - EVM: `{ recipient: ALLOWED, data }` without `to` is a contract deployment.

const SOL_ALLOWED = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const SOL_DRAINER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
const SYSTEM = '11111111111111111111111111111111'
const TRON_ALLOWED = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TRON_DRAINER = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
const EVM_ALLOWED = '0x000000000000000000000000000000000000bEEF'

async function judged(chain: string, allowed: string, tx: unknown): Promise<{ intent?: WriteIntent; error?: unknown }> {
  let intent: WriteIntent | undefined
  const acc = createMockAccount({ chain })
  const guarded = applyPolicies(acc, { confirm: async (i) => { intent = i; return true } }, chain)
  await guarded.sendTransaction(tx as never)
  const strict = applyPolicies(createMockAccount({ chain }), { allowlist: { [chain]: [allowed] } }, chain)
  const error = await strict.sendTransaction(tx as never).then(() => undefined, (e: unknown) => e)
  return { intent: intent!, error }
}

describe('destinations follow the field the chain package builds from', () => {
  it('Tron: no functionSelector → a TRX send to `to`; contractAddress alongside is ambiguous', async () => {
    const r = await judged('tron:0x2b6653dc', TRON_ALLOWED, { contractAddress: TRON_ALLOWED, to: TRON_DRAINER, value: 1_000_000 })
    expect(r.intent).toMatchObject({ destinationUnknown: true })
    expect(r.error).toMatchObject({ policy: 'allowlist' })
    const plain = await judged('tron:0x2b6653dc', TRON_ALLOWED, { to: TRON_DRAINER, value: 1 })
    expect(plain.intent).toMatchObject({ destinations: [TRON_DRAINER], destinationUnknown: false })
    expect(plain.error).toMatchObject({ policy: 'allowlist' })
    const call = await judged('tron:0x2b6653dc', TRON_ALLOWED, { contractAddress: TRON_ALLOWED, functionSelector: 'transfer(address,uint256)', parameters: [] })
    expect(call.intent).toMatchObject({ destinations: [TRON_ALLOWED], destinationUnknown: false })
    expect(call.error).toBeUndefined()
  })

  it('Tron: raw_data_hex without txID is not a prebuilt transaction', async () => {
    const r = await judged('tron:0x2b6653dc', TRON_ALLOWED, { raw_data_hex: '0a02abcd', to: TRON_DRAINER, value: 1 })
    expect(r.intent).toMatchObject({ destinationUnknown: true })
    expect(r.error).toMatchObject({ policy: 'allowlist' })
  })

  it('Solana: {to, value} wins over instructions; both together are ambiguous', async () => {
    const data = new Uint8Array(12); data[0] = 2; data[4] = 1
    const tx = { to: SOL_DRAINER, value: 5_000_000_000n, instructions: [{ programAddress: SYSTEM, accounts: [{ address: 'me' }, { address: SOL_ALLOWED }], data }] }
    const r = await judged('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', SOL_ALLOWED, tx)
    expect(r.intent).toMatchObject({ destinationUnknown: true })
    expect(r.error).toMatchObject({ policy: 'allowlist' })
    const ix = await judged('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', SOL_ALLOWED, { instructions: tx.instructions })
    expect(ix.intent).toMatchObject({ destinations: [SOL_ALLOWED], destinationUnknown: false })
    expect(ix.error).toBeUndefined()
    // `messageBytes` without `signatures` is not a compiled transaction: wallet-solana builds { to, value }
    const fake = await judged('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', SOL_ALLOWED, { messageBytes: new Uint8Array(0), to: SOL_DRAINER, value: 1n })
    expect(fake.intent).toMatchObject({ destinations: [SOL_DRAINER], destinationUnknown: false })
    // `recipient` is not a field wallet-solana reads
    const recipient = await judged('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', SOL_ALLOWED, { recipient: SOL_ALLOWED, value: 1n })
    expect(recipient.intent).toMatchObject({ destinationUnknown: true })
  })

  it('EVM: only `to` is the destination; no `to` is a deployment (unknown)', async () => {
    const r = await judged('eip155:1', EVM_ALLOWED, { recipient: EVM_ALLOWED, data: '0x6080604052' })
    expect(r.intent).toMatchObject({ destinations: [], destinationUnknown: true })
    expect(r.error).toMatchObject({ policy: 'allowlist' })
    const ok = await judged('eip155:1', EVM_ALLOWED, { to: EVM_ALLOWED, value: 1n })
    expect(ok.error).toBeUndefined()
    const batch = await judged('eip155:1', EVM_ALLOWED, [{ to: EVM_ALLOWED, value: 1n }, { recipient: EVM_ALLOWED, data: '0x60' }])
    expect(batch.intent).toMatchObject({ destinationUnknown: true })
    expect(batch.error).toMatchObject({ policy: 'allowlist' })
  })
})
