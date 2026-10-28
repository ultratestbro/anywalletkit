// Scan 2026-10-27 (modules), F31: an `Approval`'s standard is whatever its source said, and `approve(spender, 0)` on an
// ERC-721 APPROVES `spender` for token #0. `revoke()` sent that call for any 'erc20' approval, and
// `isRevokeTransaction` let it through a policy for any target (or none). Now an 'erc20' revoke asks ERC-165 first,
// and isRevokeTransaction classifies approve / setApprovalForAll by the target's standard. EIP-1193 doubles only.
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, zeroAddress, type Hex } from 'viem'

import ApprovalsProtocolEvm, { ApprovalsError, STANDARDS, isRevokeTransaction, type Approval } from '../src/index.js'

const { ERC20_ABI, ERC721_ABI, PERMIT2_ABI, PERMIT2_ADDRESS, ERC721_INTERFACE_ID } = STANDARDS
const OWNER = getAddress('0x1111111111111111111111111111111111111111')
const ATTACKER = getAddress('0x9999999999999999999999999999999999999999')
const NFT = getAddress('0x3333333333333333333333333333333333333333')
const USDT = getAddress('0xdac17f958d2ee523a2206206994597c13d831ec7')
const DOWN = getAddress('0x00000000000000000000000000000000000000dd')
const HASH = '0x' + 'ab'.repeat(32)
const SUPPORTS = encodeFunctionData({ abi: ERC721_ABI, functionName: 'supportsInterface', args: [ERC721_INTERFACE_ID] }).slice(0, 10)

/** NFT answers ERC-165 like an ERC-721; USDT has no supportsInterface (reverts); DOWN's RPC does not answer. */
const provider = {
  calls: [] as string[],
  async request ({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    if (method === 'eth_chainId') return '0x1'
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
    const { to, data } = (params as Array<{ to: string; data: string }>)[0]!
    provider.calls.push(`${getAddress(to)}:${data.slice(0, 10)}`)
    if (getAddress(to) === DOWN) throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:8545')
    if (data.slice(0, 10) !== SUPPORTS) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' })
    if (getAddress(to) === NFT) return encodeAbiParameters([{ type: 'bool' }], [true])
    throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' })
  },
}

function account ({ approve = true } = {}) {
  const sent: unknown[] = []
  const approved: unknown[] = []
  const a: Record<string, unknown> = {
    sent, approved,
    async getAddress () { return OWNER },
    async sendTransaction (tx: unknown) { sent.push(tx); return { hash: HASH, fee: 1n } },
  }
  if (approve) a.approve = async (o: unknown) => { approved.push(o); return { hash: HASH, fee: 1n } }
  return a as typeof a & { sent: unknown[]; approved: unknown[] }
}
const erc20 = (token: string, spender = ATTACKER): Approval => ({ id: `${token}:${spender}`, standard: 'erc20', chainId: 1, token, spender, amount: 1n, unlimited: false, risks: [] })
const reason = (e: unknown) => (e instanceof ApprovalsError ? e.reason : `other:${String(e)}`)

describe("an 'erc20' revoke of an ERC-721 is refused (scan 2026-10-27 modules, F31)", () => {
  test('revoke: refused before anything is sent, through account.approve and through raw calldata', async () => {
    for (const withApprove of [true, false]) {
      const acc = account({ approve: withApprove })
      const p = new ApprovalsProtocolEvm(acc as never, { chainId: 1, provider })
      await assert.rejects(() => p.revoke(erc20(NFT)), (e: unknown) => reason(e) === 'invalid-approval' && /is an ERC-721: approve\(0x9999.*, 0\) there would approve the spender for token #0/.test((e as Error).message))
      assert.deepEqual([acc.sent, acc.approved], [[], []])
    }
  })

  test('a real ERC-20 (no ERC-165) is still revoked; a failed check sends nothing', async () => {
    const acc = account()
    const p = new ApprovalsProtocolEvm(acc as never, { chainId: 1, provider })
    assert.deepEqual(await p.revoke(erc20(USDT)), { hash: HASH, fee: 1n })
    assert.deepEqual(acc.approved, [{ token: USDT, spender: ATTACKER, amount: 0n }])
    await assert.rejects(() => p.revoke(erc20(DOWN)), (e: unknown) => reason(e) === 'source-failed')
    assert.equal(acc.approved.length, 1)
  })

  test('revokeAll in one batch: the ERC-721 entry fails on its own, the ERC-20 revoke and the NFT operator revoke go out', async () => {
    const acc = account({ approve: false })
    const p = new ApprovalsProtocolEvm(acc as never, { chainId: 1, provider, batch: true })
    const operator: Approval = { id: 'op', standard: 'erc721', chainId: 1, token: NFT, spender: ATTACKER, amount: null, unlimited: true, risks: [] }
    const results = await p.revokeAll([erc20(NFT), erc20(USDT), operator])
    const refused = results.find((r) => r.ids.includes(`${NFT}:${ATTACKER}`))!
    assert.equal(reason(refused.error), 'invalid-approval')
    assert.equal(acc.sent.length, 1)
    const batch = acc.sent[0] as Array<{ to: string; data: Hex }>
    assert.deepEqual(batch.map((t) => [getAddress(t.to), decodeFunctionData({ abi: ERC721_ABI, data: t.data }).functionName]), [[USDT, 'approve'], [NFT, 'setApprovalForAll']])
  })
})

describe('isRevokeTransaction reads approve by the target standard (scan 2026-10-27 modules, F31)', () => {
  const approveZero = (spender: string) => ({ to: NFT, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender as Hex, 0n] }) })
  const clear = (id: bigint, to = NFT) => ({ to, data: encodeFunctionData({ abi: ERC721_ABI, functionName: 'approve', args: [zeroAddress, id] }) })
  const forAllOff = (to = NFT) => ({ to, data: encodeFunctionData({ abi: ERC721_ABI, functionName: 'setApprovalForAll', args: [ATTACKER, false] }) })
  const nft = [{ token: NFT, standard: 'erc721-token' }]
  const asErc20 = [{ token: NFT, standard: 'erc20' }]

  test('approve(attacker, 0) to an NFT is not a revoke — with the Approval list, a map, a bare address or no targets', () => {
    assert.equal(isRevokeTransaction(approveZero(ATTACKER), { targets: nft }), false)
    assert.equal(isRevokeTransaction(approveZero(ATTACKER), { targets: new Map([[NFT.toLowerCase(), 'erc721']]) }), false)
    assert.equal(isRevokeTransaction(approveZero(ATTACKER), { targets: [NFT] }), false)
    assert.equal(isRevokeTransaction(approveZero(ATTACKER)), false)
    // A scan that reports the contract under both standards does not make the call safe.
    assert.equal(isRevokeTransaction(approveZero(ATTACKER), { targets: [...nft, ...asErc20] }), false)
    assert.equal(isRevokeTransaction(approveZero(ATTACKER), { targets: asErc20 }), true)
  })

  test('approve(0x0, id) and setApprovalForAll(x, false) are revokes on NFT targets; an ERC-20 target takes neither but approve(0x0, 0)', () => {
    assert.equal(isRevokeTransaction(clear(7n), { targets: nft }), true)
    assert.equal(isRevokeTransaction(clear(7n), { targets: [NFT] }), true)
    assert.equal(isRevokeTransaction(clear(7n), { targets: asErc20 }), false)
    assert.equal(isRevokeTransaction(clear(0n), { targets: asErc20 }), true)
    assert.equal(isRevokeTransaction(forAllOff(), { targets: [{ token: NFT, standard: 'erc1155' }] }), true)
    assert.equal(isRevokeTransaction(forAllOff(), { targets: [NFT] }), true)
    assert.equal(isRevokeTransaction(forAllOff(), { targets: asErc20 }), false)
    assert.equal(isRevokeTransaction(forAllOff(), { targets: [{ token: USDT, standard: 'erc721' }] }), false) // not this contract
    assert.equal(isRevokeTransaction(clear(7n)), false)
    assert.equal(isRevokeTransaction({ ...clear(7n), data: clear(7n).data + '00' }, { targets: nft }), false)
    const lockdown = encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'lockdown', args: [[{ token: USDT, spender: ATTACKER }]] })
    assert.equal(isRevokeTransaction({ to: PERMIT2_ADDRESS, data: lockdown }), true)
  })
})
