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
  type AccountLike, type Approval, type EvmApproval, type RevokeTransaction,
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

/** A chain with `chainId`, `logs`, and Permit2 allowances per `<permit2>:<token>:<spender>`; records every eth_call target. */
function chain (chainId: number, logs: ReturnType<typeof p2Approval>[], allowances: Record<string, bigint>) {
  const reads: string[] = []
  return {
    reads,
    async request ({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      const p = params as unknown[]
      if (method === 'eth_chainId') return numberToHex(chainId)
      if (method === 'eth_blockNumber') return '0x3e8'
      if (method === 'eth_getCode') return '0x6080'
      if (method === 'eth_getLogs') return logs
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
