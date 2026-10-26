import { describe, expect, it } from 'vitest'
import { WalletManagerTron, encodeParameters, selector, toHexAddress, type TronRawTransaction } from '../src/index.js'
import { NOW, RECIPIENT, fakeNode } from './fake-node.js'

// Audit 2026-10-25 round 3, M8 (Tron part): the fee_limit a transaction is signed with was checked
// against `transactionMaxFee` only, never against `WriteOptions.maxFee` (the kit's policy cap), and
// `signRaw` took no options at all. A transaction may burn up to fee_limit in energy plus its
// bandwidth / memo / activation fees: that worst case is now held to the tighter cap, the
// fee_limit the SDK derives for its own calls is capped by it, and signRaw checks it too.
// L11: signRaw replaced `signature[]` with its own, dropping a multisig co-signer's signature.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TRX = 1_000_000n
const withNow = async <T>(fn: () => Promise<T>): Promise<T> => {
  const real = Date.now
  Date.now = () => NOW
  try { return await fn() } finally { Date.now = real }
}

async function setup(resources?: Record<string, number>) {
  const f = fakeNode({}, resources ? { resources } : {})
  const a = await new WalletManagerTron(SEED, { provider: f.fetch }).getAccount(0)
  const me = toHexAddress(await a.getAddress())
  const prebuilt = (feeLimit: bigint): TronRawTransaction => f.rawTx('TriggerSmartContract', {
    owner_address: me, contract_address: toHexAddress(USDT), data: selector('transfer(address,uint256)') + encodeParameters([{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 1n }]),
  }, 211, { fee_limit: Number(feeLimit.toString()) })
  return { f, a, prebuilt }
}

describe('Tron fee_limit is held to the caller cap', () => {
  it('a prebuilt transaction whose fee_limit is above maxFee is refused, though its estimate is below', async () => {
    const { f, a, prebuilt } = await setup()
    await expect(withNow(() => a.sendTransaction(prebuilt(50n * TRX), { maxFee: 10n * TRX }))).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'fee-limit' })
    expect(f.broadcast).toHaveLength(0)
    await expect(withNow(() => a.sendTransaction(prebuilt(8n * TRX), { maxFee: 10n * TRX }))).resolves.toBeDefined()
  })

  it('fee_limit plus the bandwidth the transaction burns counts, not fee_limit alone', async () => {
    const { a, prebuilt } = await setup({ freeNetLimit: 0 })
    await expect(withNow(() => a.sendTransaction(prebuilt(9_900_000n), { maxFee: 10n * TRX }))).rejects.toMatchObject({ code: 'fee-limit' })
    await expect(withNow(() => a.sendTransaction(prebuilt(9n * TRX), { maxFee: 10n * TRX }))).resolves.toBeDefined()
  })

  it('the fee_limit the SDK derives for its own call is capped by maxFee', async () => {
    const { f, a } = await setup()
    // the fake call needs 30 000 energy × 210 sun = 6.3 TRX; the derived fee_limit adds 20 % (7.56 TRX)
    await withNow(() => a.sendTransaction({ contractAddress: USDT, functionSelector: 'approve(address,uint256)', parameters: [{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 1n }] }, { maxFee: 7n * TRX }))
    expect(f.calls.find((c) => c.path === '/wallet/triggersmartcontract')!.body.fee_limit).toBe(7_000_000)
  })

  it('signRaw takes WriteOptions and checks fee_limit against them', async () => {
    const { a, prebuilt } = await setup()
    await expect(withNow(() => a.signRaw(prebuilt(50n * TRX), { maxFee: 10n * TRX }))).rejects.toMatchObject({ code: 'fee-limit' })
    await expect(withNow(() => a.signRaw(prebuilt(5n * TRX), { maxFee: 10n * TRX }))).resolves.toMatchObject({ signature: [expect.any(String)] })
  })
})

describe('signRaw keeps the signatures already on the transaction (L11)', () => {
  it("a co-signer's signature stays and ours is added once", async () => {
    const { a, prebuilt } = await setup()
    const co = 'ab'.repeat(65)
    const signed = await withNow(() => a.signRaw({ ...prebuilt(5n * TRX), signature: [co] }))
    expect(signed.signature).toHaveLength(2)
    expect(signed.signature![0]).toBe(co)
    const again = await withNow(() => a.signRaw(signed))
    expect(again.signature).toEqual(signed.signature)
  })
})
