// Module watch 2026-11-04, permit2-zksync-gap: Uniswap documents a second Permit2 on zkSync Era (eip155:324),
// 0x0000000000225e31D15943971F47aD3022F714Fa (EraVM), and the CREATE2 one is live there too (EVM emulator); both
// emit events and hold allowances. Discovery, verification, revokes, isRevokeTransaction and activity knew only the
// CREATE2 address. EIP-1193 doubles only.
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ChainTx } from '@anywalletkit/core'
import {
  decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, numberToHex, pad, type Hex,
} from 'viem'

import ApprovalsProtocolEvm, {
  ApprovalsError, STANDARDS, describeApprovalActivity, isRevokeTransaction, parseApprovalLog,
  type AccountLike, type Approval, type CacheEntry, type EvmApproval, type RevokeTransaction,
} from '../src/index.js'

const { TOPICS, PERMIT2_ABI, PERMIT2_ADDRESS, PERMIT2_ZKSYNC_ADDRESS, permit2AddressFor, permit2AddressesFor, isPermit2Address } = STANDARDS
const OWNER = getAddress('0x1111111111111111111111111111111111111111')
const ROUTER = getAddress('0x9999999999999999999999999999999999999999')
const OTHER = getAddress('0x00000000000000000000000000000000000000aa')
const USDC = getAddress('0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4') // USDC on zkSync Era
const HASH = '0x' + 'ab'.repeat(32)
const ZK = getAddress(PERMIT2_ZKSYNC_ADDRESS)
const topic = (a: string): Hex => pad(a as Hex, { size: 32 })
const ALLOWANCE = encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'allowance', args: [OWNER, USDC, ROUTER] }).slice(0, 10)

let seq = 0
const p2Approval = (permit2: string, token: string, spender: string, amount: bigint, block: number) => ({
  address: permit2, topics: [TOPICS.permit2Approval, topic(OWNER), topic(token), topic(spender)],
  data: encodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }], [amount, 0]),
  blockNumber: numberToHex(block), blockHash: '0x' + '11'.repeat(32), transactionHash: '0x' + block.toString(16).padStart(64, '0'),
  transactionIndex: '0x0', logIndex: numberToHex(++seq), removed: false,
})

/**
 * A chain at block 1000 with `chainId`, `logs`, and Permit2 allowances per `<permit2>:<token>:<spender>`;
 * records every eth_call target and every eth_getLogs range (and answers it with the logs in that range).
 */
function chain (chainId: number, logs: ReturnType<typeof p2Approval>[], allowances: Record<string, bigint>) {
  const reads: string[] = []
  const ranges: Array<[number, number]> = []
  return {
    reads,
    ranges,
    async request ({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      const p = params as unknown[]
      if (method === 'eth_chainId') return numberToHex(chainId)
      if (method === 'eth_blockNumber') return '0x3e8'
      if (method === 'eth_getCode') return '0x6080'
      if (method === 'eth_getLogs') {
        const { fromBlock, toBlock } = p[0] as { fromBlock: string; toBlock: string }
        const range: [number, number] = [Number(fromBlock), Number(toBlock)]
        ranges.push(range)
        return logs.filter((l) => Number(l.blockNumber) >= range[0] && Number(l.blockNumber) <= range[1])
      }
      if (method === 'eth_call') {
        const { to, data } = p[0] as { to: string; data: string }
        reads.push(getAddress(to))
        if (data.slice(0, 10) !== ALLOWANCE) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' })
        const [, token, spender] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], ('0x' + data.slice(10)) as Hex)
        const amount = allowances[`${getAddress(to)}:${getAddress(token)}:${getAddress(spender)}`] ?? 0n
        return encodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }], [amount, 0, 1])
      }
      throw new Error(`unexpected ${method}`)
    },
  }
}

function account (provider: unknown) {
  const sent: Array<RevokeTransaction | RevokeTransaction[]> = []
  const a: AccountLike & { sent: typeof sent; _config: { provider: unknown } } = {
    sent, _config: { provider },
    async getAddress () { return OWNER },
    async sendTransaction (tx) { sent.push(tx); return { hash: HASH, fee: 1n } },
  }
  return a
}

const lockdownPairs = (data: string) => (decodeFunctionData({ abi: PERMIT2_ABI, data: data as Hex }).args[0] as Array<{ token: string; spender: string }>).map((x) => [x.token, x.spender])
const p2 = (over: Partial<EvmApproval>): Approval => ({ id: 'x', standard: 'permit2', chainId: 324, token: USDC, spender: ROUTER, amount: 1n, unlimited: false, risks: [], ...over }) as Approval

describe('watch 2026-11-04 permit2-zksync: the per-chain Permit2 lookup', () => {
  test('zkSync Era has two Permit2s and documents its own; every other chain has the CREATE2 one only', () => {
    for (const id of [324, '324', '0x144', 'eip155:324']) {
      assert.equal(permit2AddressFor(id), PERMIT2_ZKSYNC_ADDRESS)
      assert.deepEqual(permit2AddressesFor(id), [PERMIT2_ADDRESS, PERMIT2_ZKSYNC_ADDRESS])
    }
    for (const id of [1, 8453, 'eip155:1', 300]) {
      assert.equal(permit2AddressFor(id), PERMIT2_ADDRESS)
      assert.deepEqual(permit2AddressesFor(id), [PERMIT2_ADDRESS])
    }
    assert.equal(isPermit2Address(ZK.toLowerCase(), 324), true)
    assert.equal(isPermit2Address(PERMIT2_ADDRESS, 324), true)
    assert.equal(isPermit2Address(ZK, 1), false)
    assert.equal(isPermit2Address(ZK, undefined), false)
  })
})

describe('watch 2026-11-04 permit2-zksync: discovery and verification', () => {
  test('events from zkSync Era\'s Permit2 are candidates that name it; the CREATE2 one stays implicit; look-alikes stay out', () => {
    assert.equal(parseApprovalLog(p2Approval(ZK, USDC, ROUTER, 5n, 10), OWNER)?.permit2, ZK)
    const canonical = parseApprovalLog(p2Approval(PERMIT2_ADDRESS, USDC, ROUTER, 5n, 11), OWNER)!
    assert.equal(canonical.kind, 'permit2')
    assert.equal('permit2' in canonical, false)
    assert.equal(parseApprovalLog(p2Approval(OTHER, USDC, ROUTER, 5n, 12), OWNER), null)
  })

  test('on 324 the same pair on both Permit2s is two approvals, each read on and revoked at its own contract', async () => {
    const provider = chain(324, [p2Approval(PERMIT2_ADDRESS, USDC, ROUTER, 7n, 100), p2Approval(ZK, USDC, ROUTER, 9n, 200)],
      { [`${PERMIT2_ADDRESS}:${USDC}:${ROUTER}`]: 7n, [`${ZK}:${USDC}:${ROUTER}`]: 9n })
    const acct = account(provider)
    const protocol = new ApprovalsProtocolEvm(acct, { multicall: false })
    const { approvals } = await protocol.getApprovals()
    const list = approvals.filter((a) => a.standard === 'permit2') as EvmApproval[]
    assert.deepEqual(list.map((a) => [a.permit2, a.amount]).sort(), [[PERMIT2_ADDRESS, 7n], [ZK, 9n]].sort())
    assert.deepEqual(new Set(provider.reads), new Set([PERMIT2_ADDRESS, ZK]))
    const ids = list.map((a) => a.id)
    assert.equal(new Set(ids).size, 2)
    assert.ok(ids.includes(`324:permit2:${USDC.toLowerCase()}:${ROUTER.toLowerCase()}`)) // unchanged for the CREATE2 Permit2
    assert.ok(ids.includes(`324:permit2:${USDC.toLowerCase()}:${ROUTER.toLowerCase()}@${ZK.toLowerCase()}`))

    const zk = list.find((a) => a.permit2 === ZK)!
    await protocol.revoke(zk)
    assert.equal((acct.sent.at(-1) as RevokeTransaction).to, ZK)
    assert.equal(isRevokeTransaction(acct.sent.at(-1) as RevokeTransaction, { chainId: 324 }), true)

    // revokeAll: one lockdown per Permit2 contract
    acct.sent.length = 0
    const results = await protocol.revokeAll(list)
    assert.equal(results.length, 2)
    assert.deepEqual((acct.sent as RevokeTransaction[]).map((t) => t.to).sort(), [PERMIT2_ADDRESS, ZK].sort())
    for (const t of acct.sent as RevokeTransaction[]) assert.deepEqual(lockdownPairs(t.data), [[USDC, ROUTER]])
    assert.throws(() => protocol.buildRevokeTransaction(list), (e: unknown) => e instanceof ApprovalsError && e.reason === 'invalid-approval')
  })

  test('on any other chain a candidate naming zkSync Era\'s Permit2 is dropped, never read', async () => {
    const provider = chain(1, [p2Approval(ZK, USDC, ROUTER, 9n, 200)], { [`${ZK}:${USDC}:${ROUTER}`]: 9n })
    const { approvals } = await new ApprovalsProtocolEvm(account(provider), { multicall: false }).getApprovals()
    assert.deepEqual(approvals, [])
    assert.deepEqual(provider.reads, [])
  })
})

describe('watch 2026-11-04 permit2-zksync: revokes go only to a Permit2 of the approval\'s chain', () => {
  const protocol = new ApprovalsProtocolEvm(account(chain(324, [], {})))
  const refused = (e: unknown) => e instanceof ApprovalsError && e.reason === 'invalid-approval'

  test('the approval\'s Permit2, the CREATE2 one when absent; another chain\'s or a stranger contract is refused', () => {
    assert.equal(protocol.buildRevokeTransaction(p2({ permit2: ZK })).to, ZK)
    assert.equal(protocol.buildRevokeTransaction(p2({ permit2: ZK.toLowerCase() })).to, ZK)
    assert.equal(protocol.buildRevokeTransaction(p2({})).to, PERMIT2_ADDRESS)
    assert.equal(protocol.buildRevokeTransaction(p2({ chainId: 1 })).to, PERMIT2_ADDRESS)
    assert.throws(() => protocol.buildRevokeTransaction(p2({ chainId: 1, permit2: ZK })), refused)
    assert.throws(() => protocol.buildRevokeTransaction(p2({ permit2: OTHER })), refused)
    assert.throws(() => protocol.buildRevokeTransaction(p2({ permit2: 'nope' })), refused)
  })

  test('isRevokeTransaction: a lockdown to zkSync Era\'s Permit2 counts only with chainId 324', () => {
    const tx = protocol.buildRevokeTransaction(p2({ permit2: ZK }))
    assert.equal(isRevokeTransaction(tx), false)
    assert.equal(isRevokeTransaction(tx, { chainId: 1 }), false)
    assert.equal(isRevokeTransaction(tx, { chainId: 324 }), true)
    assert.equal(isRevokeTransaction(tx, { chainId: 'eip155:324' }), true)
    assert.equal(isRevokeTransaction({ ...tx, to: PERMIT2_ADDRESS }, { chainId: 324 }), true)
    assert.equal(isRevokeTransaction({ ...tx, to: PERMIT2_ADDRESS }), true)
    assert.equal(isRevokeTransaction({ ...tx, to: OTHER }, { chainId: 324 }), false)
  })
})

describe('watch 2026-11-04 permit2-zksync: activity', () => {
  const ctx = { own: new Set([OWNER, OWNER.toLowerCase()]) }
  const word = (hex: string | bigint) => (typeof hex === 'bigint' ? hex.toString(16) : hex.replace(/^0x/, '').toLowerCase()).padStart(64, '0')
  const tx = (chainId: number, to: string, data: string): ChainTx => ({
    chain: `eip155:${chainId}`, hash: HASH, time: 1, status: 'confirmed', address: OWNER, from: OWNER, to, nativeValue: 0n, transfers: [],
    call: { to, selector: data.slice(0, 10), data },
  })
  const approve2 = '0x87517c45' + word(USDC) + word(ROUTER) + word(5n) + word(0n)
  const lockdown = encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'lockdown', args: [[{ token: USDC, spender: ROUTER }, { token: OTHER, spender: ROUTER }]] })
  const tokens = { [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 } }

  test('a Permit2 approve / lockdown on zkSync Era\'s Permit2 reads as one on 324', () => {
    assert.deepEqual(
      (({ kind, title, subtitle }) => ({ kind, title, subtitle }))(describeApprovalActivity(tx(324, ZK, approve2), ctx, { tokens })!),
      { kind: 'approve', title: 'Approved USDC for 0x9999…9999', subtitle: 'Permit2 · zkSync Era' })
    assert.equal(describeApprovalActivity(tx(324, ZK, approve2.slice(0, 74) + word(ROUTER) + word(0n) + word(0n)), ctx, { tokens })?.kind, 'revoke')
    const lock = describeApprovalActivity(tx(324, ZK, lockdown), ctx)!
    assert.deepEqual([lock.kind, lock.title, lock.subtitle], ['revoke', 'Revoked Permit2 allowances', 'Permit2 · zkSync Era'])
    // the CREATE2 Permit2 is still recognised on 324
    assert.equal(describeApprovalActivity(tx(324, PERMIT2_ADDRESS, approve2), ctx, { tokens })?.subtitle, 'Permit2 · zkSync Era')
  })

  test('an ERC-20 approve of zkSync Era\'s Permit2 is titled "for Permit2"; the address is no Permit2 on other chains', () => {
    const erc20 = '0x095ea7b3' + word(ZK) + word((1n << 256n) - 1n)
    assert.equal(describeApprovalActivity(tx(324, USDC, erc20), ctx, { tokens })?.title, 'Approved USDC for Permit2')
    assert.equal(describeApprovalActivity(tx(1, ZK, approve2), ctx, { tokens }), null)
  })
})

describe('watch 2026-11-04 permit2-zksync: a scan cache from before zkSync Era\'s Permit2 was known', () => {
  const KEY = `324:${OWNER.toLowerCase()}`
  const store = (entries: Record<string, unknown>) => {
    const m = new Map<string, CacheEntry>(Object.entries(entries) as Array<[string, CacheEntry]>)
    return { m, cache: { get: (k: string) => m.get(k), set: (k: string, v: CacheEntry) => { m.set(k, v) } } }
  }
  // What the previous release cached on 324: the CREATE2 Permit2's candidate, no marker, toBlock past the zkSync Permit2's log.
  const old = { fromBlock: 50, toBlock: 1000, candidates: [{ kind: 'permit2', token: USDC, spender: ROUTER, block: 100, txHash: HASH, logIndex: 1 }] }
  const both = [PERMIT2_ADDRESS.toLowerCase(), ZK.toLowerCase()]

  test('on 324 an entry without the marker is scanned again from its fromBlock and the missed allowance is found', async () => {
    const provider = chain(324, [p2Approval(PERMIT2_ADDRESS, USDC, ROUTER, 7n, 100), p2Approval(ZK, USDC, ROUTER, 9n, 200)],
      { [`${PERMIT2_ADDRESS}:${USDC}:${ROUTER}`]: 7n, [`${ZK}:${USDC}:${ROUTER}`]: 9n })
    const { m, cache } = store({ [KEY]: old })
    const protocol = new ApprovalsProtocolEvm(account(provider), { multicall: false, fromBlock: 50, cache })
    const first = await protocol.getApprovals()
    assert.deepEqual(provider.ranges, [[50, 1000]])
    assert.deepEqual((first.approvals as EvmApproval[]).map((a) => [a.permit2, a.amount]).sort(), [[PERMIT2_ADDRESS, 7n], [ZK, 9n]].sort())
    assert.equal(first.coverage.fromBlock, 50)
    assert.deepEqual(m.get(KEY)!.permit2, both)
    assert.deepEqual([m.get(KEY)!.fromBlock, m.get(KEY)!.toBlock], [50, 1000])

    // once marked, the next scan is incremental again (nothing new past 1000) and still reports both
    const second = await protocol.getApprovals()
    assert.deepEqual(provider.ranges, [[50, 1000]])
    assert.equal(second.approvals.length, 2)
  })

  test('a marker missing zkSync Era\'s Permit2, or a malformed one, rescans too; a rescan cut short keeps the old marker', async () => {
    for (const permit2 of [[PERMIT2_ADDRESS.toLowerCase()], 'all', [42]]) {
      const provider = chain(324, [p2Approval(ZK, USDC, ROUTER, 9n, 200)], { [`${ZK}:${USDC}:${ROUTER}`]: 9n })
      const { m, cache } = store({ [KEY]: { ...old, permit2 } })
      const { approvals } = await new ApprovalsProtocolEvm(account(provider), { multicall: false, cache }).getApprovals()
      assert.deepEqual(provider.ranges, [[50, 1000]])
      assert.ok((approvals as EvmApproval[]).some((a) => a.permit2 === ZK))
      assert.deepEqual(m.get(KEY)!.permit2, both)
    }
    // toBlock short of the cached toBlock: (500, 1000] is still unscanned for zkSync Era's Permit2
    const provider = chain(324, [p2Approval(ZK, USDC, ROUTER, 9n, 200)], { [`${ZK}:${USDC}:${ROUTER}`]: 9n })
    const { m, cache } = store({ [KEY]: old })
    await new ApprovalsProtocolEvm(account(provider), { multicall: false, cache }).getApprovals({ toBlock: 500 })
    assert.deepEqual(provider.ranges, [[50, 500]])
    assert.equal(m.get(KEY)!.toBlock, 1000)
    assert.equal('permit2' in m.get(KEY)!, false)
    // the next full scan still rescans from 50
    await new ApprovalsProtocolEvm(account(provider), { multicall: false, cache }).getApprovals()
    assert.deepEqual(provider.ranges.at(-1), [50, 1000])
    assert.deepEqual(m.get(KEY)!.permit2, both)
  })

  test('on any other chain an entry without the marker stays incremental, and new entries carry it', async () => {
    const provider = chain(1, [], {})
    const key = `1:${OWNER.toLowerCase()}`
    const { m, cache } = store({ [key]: { ...old, toBlock: 900 } })
    await new ApprovalsProtocolEvm(account(provider), { multicall: false, cache }).getApprovals()
    assert.deepEqual(provider.ranges, [[901, 1000]])
    assert.deepEqual(m.get(key)!.permit2, [PERMIT2_ADDRESS.toLowerCase()])
  })
})

describe('watch 2026-11-04 permit2-zksync: review follow-ups', () => {
  const protocol = new ApprovalsProtocolEvm(account(chain(324, [], {})))
  const refused = (e: unknown) => e instanceof ApprovalsError && e.reason === 'invalid-approval'
  const zkId = `324:permit2:${USDC.toLowerCase()}:${ROUTER.toLowerCase()}@${ZK.toLowerCase()}`

  test('an approval kept without `permit2` is revoked on the Permit2 its id names; a contradicting `permit2` is refused', () => {
    assert.equal(protocol.buildRevokeTransaction(p2({ id: zkId })).to, ZK)
    assert.equal(protocol.buildRevokeTransaction(p2({ id: zkId, permit2: ZK })).to, ZK)
    assert.equal(protocol.buildRevokeTransaction(p2({ id: `324:permit2:${USDC.toLowerCase()}:${ROUTER.toLowerCase()}` })).to, PERMIT2_ADDRESS)
    assert.throws(() => protocol.buildRevokeTransaction(p2({ id: zkId, permit2: PERMIT2_ADDRESS })), refused)
    assert.throws(() => protocol.buildRevokeTransaction(p2({ id: zkId.replace('324:', '1:'), chainId: 1 })), refused)
    assert.throws(() => protocol.buildRevokeTransaction(p2({ id: `324:permit2:x:y@${OTHER.toLowerCase()}` })), refused)
    // revokeAll folds by the same contract
    assert.throws(() => protocol.buildRevokeTransaction([p2({ id: zkId }), p2({})]), refused)
  })

  test('an id in the module\'s form without a suffix names the CREATE2 Permit2: a `permit2` naming the other one is refused', () => {
    const canonicalId = `324:permit2:${USDC.toLowerCase()}:${ROUTER.toLowerCase()}`
    assert.equal(protocol.buildRevokeTransaction(p2({ id: canonicalId, permit2: PERMIT2_ADDRESS })).to, PERMIT2_ADDRESS)
    assert.throws(() => protocol.buildRevokeTransaction(p2({ id: canonicalId, permit2: ZK })), refused)
    assert.throws(() => protocol.buildRevokeTransaction([p2({ id: zkId, permit2: ZK }), p2({ id: canonicalId, permit2: ZK })]), refused)
    // an id in another form names nothing: the approval's `permit2` decides
    assert.equal(protocol.buildRevokeTransaction(p2({ id: 'host-row-7', permit2: ZK })).to, ZK)
  })

  test('a Permit2 candidate with a malformed `permit2` is dropped alone; the rest of the scan is verified', async () => {
    const provider = chain(324, [], { [`${ZK}:${USDC}:${ROUTER}`]: 9n })
    const source = { name: 'stub', collect: async () => ({ complete: true, gaps: [], candidates: [
      { kind: 'permit2' as const, token: USDC, spender: ROUTER, permit2: 'not an address', block: 1, txHash: HASH, logIndex: 0 },
      { kind: 'permit2' as const, token: USDC, spender: OTHER, permit2: 42 as unknown as string, block: 1, txHash: HASH, logIndex: 1 },
      { kind: 'permit2' as const, token: USDC, spender: ROUTER, permit2: ZK, block: 2, txHash: HASH, logIndex: 2 },
    ] }) }
    const { approvals } = await new ApprovalsProtocolEvm(account(provider), { multicall: false, source }).getApprovals()
    assert.deepEqual(approvals.map((a) => [a.id, (a as EvmApproval).permit2]), [[zkId, ZK]])
    assert.deepEqual(provider.reads, [ZK])
  })

  test('a stray `permit2` on a candidate of another kind is ignored, not read and not fatal', async () => {
    const provider = chain(324, [], {})
    const source = { name: 'stub', collect: async () => ({ complete: true, gaps: [], candidates: [
      { kind: 'erc20' as const, token: USDC, spender: ROUTER, permit2: 'not an address', block: 1, txHash: HASH, logIndex: 0 },
    ] }) }
    const { approvals } = await new ApprovalsProtocolEvm(account(provider), { multicall: false, source }).getApprovals()
    assert.deepEqual(approvals, [])
    assert.deepEqual(provider.reads, [USDC]) // the token's allowance only
  })

  test('activity names zkSync Era\'s Permit2 as a spender on 324 only', () => {
    const word = (hex: string | bigint) => (typeof hex === 'bigint' ? hex.toString(16) : hex.replace(/^0x/, '').toLowerCase()).padStart(64, '0')
    const erc20 = '0x095ea7b3' + word(ZK) + word(5n)
    const tx = (chainId: number): ChainTx => ({
      chain: `eip155:${chainId}`, hash: HASH, time: 1, status: 'confirmed', address: OWNER, from: OWNER, to: USDC, nativeValue: 0n, transfers: [],
      call: { to: USDC, selector: '0x095ea7b3', data: erc20 },
    })
    const ctx = { own: new Set([OWNER]) }
    const tokens = { [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 } }
    assert.equal(describeApprovalActivity(tx(324), ctx, { tokens })?.title, 'Approved USDC for Permit2')
    assert.equal(describeApprovalActivity(tx(1), ctx, { tokens })?.title, 'Approved USDC for 0x0000…14fa')
  })
})
