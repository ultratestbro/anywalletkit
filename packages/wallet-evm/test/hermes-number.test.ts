import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnsafeTransactionError, WalletManagerEvm, describeTransaction } from '../src/index.js'

// Audit 2026-10-25, finding 16: some Hermes builds turn Number(x) of a bigint at or above 2^63 into
// garbage. `Number(tx.chainId) !== known` then compared garbage, and the same garbage was signed as
// the chain id. The engine is simulated: Number() returns 1 (mainnet) for such bigints.

const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'
const hermesLikeNumber = () => vi.stubGlobal('Number', new Proxy(Number, {
  apply: (target, self, args: unknown[]) => (typeof args[0] === 'bigint' && (args[0] >= 2n ** 63n || args[0] <= -(2n ** 63n)) ? 1 : Reflect.apply(target, self, args)),
}))
afterEach(() => { vi.unstubAllGlobals() })

describe('wallet-evm on an engine with a broken Number(bigint)', () => {
  it('a chainId past 2^63 is refused before signing, not signed as chain 1', async () => {
    const a = await new WalletManagerEvm(SEED, { chainId: 1 }).getAccount(0)
    hermesLikeNumber()
    const tx = { to: TO, value: 1n, nonce: 0, gasLimit: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }
    await expect(a.signTransaction({ ...tx, chainId: 2n ** 64n + 1n })).rejects.toBeInstanceOf(UnsafeTransactionError)
    await expect(a.signTransaction({ ...tx, chainId: 1n })).resolves.toMatch(/^0x02/)
  })

  it('describeTransaction still warns about the chain', () => {
    hermesLikeNumber()
    const codes = describeTransaction({ to: TO, value: 1n, chainId: 2n ** 64n + 1n }, { chainId: 1 }).warnings.map((w) => w.code)
    expect(codes).toContain('chain-mismatch')
  })
})
