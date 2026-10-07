import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters, encodeErrorResult, encodeFunctionData, hashTypedData, maxUint256, parseTransaction,
  recoverTypedDataAddress, toHex, verifyTypedData, zeroAddress, type EIP1193Provider, type Hex,
} from 'viem'
import {
  ChainMismatchError, ERC20_ABI, ERC20_PERMIT_ABI, PermitUnsupportedError, SimulationError, UnsafeTransactionError,
  WalletManagerEvm, describeTransaction, describeTypedData, encodeApprove, encodeTransfer,
} from '../src/index.js'

const SEED = 'test test test test test test test test test test test junk'
const HARDHAT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const SPENDER = '0x000000000000000000000000000000000000bEEF'
const OTHER = '0x000000000000000000000000000000000000cafe'

const BLOCK = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }

function fakeProvider(overrides: Record<string, (params: unknown[]) => unknown> = {}) {
  const sent: Hex[] = []
  const calls: string[] = []
  const handlers: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => '0x1',
    eth_blockNumber: () => '0x10',
    eth_getBlockByNumber: () => BLOCK,
    eth_maxPriorityFeePerGas: () => '0x3b9aca00',
    eth_gasPrice: () => '0x6fc23ac00',
    eth_estimateGas: () => '0x5208',
    eth_getTransactionCount: () => '0x7',
    eth_call: () => '0x' + '0'.repeat(64),
    eth_sendRawTransaction: (p) => { sent.push(p[0] as Hex); return '0x' + 'ab'.repeat(32) },
    ...overrides,
  }
  return {
    sent, calls,
    provider: { request: async ({ method, params }: { method: string; params?: unknown }) => { calls.push(method); const h = handlers[method]; if (!h) throw new Error(`unmocked ${method}`); return h((params as unknown[]) ?? []) } } as unknown as EIP1193Provider,
  }
}

/** JSON-RPC revert the way nodes return it: error object with the revert data. */
function revertWith(data: Hex) {
  return () => { throw Object.assign(new Error('execution reverted'), { code: 3, data }) }
}

describe('describeTransaction', () => {
  it('classifies native / erc20 transfer / transferFrom / approve / call / deploy / 7702', () => {
    expect(describeTransaction({ to: SPENDER, value: 5n })).toMatchObject({ kind: 'native-transfer', recipient: SPENDER, value: 5n, selector: undefined })
    expect(describeTransaction({ to: USDT, data: encodeTransfer(SPENDER, 7n) })).toMatchObject({ kind: 'erc20-transfer', token: USDT, recipient: SPENDER, amount: 7n, selector: '0xa9059cbb' })
    const tf = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transferFrom', args: [OTHER, SPENDER, 9n] })
    const dtf = describeTransaction({ to: USDT, data: tf })
    expect(dtf).toMatchObject({ kind: 'erc20-transferFrom', recipient: SPENDER, amount: 9n })
    expect(dtf.owner?.toLowerCase()).toBe(OTHER) // returned checksummed
    expect(describeTransaction({ to: USDT, data: encodeApprove(SPENDER, 3n) })).toMatchObject({ kind: 'erc20-approve', spender: SPENDER, amount: 3n, warnings: [] })
    expect(describeTransaction({ to: USDT, data: '0xdeadbeef' })).toMatchObject({ kind: 'contract-call', selector: '0xdeadbeef' })
    expect(describeTransaction({ data: '0x6080' })).toMatchObject({ kind: 'contract-deploy', to: undefined })
    const d = describeTransaction({ to: HARDHAT0, type: 4, authorizationList: [{ chainId: 1, address: SPENDER, nonce: 0, r: '0x1', s: '0x1', yParity: 0 }] })
    expect(d).toMatchObject({ kind: 'eip7702-delegation', delegations: [{ chainId: 1, address: SPENDER }] })
  })

  it('warns on unlimited approve, zero address, chain mismatch, legacy fees', () => {
    const codes = (tx: Parameters<typeof describeTransaction>[0], ctx?: { chainId?: number }) => describeTransaction(tx, ctx).warnings.map((w) => w.code)
    expect(codes({ to: USDT, data: encodeApprove(SPENDER, maxUint256) })).toEqual(['approve-unlimited'])
    expect(codes({ to: USDT, data: encodeApprove(SPENDER, 2n ** 255n) })).toEqual(['approve-unlimited'])
    expect(codes({ to: zeroAddress, value: 1n })).toEqual(['to-zero-address'])
    expect(codes({ to: zeroAddress, value: 0n })).toEqual([]) // a plain 0-value call to 0x0 is odd but not a burn
    expect(codes({ to: SPENDER, value: 1n, chainId: 10 }, { chainId: 1 })).toEqual(['chain-mismatch'])
    expect(codes({ to: SPENDER, value: 1n, chainId: 1 }, { chainId: 1 })).toEqual([])
    expect(codes({ to: SPENDER, value: 1n, gasPrice: 1n })).toEqual(['legacy-fee-fields'])
  })
})

describe('describeTypedData', () => {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const permit = (over: Record<string, unknown> = {}, domain: Record<string, unknown> = {}) => ({
    domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDT, ...domain },
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    message: { owner: HARDHAT0, spender: SPENDER, value: 100n, nonce: 0n, deadline: now + 600n, ...over },
  })

  it('recognises EIP-2612 permit and its fields', () => {
    const d = describeTypedData(permit(), { chainId: 1, account: HARDHAT0 })
    expect(d.kind).toBe('permit')
    expect(d.primaryType).toBe('Permit')
    expect(d.domain).toEqual({ name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDT })
    expect(d.permit).toEqual({ owner: HARDHAT0, spender: SPENDER, value: 100n, nonce: 0n, deadline: now + 600n })
    expect(d.warnings).toEqual([])
  })

  it('warns on chain mismatch, passed deadline, unlimited value, foreign owner', () => {
    const codes = (t: ReturnType<typeof permit>, ctx?: { chainId?: number; account?: string }) => describeTypedData(t, ctx).warnings.map((w) => w.code)
    expect(codes(permit({}, { chainId: 137 }), { chainId: 1 })).toEqual(['chain-mismatch'])
    expect(codes(permit({ deadline: now - 1n }))).toEqual(['deadline-passed'])
    expect(codes(permit({ value: maxUint256 }))).toEqual(['approve-unlimited'])
    expect(codes(permit(), { account: OTHER })).toEqual(['owner-mismatch'])
    expect(codes(permit(), { account: HARDHAT0.toLowerCase() })).toEqual([])
  })

  it('classifies permit2, SafeTx and generic', () => {
    const p2 = describeTypedData({
      domain: { name: 'Permit2', chainId: 1, verifyingContract: SPENDER },
      types: { PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
      message: { details: { token: USDT, amount: 2n ** 160n - 1n, expiration: 0, nonce: 0 }, spender: OTHER, sigDeadline: 1n },
    })
    expect(p2.kind).toBe('permit2')
    expect(p2.warnings.map((w) => w.code)).toEqual(['approve-unlimited', 'deadline-passed'])
    expect(describeTypedData({ domain: { chainId: 1, verifyingContract: SPENDER }, types: { SafeTx: [{ name: 'to', type: 'address' }] }, message: { to: OTHER } }).kind).toBe('safe-tx')
    expect(describeTypedData({ domain: { name: 'Forge' }, types: { Mail: [{ name: 'to', type: 'address' }] }, message: { to: OTHER } }).kind).toBe('generic')
  })
})

describe('hard checks before signing', () => {
  it('chain mismatch: tx.chainId ≠ account chain throws ChainMismatchError; offline wallet without chainId still signs', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const a = await m.getAccount(0)
    const tx = { to: SPENDER, value: 1n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }
    await expect(a.signTransaction({ ...tx, chainId: 10 })).rejects.toBeInstanceOf(ChainMismatchError)
    expect(parseTransaction((await a.signTransaction({ ...tx, chainId: 1 })) as Hex).chainId).toBe(1)
    m.dispose()
    // No provider, no config.chainId: the tx's chain is the only one known — must keep working.
    const m2 = new WalletManagerEvm(SEED)
    expect(parseTransaction((await (await m2.getAccount(0)).signTransaction({ ...tx, chainId: 10 })) as Hex).chainId).toBe(10)
    m2.dispose()
  })

  it('chain mismatch after detection: a detected chain also guards', async () => {
    const fake = fakeProvider()
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    const a = await m.getAccount(0)
    await expect(a.sendTransaction({ to: SPENDER, value: 1n, chainId: 10 })).rejects.toBeInstanceOf(ChainMismatchError)
    expect(fake.sent).toHaveLength(0)
    m.dispose()
  })

  it('value to the zero address is refused unless allowBurn', async () => {
    const fake = fakeProvider()
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    await expect((await m.getAccount(0)).sendTransaction({ to: zeroAddress, value: 1n })).rejects.toBeInstanceOf(UnsafeTransactionError)
    await expect((await m.getAccount(0)).signTransaction({ to: zeroAddress, value: 1n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, chainId: 1 })).rejects.toBeInstanceOf(UnsafeTransactionError)
    expect(fake.sent).toHaveLength(0)
    const m2 = new WalletManagerEvm(SEED, { provider: fake.provider, allowBurn: true })
    await (await m2.getAccount(0)).sendTransaction({ to: zeroAddress, value: 1n })
    expect(fake.sent).toHaveLength(1)
    m.dispose(); m2.dispose()
  })

  it('typed data for another chain is refused unless allowCrossChainTypedData', async () => {
    const typed = { domain: { name: 'X', version: '1', chainId: 137, verifyingContract: SPENDER }, types: { Mail: [{ name: 'to', type: 'address' }] }, message: { to: OTHER } }
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    await expect((await m.getAccount(0)).signTypedData(typed)).rejects.toBeInstanceOf(ChainMismatchError)
    const m2 = new WalletManagerEvm(SEED, { chainId: 1, allowCrossChainTypedData: true })
    expect(await (await m2.getAccount(0)).signTypedData(typed)).toMatch(/^0x[0-9a-f]{130}$/)
    const m3 = new WalletManagerEvm(SEED) // chain unknown → nothing to compare against
    expect(await (await m3.getAccount(0)).signTypedData(typed)).toMatch(/^0x[0-9a-f]{130}$/)
    m.dispose(); m2.dispose(); m3.dispose()
  })
})

describe('simulation', () => {
  const insufficient = encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'm' }] }], errorName: 'Error', args: ['Insufficient balance'] })

  it('simulateTransaction surfaces a decoded revert without throwing', async () => {
    const fake = fakeProvider({ eth_call: revertWith(insufficient) })
    const a = await new WalletManagerEvm(SEED, { provider: fake.provider }).getAccount(0)
    const sim = await a.simulateTransaction({ to: USDT, data: encodeTransfer(SPENDER, 1n) })
    expect(sim).toEqual({ ok: false, reason: 'Insufficient balance', data: insufficient })
  })

  it('decodes Panic and custom errors', async () => {
    const panic = encodeErrorResult({ abi: [{ type: 'error', name: 'Panic', inputs: [{ type: 'uint256', name: 'c' }] }], errorName: 'Panic', args: [0x11n] })
    const a = await new WalletManagerEvm(SEED, { provider: fakeProvider({ eth_call: revertWith(panic) }).provider }).getAccount(0)
    expect(await a.simulateTransaction({ to: USDT, data: '0x' })).toMatchObject({ ok: false, reason: 'panic 0x11: arithmetic overflow/underflow' })
    const custom = ('0x12345678' + encodeAbiParameters([{ type: 'uint256' }], [1n]).slice(2)) as Hex
    const b = await new WalletManagerEvm(SEED, { provider: fakeProvider({ eth_call: revertWith(custom) }).provider }).getAccount(0)
    expect(await b.simulateTransaction({ to: USDT, data: '0x' })).toMatchObject({ ok: false, reason: 'reverted with custom error 0x12345678', data: custom })
  })

  it('a successful simulation returns gas and return data', async () => {
    const fake = fakeProvider({ eth_call: () => toHex(1n, { size: 32 }) })
    const a = await new WalletManagerEvm(SEED, { provider: fake.provider }).getAccount(0)
    expect(await a.simulateTransaction({ to: USDT, data: encodeTransfer(SPENDER, 1n) })).toEqual({ ok: true, gas: 21000n, returnData: toHex(1n, { size: 32 }) })
  })

  it('sendTransaction throws SimulationError before signing or broadcasting', async () => {
    const fake = fakeProvider({ eth_call: revertWith(insufficient) })
    const a = await new WalletManagerEvm(SEED, { provider: fake.provider }).getAccount(0)
    const err = await a.sendTransaction({ to: USDT, data: encodeTransfer(SPENDER, 1n) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SimulationError)
    expect((err as SimulationError).reason).toBe('Insufficient balance')
    expect(fake.sent).toHaveLength(0)
    expect(fake.calls).not.toContain('eth_sendRawTransaction')
  })

  it('simulate: false skips eth_call; estimateGas runs once either way', async () => {
    const fakeOff = fakeProvider({ eth_call: revertWith(insufficient) })
    const off = await new WalletManagerEvm(SEED, { provider: fakeOff.provider, simulate: false }).getAccount(0)
    await off.sendTransaction({ to: SPENDER, value: 1n })
    expect(fakeOff.sent).toHaveLength(1)
    expect(fakeOff.calls.filter((c) => c === 'eth_call')).toHaveLength(0)
    expect(fakeOff.calls.filter((c) => c === 'eth_estimateGas')).toHaveLength(1)

    const fakeOn = fakeProvider()
    const on = await new WalletManagerEvm(SEED, { provider: fakeOn.provider }).getAccount(0)
    await on.sendTransaction({ to: SPENDER, value: 1n })
    expect(fakeOn.calls.filter((c) => c === 'eth_call')).toHaveLength(1)
    expect(fakeOn.calls.filter((c) => c === 'eth_estimateGas')).toHaveLength(1)
    expect(parseTransaction(fakeOn.sent[0]!).gas).toBe(25200n) // estimate × 1.2 headroom
  })
})

describe('EIP-2612 permit', () => {
  const NAME = 'USD Coin'
  const VERSION = '2'
  const separatorFor = (version: string) => hashTypedData({ domain: { name: NAME, version, chainId: 1, verifyingContract: USDT }, types: { EIP712Domain: [] }, primaryType: 'EIP712Domain', message: {} } as never)

  /** eth_call routed by selector: name() / version() / nonces() / DOMAIN_SEPARATOR(). */
  function tokenCalls(opts: { version?: string | 'revert'; nonce?: bigint; separator?: Hex; noncesRevert?: boolean } = {}) {
    const sel = (fn: 'name' | 'version' | 'nonces' | 'DOMAIN_SEPARATOR') => encodeFunctionData({ abi: ERC20_PERMIT_ABI, functionName: fn, args: fn === 'nonces' ? [HARDHAT0] : [] } as never).slice(0, 10)
    return (params: unknown[]) => {
      const data = String((params[0] as { data: string }).data)
      const s = data.slice(0, 10)
      if (s === sel('name')) return encodeAbiParameters([{ type: 'string' }], [NAME])
      if (s === sel('version')) { if (opts.version === 'revert') throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' }); return encodeAbiParameters([{ type: 'string' }], [opts.version ?? VERSION]) }
      if (s === sel('nonces')) { if (opts.noncesRevert) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' }); return encodeAbiParameters([{ type: 'uint256' }], [opts.nonce ?? 3n]) }
      if (s === sel('DOMAIN_SEPARATOR')) return opts.separator ?? separatorFor(VERSION)
      return '0x' + '0'.repeat(64)
    }
  }

  it('getPermitInfo reproduces the on-chain domain; signPermit yields a signature the contract domain verifies', async () => {
    const fake = fakeProvider({ eth_call: tokenCalls() })
    const a = await new WalletManagerEvm(SEED, { provider: fake.provider }).getAccount(0)
    const info = await a.getPermitInfo(USDT)
    expect(info).toEqual({ supported: true, name: NAME, version: VERSION, nonce: 3n, domainSeparator: separatorFor(VERSION), chainId: 1 })

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const p = await a.signPermit({ token: USDT, spender: SPENDER, value: 1_000_000n, deadline })
    expect(p.nonce).toBe(3n)
    expect(p.deadline).toBe(deadline)
    expect([27, 28]).toContain(p.v)
    expect(`0x${p.r.slice(2)}${p.s.slice(2)}${p.v.toString(16)}`).toBe(p.signature)
    const typed = { domain: { name: NAME, version: VERSION, chainId: 1, verifyingContract: USDT }, types: p.typedData.types, primaryType: 'Permit', message: p.typedData.message } as const
    expect(await verifyTypedData({ ...typed, address: HARDHAT0, signature: p.signature } as never)).toBe(true)
    expect(await recoverTypedDataAddress({ ...typed, signature: p.signature } as never)).toBe(HARDHAT0)
    expect(p.typedData.message).toMatchObject({ owner: HARDHAT0, spender: SPENDER, value: 1_000_000n, nonce: 3n, deadline })
    expect(fake.sent).toHaveLength(0)
  })

  it('falls back to version "1" when version() reverts and the separator matches it', async () => {
    const fake = fakeProvider({ eth_call: tokenCalls({ version: 'revert', separator: separatorFor('1') }) })
    const a = await new WalletManagerEvm(SEED, { provider: fake.provider }).getAccount(0)
    expect(await a.getPermitInfo(USDT)).toMatchObject({ supported: true, version: '1' })
  })

  it('unsupported: nonces() reverts, or the domain cannot be reproduced', async () => {
    const a = await new WalletManagerEvm(SEED, { provider: fakeProvider({ eth_call: tokenCalls({ noncesRevert: true }) }).provider }).getAccount(0)
    expect(await a.getPermitInfo(USDT)).toMatchObject({ supported: false })
    await expect(a.signPermit({ token: USDT, spender: SPENDER, value: 1n, deadline: 1n })).rejects.toBeInstanceOf(PermitUnsupportedError)

    const b = await new WalletManagerEvm(SEED, { provider: fakeProvider({ eth_call: tokenCalls({ separator: ('0x' + 'ff'.repeat(32)) as Hex }) }).provider }).getAccount(0)
    expect(await b.getPermitInfo(USDT)).toMatchObject({ supported: false, reason: expect.stringMatching(/domain/) })
  })
})

describe('gas headroom', () => {
  it('estimated gas gets ×1.2 by default, gasHeadroom: 1 disables it, a caller limit is used as is', async () => {
    const run = async (config: Record<string, unknown>, gasLimit?: bigint) => {
      const fake = fakeProvider()
      const a = await new WalletManagerEvm(SEED, { provider: fake.provider, ...config }).getAccount(0)
      await a.sendTransaction({ to: SPENDER, value: 1n, ...(gasLimit !== undefined ? { gasLimit } : {}) })
      return parseTransaction(fake.sent[0]!).gas
    }
    expect(await run({})).toBe(25200n)
    expect(await run({ gasHeadroom: 1 })).toBe(21000n)
    expect(await run({ gasHeadroom: 1.5 })).toBe(31500n)
    expect(await run({}, 30000n)).toBe(30000n)
  })
})
