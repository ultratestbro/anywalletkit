import { describe, expect, it } from 'vitest'
import { decodeFunctionData, keccak256, parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { BroadcastUnknownError, ERC20_ABI, NonceConflictError, WalletManagerEvm } from '../src/index.js'

const SEED = 'test test test test test test test test test test test junk'
const HARDHAT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const SPENDER = '0x000000000000000000000000000000000000bEEF'

/** A fake EIP-1193 provider: answers the JSON-RPC the account needs and records what it broadcast. */
function fakeProvider(overrides: Record<string, (params: unknown[]) => unknown> = {}) {
  const sent: Hex[] = []
  const calls: string[] = []
  const handlers: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => '0x1',
    eth_blockNumber: () => '0x10',
    eth_getBlockByNumber: () => ({ number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }),
    eth_maxPriorityFeePerGas: () => '0x3b9aca00',
    eth_gasPrice: () => '0x6fc23ac00',
    eth_estimateGas: () => '0x5208',
    eth_getTransactionCount: () => '0x7',
    eth_getBalance: () => '0xde0b6b3a7640000',
    eth_call: () => '0x' + '0'.repeat(63) + '0', // allowance / balanceOf = 0
    eth_getTransactionByHash: () => null, // asked after "nonce too low": is the rejected tx ours, already mined?
    eth_sendRawTransaction: (p) => { sent.push(p[0] as Hex); return '0x' + 'ab'.repeat(32) },
    ...overrides,
  }
  return {
    sent, calls,
    provider: { request: async ({ method, params }: { method: string; params?: unknown }) => { calls.push(method); const h = handlers[method]; if (!h) throw new Error(`unmocked ${method}`); return h((params as unknown[]) ?? []) } } as unknown as EIP1193Provider,
  }
}

describe('WalletAccountEvm', () => {
  it('derives the Hardhat default account and caches by path', async () => {
    const m = new WalletManagerEvm(SEED)
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(HARDHAT0)
    expect(a.index).toBe(0)
    expect(a.chain).toBe('eip155:unknown')
    expect(await m.getAccountByPath("m/44'/60'/0'/0/0")).toBe(a)
    m.dispose()
  })

  it('sign + verify round-trips; v is 27/28', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const a = await m.getAccount(0)
    const sig = await a.sign('hello')
    expect(sig).toHaveLength(132)
    expect(['1b', '1c']).toContain(sig.slice(-2))
    expect(await a.verify('hello', sig)).toBe(true)
    expect(await a.verify('hello!', sig)).toBe(false)
    m.dispose()
  })

  it('offline signTransaction needs chainId from the tx or the config', async () => {
    const m = new WalletManagerEvm(SEED)
    const a = await m.getAccount(0)
    await expect(a.signTransaction({ to: SPENDER, value: 1n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).rejects.toThrow(/provider/)
    const m2 = new WalletManagerEvm(SEED, { chainId: 10 })
    const raw = await (await m2.getAccount(0)).signTransaction({ to: SPENDER, value: 1n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
    expect(parseTransaction(raw as Hex).chainId).toBe(10)
    m.dispose(); m2.dispose()
  })

  it('refuses before signing when the native balance cannot cover fee + value', async () => {
    // Arbitrum 2026-10-10: the node rejected the swap at broadcast after the approval had been paid.
    const fake = fakeProvider() // 1 ETH balance
    const a = await new WalletManagerEvm(SEED, { provider: fake.provider }).getAccount(0)
    await expect(a.sendTransaction({ to: SPENDER, value: 1_000_000_000_000_000_000n })).rejects.toThrow(/Insufficient native balance/)
    expect(fake.sent).toHaveLength(0)
    await expect(a.sendTransaction({ to: SPENDER, value: 1n })).resolves.toMatchObject({ hash: '0x' + 'ab'.repeat(32) })
  })

  it('floors a zero priority fee on mainnet and lifts the cap by the same amount', async () => {
    // publicnode suggested 0 wei tip twice on 2026-10-09; one tx was evicted.
    const fake = fakeProvider({ eth_maxPriorityFeePerGas: () => '0x0' })
    const a = await new WalletManagerEvm(SEED, { provider: fake.provider }).getAccount(0)
    await a.sendTransaction({ to: SPENDER, value: 1n })
    const tx = parseTransaction(fake.sent[0]!)
    expect(tx.maxPriorityFeePerGas).toBe(50_000_000n)
    // viem: maxFee = baseFee × 1.2 + tip → 1.2e9 + 0 before the floor, + the floor after
    expect(tx.maxFeePerGas).toBe(1_200_000_000n + 50_000_000n)
    // a caller-fixed tip is never raised; other chains keep the network's answer
    const fixed = fakeProvider({ eth_maxPriorityFeePerGas: () => '0x0' })
    const b = await new WalletManagerEvm(SEED, { provider: fixed.provider }).getAccount(0)
    await b.sendTransaction({ to: SPENDER, value: 1n, maxPriorityFeePerGas: 0n, maxFeePerGas: 2_000_000_000n })
    expect(parseTransaction(fixed.sent[0]!).maxPriorityFeePerGas ?? 0n).toBe(0n)
    const l2 = fakeProvider({ eth_chainId: () => '0x2105', eth_maxPriorityFeePerGas: () => '0x0' })
    const c = await new WalletManagerEvm(SEED, { provider: l2.provider }).getAccount(0)
    await c.sendTransaction({ to: SPENDER, value: 1n })
    expect(parseTransaction(l2.sent[0]!).maxPriorityFeePerGas ?? 0n).toBe(0n)
  })

  it('keeps its own nonce floor across sends; one RPC\'s "nonce too low" is not re-signed, the next send skips the nonce', async () => {
    // Live 2026-10-09 (Base): `pending` came back stale right after our
    // approval was mined; the next tx reused the nonce and every node refused it.
    let count = 7
    const fake = fakeProvider({ eth_getTransactionCount: () => '0x' + count.toString(16) })
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    const a = await m.getAccount(0)
    await a.sendTransaction({ to: SPENDER, value: 1n })
    await a.sendTransaction({ to: SPENDER, value: 1n }) // RPC still says 7 → floor says 8
    expect(fake.sent.map((r) => parseTransaction(r).nonce)).toEqual([7, 8])
    count = 9 // the network moved ahead of the floor
    await a.sendTransaction({ to: SPENDER, value: 1n })
    expect(parseTransaction(fake.sent[2]!).nonce).toBe(9)
    m.dispose()

    const rejecting = fakeProvider({
      eth_getTransactionCount: () => '0x7',
      eth_sendRawTransaction: (p) => {
        const nonce = parseTransaction(p[0] as Hex).nonce
        if (nonce === 7) throw new Error('nonce too low: next nonce 9, tx nonce 7')
        rejecting.sent.push(p[0] as Hex)
        return '0x' + 'ab'.repeat(32)
      },
    })
    const m2 = new WalletManagerEvm(SEED, { provider: rejecting.provider })
    const a2 = await m2.getAccount(0)
    // One RPC cannot prove the nonce is taken by another transaction (scan 2026-10-30 F1): no second signature.
    await expect(a2.sendTransaction({ to: SPENDER, value: 1n })).rejects.toBeInstanceOf(NonceConflictError)
    expect(rejecting.sent).toEqual([])
    // the caller's retry takes the nonce the node named
    await expect(a2.sendTransaction({ to: SPENDER, value: 1n })).resolves.toMatchObject({ hash: '0x' + 'ab'.repeat(32) })
    expect(rejecting.sent.map((r) => parseTransaction(r).nonce)).toEqual([9])
    // a caller-fixed nonce is never second-guessed
    await expect(a2.sendTransaction({ to: SPENDER, value: 1n, nonce: 7 })).rejects.toThrow(/nonce too low/)
    m2.dispose()
  })

  it('a lost broadcast answer is "maybe sent" with the locally computed hash; a node refusal is not', async () => {
    let raw: Hex | undefined
    const lossy = fakeProvider({ eth_sendRawTransaction: (p) => { raw = p[0] as Hex; throw new Error('socket hang up') } })
    const a = await new WalletManagerEvm(SEED, { provider: lossy.provider }).getAccount(0)
    const err = await a.sendTransaction({ to: SPENDER, value: 1n }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BroadcastUnknownError)
    expect(err).toMatchObject({ maybeSent: true, hash: keccak256(raw!) })
    const refusing = fakeProvider({ eth_sendRawTransaction: () => { throw Object.assign(new Error('insufficient funds for gas * price + value'), { code: -32000 }) } })
    const b = await new WalletManagerEvm(SEED, { provider: refusing.provider }).getAccount(0)
    const refused = await b.sendTransaction({ to: SPENDER, value: 1n }).catch((e: unknown) => e)
    expect(refused).not.toBeInstanceOf(BroadcastUnknownError)
  })

  it('re-runs a reverting simulation only behind its own recent broadcast', async () => {
    // Live 2026-10-09 (Base): approval mined, the next tx's transferFrom
    // simulated against a lagging backend's allowance 0. (viem retries a
    // failed request itself, so the fake is driven by a flag, not a counter.)
    let stale = false
    const fake = fakeProvider({ eth_call: () => { if (stale) throw Object.assign(new Error('execution reverted: TRANSFER_FROM_FAILED'), { code: 3 }); return '0x' + '0'.repeat(64) } })
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    const a = await m.getAccount(0)
    // cold account: a revert is final at once (well under one settle delay)
    stale = true
    let t0 = Date.now()
    await expect(a.sendTransaction({ to: SPENDER, value: 1n })).rejects.toThrow(/TRANSFER_FROM_FAILED/)
    expect(Date.now() - t0).toBeLessThan(1_400) // viem retries its own request a few times first
    expect(fake.sent).toHaveLength(0)
    // after an own broadcast: the backend catches up during the settle window
    stale = false
    await a.sendTransaction({ to: SPENDER, value: 1n })
    stale = true
    setTimeout(() => { stale = false }, 2_000)
    t0 = Date.now()
    await expect(a.sendTransaction({ to: SPENDER, value: 1n })).resolves.toMatchObject({ hash: '0x' + 'ab'.repeat(32) })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_500)
    expect(fake.sent).toHaveLength(2)
    // …but a revert that never clears is still refused
    stale = true
    await expect(a.sendTransaction({ to: SPENDER, value: 1n })).rejects.toThrow(/TRANSFER_FROM_FAILED/)
    expect(fake.sent).toHaveLength(2)
    m.dispose()
  }, 30_000)

  it('transfer(ERC-20) encodes transfer(to, amount) and broadcasts a signed tx with fee = gas × feeRate', async () => {
    const fake = fakeProvider()
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    const a = await m.getAccount(0)
    const res = await a.transfer({ token: USDT, recipient: SPENDER, amount: 1_000_000n })
    expect(res.hash).toBe('0x' + 'ab'.repeat(32))
    expect(res.fee).toBe(25200n * 2_200_000_000n) // (21000 × 1.2 headroom) × maxFeePerGas, where viem estimates maxFee = baseFee × 1.2 + tip = 1.2e9 + 1e9
    const tx = parseTransaction(fake.sent[0]!)
    expect(tx.to?.toLowerCase()).toBe(USDT.toLowerCase())
    expect(tx.chainId).toBe(1)
    expect(tx.nonce).toBe(7)
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: tx.data! })
    expect(decoded.functionName).toBe('transfer')
    expect(decoded.args).toEqual([SPENDER, 1_000_000n])
    m.dispose()
  })

  it('transfer(native) sets value and empty data', async () => {
    const fake = fakeProvider()
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    await (await m.getAccount(0)).transfer({ recipient: SPENDER, amount: 5n })
    const tx = parseTransaction(fake.sent[0]!)
    expect(tx.value).toBe(5n)
    expect(tx.data ?? '0x').toBe('0x')
    m.dispose()
  })

  it('transferMaxFee is enforced before anything is sent', async () => {
    const fake = fakeProvider()
    const m = new WalletManagerEvm(SEED, { provider: fake.provider, transferMaxFee: 1n })
    await expect((await m.getAccount(0)).transfer({ recipient: SPENDER, amount: 5n })).rejects.toThrow(/maximum fee/)
    expect(fake.sent).toHaveLength(0)
    m.dispose()
  })

  it('approve on mainnet USDT refuses non-zero → non-zero unless autoResetAllowance', async () => {
    const nonZero = { eth_call: () => '0x' + '0'.repeat(63) + '5' }
    const fake = fakeProvider(nonZero)
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    await expect((await m.getAccount(0)).approve({ token: USDT, spender: SPENDER, amount: 10n })).rejects.toThrow(/reset to 0/)
    expect(fake.sent).toHaveLength(0)

    const fake2 = fakeProvider({ ...nonZero, eth_getTransactionReceipt: () => ({ transactionHash: '0x' + 'ab'.repeat(32), status: '0x1', blockNumber: '0x11', gasUsed: '0x5208', effectiveGasPrice: '0x1', from: HARDHAT0, to: USDT, contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256), blockHash: '0x' + '11'.repeat(32), transactionIndex: '0x0', cumulativeGasUsed: '0x5208', type: '0x2' }) })
    const m2 = new WalletManagerEvm(SEED, { provider: fake2.provider, autoResetAllowance: true })
    await (await m2.getAccount(0)).approve({ token: USDT, spender: SPENDER, amount: 10n })
    expect(fake2.sent).toHaveLength(2)
    const amounts = fake2.sent.map((raw) => decodeFunctionData({ abi: ERC20_ABI, data: parseTransaction(raw).data! }).args![1])
    expect(amounts).toEqual([0n, 10n])
    m.dispose(); m2.dispose()
  })

  it('read-only account has no signing methods; dispose kills signing', async () => {
    const m = new WalletManagerEvm(SEED)
    const a = await m.getAccount(0)
    const ro = a.toReadOnlyAccount()
    const bag = ro as unknown as Record<string, unknown>
    expect(bag.sign).toBeUndefined()
    expect(bag.sendTransaction).toBeUndefined()
    expect(await ro.getAddress()).toBe(HARDHAT0)
    m.dispose()
    await expect(a.sign('x')).rejects.toThrow(/disposed/)
  })

  it('getTransactionReceipt maps status to 1/0 and returns undefined when not found', async () => {
    const fake = fakeProvider({ eth_getTransactionReceipt: () => null })
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    expect(await (await m.getAccount(0)).getTransactionReceipt('0x' + 'ab'.repeat(32))).toBeUndefined()
    m.dispose()
  })
})

describe("typed data: domain chainId notation", () => {
  it("signs a domain whose chainId arrives as a hex string over chainId = NUMBER (what verifying contracts hash)", async () => {
    const {recoverTypedDataAddress} = await import("viem")
    const {typedDomainChainId} = await import("../src/account.js")
    expect(typedDomainChainId("0x89")).toBe(137)
    expect(typedDomainChainId("137")).toBe(137)
    expect(typedDomainChainId(137n)).toBe(137)
    expect(typedDomainChainId("nope")).toBeUndefined()
    const {WalletManagerEvm} = await import("../src/index.js")
    const manager = new WalletManagerEvm("test test test test test test test test test test test junk", {chainId: 137})
    const account = await manager.getAccount(0)
    const address = await account.getAddress()
    const types = {Order: [{name: "salt", type: "uint256"}, {name: "maker", type: "address"}]}
    const message = {salt: "1", maker: address}
    const domain = {name: "1inch Limit Order Protocol", version: "4", chainId: "0x89", verifyingContract: "0xafCF681272AF10959736f45616eeCBC22D7095E2"} as const
    const signature = (await account.signTypedData({domain, types, primaryType: "Order", message})) as `0x${string}`
    const recovered = await recoverTypedDataAddress({domain: {...domain, chainId: 137}, types, primaryType: "Order", message, signature})
    expect(recovered.toLowerCase()).toBe(address.toLowerCase())
    manager.dispose()
  })
})
