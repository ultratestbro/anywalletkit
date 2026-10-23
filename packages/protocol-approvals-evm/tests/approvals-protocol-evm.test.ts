import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, getAbiItem, getAddress, numberToHex, pad,
  toFunctionSelector, zeroAddress, type Abi, type AbiFunction, type Address, type Hex, type PublicClient,
} from 'viem'

import ApprovalsProtocolEvm, {
  ApprovalsError, RpcLogsSource, StateVerifier, isRevokeCalldata, isRevokeTransaction, isUnlimitedAmount, parseApprovalLog, STANDARDS,
  type AccountLike, type Approval, type Eip1193Provider, type FetchLike, type ReadOnlyAccountLike, type RevokeTransaction, type SpenderLabel,
} from '../src/index.js'

const { TOPICS, PERMIT2_ADDRESS, MULTICALL3_ADDRESS, ERC20_ABI, ERC721_ABI, PERMIT2_ABI, MULTICALL3_ABI, MAX_UINT160, MAX_UINT256, SELECTORS } = STANDARDS
const selector = (abi: Abi, name: string): Hex => toFunctionSelector(getAbiItem({ abi, name }) as AbiFunction)
const abi = { uint256: { type: 'uint256' }, bool: { type: 'bool' }, address: { type: 'address' }, uint160: { type: 'uint160' }, uint48: { type: 'uint48' } } as const

const OWNER = getAddress('0x1111111111111111111111111111111111111111')
const STRANGER = getAddress('0x2222222222222222222222222222222222222222')
const USDT = getAddress('0xdac17f958d2ee523a2206206994597c13d831ec7')
const USDC = getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
const NFT = getAddress('0x3333333333333333333333333333333333333333')
const NFT2 = getAddress('0x4444444444444444444444444444444444444444')
const GAME = getAddress('0x5555555555555555555555555555555555555555')
const LIFI = getAddress('0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae')
const VELORA = getAddress('0x6a000f20005980200259b80c5102003040001068')
const EOA_SPENDER = getAddress('0x7777777777777777777777777777777777777777')
const OPERATOR = getAddress('0x8888888888888888888888888888888888888888')
const ROUTER = getAddress('0x9999999999999999999999999999999999999999')
const HASH = '0x' + 'ab'.repeat(32)
const NOW = Math.floor(Date.now() / 1000)
const addrTopic = (a: string): Hex => pad(a as Hex, { size: 32 })

interface StubLog { address: string; topics: string[]; data: string; blockNumber: string; blockHash: string; transactionHash: string; transactionIndex: string; logIndex: string; removed: boolean }

let logSeq = 0
function log (address: string, topics: string[], data = '0x', block = 100): StubLog {
  logSeq++
  return {
    address, topics, data, blockNumber: numberToHex(block), blockHash: '0x' + '11'.repeat(32),
    transactionHash: '0x' + block.toString(16).padStart(64, '0'), transactionIndex: '0x0', logIndex: numberToHex(logSeq), removed: false
  }
}
const erc20Approval = (token: string, spender: string, amount: bigint, block: number): StubLog => log(token, [TOPICS.approval, addrTopic(OWNER), addrTopic(spender)], encodeAbiParameters([abi.uint256], [amount]), block)
const erc721Approval = (token: string, spender: string, tokenId: bigint, block: number): StubLog => log(token, [TOPICS.approval, addrTopic(OWNER), addrTopic(spender), pad(numberToHex(tokenId), { size: 32 })], '0x', block)
const forAll = (token: string, op: string, approved: boolean, block: number): StubLog => log(token, [TOPICS.approvalForAll, addrTopic(OWNER), addrTopic(op)], encodeAbiParameters([abi.bool], [approved]), block)
const p2Approval = (token: string, spender: string, amount: bigint, exp: number, block: number): StubLog => log(PERMIT2_ADDRESS, [TOPICS.permit2Approval, addrTopic(OWNER), addrTopic(token), addrTopic(spender)], encodeAbiParameters([abi.uint160, abi.uint48], [amount, exp]), block)
const p2Permit = (token: string, spender: string, amount: bigint, exp: number, block: number): StubLog => log(PERMIT2_ADDRESS, [TOPICS.permit2Permit, addrTopic(OWNER), addrTopic(token), addrTopic(spender)], encodeAbiParameters([abi.uint160, abi.uint48, abi.uint48], [amount, exp, 0]), block)

interface Scenario {
  logs: StubLog[]
  allowance: Record<string, bigint>
  operator: Record<string, boolean>
  is1155: Record<string, boolean>
  approved: Record<string, string>
  ownerOf: Record<string, string>
  permit2: Record<string, [bigint, number, number]>
  code: Record<string, string>
  accountCode: string
  head?: number
}

/** The chain as the module sees it: a log history plus the state that history led to. */
function scenario (): Scenario {
  return {
    logs: [
      erc20Approval(USDT, LIFI, 500n, 100),
      erc20Approval(USDT, VELORA, 0n, 120),
      erc20Approval(USDC, EOA_SPENDER, MAX_UINT256, 130),
      forAll(NFT, OPERATOR, true, 140),
      forAll(NFT, OPERATOR, false, 150),
      forAll(NFT2, OPERATOR, true, 160),
      forAll(GAME, OPERATOR, true, 170),
      erc721Approval(NFT, LIFI, 7n, 180),
      p2Approval(USDC, ROUTER, MAX_UINT160, NOW + 86400, 190),
      p2Permit(USDT, ROUTER, 1000n, NOW - 10, 200),
      // owner appears as the spender here, not the granter — must be ignored
      log(USDT, [TOPICS.approval, addrTopic(STRANGER), addrTopic(OWNER)], encodeAbiParameters([abi.uint256], [5n]), 210)
    ],
    allowance: { [`${USDT}:${LIFI}`]: 500n, [`${USDT}:${VELORA}`]: 0n, [`${USDC}:${EOA_SPENDER}`]: MAX_UINT256 },
    operator: { [`${NFT}:${OPERATOR}`]: false, [`${NFT2}:${OPERATOR}`]: true, [`${GAME}:${OPERATOR}`]: true },
    is1155: { [GAME]: true },
    approved: { [`${NFT}:7`]: LIFI },
    ownerOf: { [`${NFT}:7`]: OWNER },
    permit2: { [`${USDC}:${ROUTER}`]: [MAX_UINT160, NOW + 86400, 1], [`${USDT}:${ROUTER}`]: [1000n, NOW - 10, 1] },
    code: { [EOA_SPENDER]: '0x' },
    accountCode: '0x'
  }
}

interface StubProvider extends Eip1193Provider { calls: { getLogs: Array<[number, number]>; eth_call: number; getCode: string[] } }

/**
 * An EIP-1193 double: eth_getLogs over the fixture (optionally refusing wide
 * ranges), eth_call routed per contract (with Multicall3 unrolled), eth_getCode.
 */
function stubProvider (s: Scenario, { maxRange = null, brokenBlock = null, multicall = true, failWith = null }: { maxRange?: number | null; brokenBlock?: number | null; multicall?: boolean; failWith?: string | null } = {}): StubProvider {
  const calls: StubProvider['calls'] = { getLogs: [], eth_call: 0, getCode: [] }
  const hasCode = (a: string): boolean => a.toLowerCase() !== OWNER.toLowerCase() && s.code[getAddress(a)] === undefined
  const route = (to: string, data: string): Hex => {
    const target = getAddress(to)
    const sel = data.slice(0, 10)
    const args = <const T extends readonly { type: string }[]>(types: T) => decodeAbiParameters(types, ('0x' + data.slice(10)) as Hex)
    if (sel === selector(ERC20_ABI, 'allowance')) {
      const [o, sp] = args([abi.address, abi.address])
      assert.equal(getAddress(o), OWNER)
      const v = s.allowance[`${target}:${getAddress(sp)}`]
      if (v === undefined) throw new Error('revert')
      return encodeAbiParameters([abi.uint256], [v])
    }
    if (sel === selector(ERC721_ABI, 'isApprovedForAll')) {
      const [, op] = args([abi.address, abi.address])
      return encodeAbiParameters([abi.bool], [s.operator[`${target}:${getAddress(op)}`] ?? false])
    }
    if (sel === selector(ERC721_ABI, 'supportsInterface')) return encodeAbiParameters([abi.bool], [s.is1155[target] === true])
    if (sel === selector(ERC721_ABI, 'getApproved')) return encodeAbiParameters([abi.address], [(s.approved[`${target}:${args([abi.uint256])[0]}`] ?? zeroAddress) as Address])
    if (sel === selector(ERC721_ABI, 'ownerOf')) return encodeAbiParameters([abi.address], [(s.ownerOf[`${target}:${args([abi.uint256])[0]}`] ?? STRANGER) as Address])
    if (target === PERMIT2_ADDRESS && sel === selector(PERMIT2_ABI, 'allowance')) {
      const [, token, sp] = args([abi.address, abi.address, abi.address])
      const [amount, exp, nonce] = s.permit2[`${getAddress(token)}:${getAddress(sp)}`] ?? [0n, 0, 0]
      return encodeAbiParameters([abi.uint160, abi.uint48, abi.uint48], [amount, exp, nonce])
    }
    throw new Error(`stub: unexpected call ${sel} to ${target}`)
  }
  const provider: StubProvider = {
    calls,
    async request ({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      const p = params as unknown[]
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_blockNumber') return numberToHex(s.head ?? 1000)
      if (method === 'eth_getCode') {
        const address = p[0] as string
        calls.getCode.push(address)
        if (address.toLowerCase() === OWNER.toLowerCase()) return s.accountCode
        return hasCode(address) ? '0x6080' : '0x'
      }
      if (method === 'eth_getLogs') {
        const f = p[0] as { fromBlock: string; toBlock: string; topics: [string[], string] }
        const from = Number(f.fromBlock); const to = Number(f.toBlock)
        calls.getLogs.push([from, to])
        if (failWith) throw new Error(failWith)
        if (brokenBlock !== null && from <= brokenBlock && brokenBlock <= to) throw new Error('query returned more than 10000 results')
        if (maxRange !== null && to - from + 1 > maxRange) throw new Error(`eth_getLogs is limited to a ${maxRange} block range`)
        assert.deepEqual(f.topics[1], addrTopic(OWNER))
        const topic0 = new Set(f.topics[0])
        return s.logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to && topic0.has(l.topics[0]!))
      }
      if (method === 'eth_call') {
        calls.eth_call++
        const { to, data } = p[0] as { to: string; data: string }
        if (getAddress(to) === MULTICALL3_ADDRESS) {
          if (!multicall) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x' })
          const { args: [list] } = decodeFunctionData({ abi: MULTICALL3_ABI, data: data as Hex })
          const out = list.map((c) => { try { return { success: true, returnData: route(c.target, c.callData) } } catch { return { success: false, returnData: '0x' as Hex } } })
          return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: out })
        }
        try { return route(to, data) } catch (e) { throw Object.assign(e as Error, { code: 'CALL_EXCEPTION', data: '0x' }) }
      }
      throw new Error(`stub provider: unexpected ${method}`)
    }
  }
  return provider
}

type Sent = RevokeTransaction | RevokeTransaction[]
interface StubAccount extends ReadOnlyAccountLike, Partial<Omit<AccountLike, keyof ReadOnlyAccountLike>> {
  sent: Sent[]
  approved: Array<{ token: string; spender: string; amount: bigint }>
}

function stubAccount (provider: Eip1193Provider, { readOnly = false, approve = true, batch = false, delegation = false }: { readOnly?: boolean; approve?: boolean; batch?: boolean; delegation?: boolean } = {}): StubAccount {
  void batch
  const sent: Sent[] = []; const approved: StubAccount['approved'] = []
  const account: StubAccount = { sent, approved, _config: { provider }, async getAddress () { return OWNER } }
  if (!readOnly) {
    account.sendTransaction = async (tx) => { sent.push(tx); return { hash: HASH, fee: 21_000n } }
    account.quoteSendTransaction = async (_tx) => ({ fee: 1_000n })
    if (approve) account.approve = async (o) => { approved.push(o); return { hash: HASH, fee: 30_000n } }
    if (delegation) account.revokeDelegation = async () => ({ hash: HASH, fee: 40_000n })
  }
  return account
}

const byStandard = (list: Approval[], standard: string): Approval[] => list.filter((a) => a.standard === standard)
const reason = (e: unknown): string | undefined => (e as { reason?: string }).reason
const internals = (p: ApprovalsProtocolEvm): { _provider: PublicClient; _requireProvider(): unknown } => p as unknown as { _provider: PublicClient; _requireProvider(): unknown }
const lastSent = (account: StubAccount): RevokeTransaction => account.sent.at(-1) as RevokeTransaction
const approval = (a: Partial<Approval>): Approval => a as Approval

test('parseApprovalLog: ERC-20 vs ERC-721 Approval by topic count, operator, Permit2, foreign owner ignored', () => {
  assert.deepEqual(parseApprovalLog(erc20Approval(USDT, LIFI, 1n, 5), OWNER), { kind: 'erc20', token: USDT, spender: LIFI, block: 5, txHash: '0x' + '5'.padStart(64, '0'), logIndex: logSeq })
  const nft = parseApprovalLog(erc721Approval(NFT, LIFI, 7n, 6), OWNER)!
  assert.equal(nft.kind, 'erc721-token'); assert.equal(nft.tokenId, '7')
  assert.equal(parseApprovalLog(forAll(NFT, OPERATOR, true, 7), OWNER)!.kind, 'nft-operator')
  const p2 = parseApprovalLog(p2Permit(USDT, ROUTER, 1n, 1, 8), OWNER)!
  assert.deepEqual([p2.kind, p2.token, p2.spender], ['permit2', USDT, ROUTER])
  // Permit2-shaped event from a look-alike contract is not Permit2
  assert.equal(parseApprovalLog({ ...p2Permit(USDT, ROUTER, 1n, 1, 8), address: USDT }, OWNER), null)
  const lockdown = log(PERMIT2_ADDRESS, [TOPICS.permit2Lockdown, addrTopic(OWNER)], encodeAbiParameters([abi.address, abi.address], [USDC, ROUTER]), 9)
  assert.deepEqual([parseApprovalLog(lockdown, OWNER)!.kind, parseApprovalLog(lockdown, OWNER)!.token], ['permit2', USDC])
  assert.equal(parseApprovalLog(erc20Approval(USDT, LIFI, 1n, 5), STRANGER), null)
})

test('getApprovals: live state wins over history; flags unlimited / eoa-spender; expired Permit2 and zero allowances dropped', async () => {
  const s = scenario()
  const provider = stubProvider(s)
  const protocol = new ApprovalsProtocolEvm(stubAccount(provider, { readOnly: true }), { chainId: 1 })
  const { approvals, coverage } = await protocol.getApprovals()

  assert.deepEqual(coverage, { source: 'rpc-logs', fromBlock: 0, toBlock: 1000, complete: true, gaps: [] })
  assert.deepEqual(provider.calls.getLogs, [[0, 1000]])

  const erc20 = byStandard(approvals, 'erc20')
  assert.deepEqual(erc20.map((a) => [a.token, a.spender, a.amount, a.unlimited, a.risks]).sort(), [
    [USDC, EOA_SPENDER, MAX_UINT256, true, ['unlimited', 'eoa-spender']],
    [USDT, LIFI, 500n, false, []]
  ].sort())
  assert.equal(erc20.find((a) => a.spender === LIFI)!.grantedAt!.block, 100)
  assert.equal(erc20.find((a) => a.spender === LIFI)!.id, `1:erc20:${USDT.toLowerCase()}:${LIFI.toLowerCase()}`)

  // NFT: operator revoked on NFT, live on NFT2 (721) and GAME (1155); token #7 approved to LIFI
  assert.deepEqual(byStandard(approvals, 'erc721').map((a) => [a.token, a.spender, a.amount]), [[NFT2, OPERATOR, null]])
  assert.deepEqual(byStandard(approvals, 'erc1155').map((a) => a.token), [GAME])
  assert.deepEqual(byStandard(approvals, 'erc721-token').map((a) => [a.token, a.spender, a.tokenId]), [[NFT, LIFI, '7']])

  // Permit2: unlimited live one kept, expired one dropped
  const p2 = byStandard(approvals, 'permit2')
  assert.deepEqual(p2.map((a) => [a.token, a.spender, a.unlimited, a.expiration]), [[USDC, ROUTER, true, NOW + 86400]])
  assert.deepEqual(byStandard(approvals, 'eip7702'), [])

  // one multicall for all reads, one getCode per unique spender + the owner (7702 check)
  assert.equal(provider.calls.eth_call, 1)
  assert.equal(new Set(provider.calls.getCode.map((a) => a.toLowerCase())).size, 5)
})

test('getApprovals: includeZero keeps zero / expired / revoked-operator entries, marks expired', async () => {
  const protocol = new ApprovalsProtocolEvm(stubAccount(stubProvider(scenario()), { readOnly: true }), { chainId: 1 })
  const { approvals } = await protocol.getApprovals({ includeZero: true })
  assert.ok(approvals.find((a) => a.standard === 'erc20' && a.spender === VELORA && a.amount === 0n))
  assert.ok(approvals.find((a) => a.standard === 'erc721' && a.token === NFT && a.unlimited === false))
  assert.deepEqual(approvals.find((a) => a.standard === 'permit2' && a.token === USDT)!.risks, ['expired'])
})

test('getApprovals: filters by standards / tokens / spenders', async () => {
  const protocol = new ApprovalsProtocolEvm(stubAccount(stubProvider(scenario()), { readOnly: true }), { chainId: 1 })
  assert.deepEqual((await protocol.getApprovals({ standards: ['erc20'] })).approvals.map((a) => a.standard), ['erc20', 'erc20'])
  assert.deepEqual((await protocol.getApprovals({ tokens: [USDC.toLowerCase()] })).approvals.map((a) => a.standard).sort(), ['erc20', 'permit2'])
  assert.deepEqual((await protocol.getApprovals({ spenders: [OPERATOR] })).approvals.map((a) => a.token).sort(), [GAME, NFT2].sort())
})

test('getApprovals: EIP-7702 delegation is reported from the account code', async () => {
  const s = scenario()
  s.accountCode = '0xef0100' + LIFI.slice(2).toLowerCase()
  const protocol = new ApprovalsProtocolEvm(stubAccount(stubProvider(s), { readOnly: true }), { chainId: 1 })
  const d = byStandard((await protocol.getApprovals()).approvals, 'eip7702')
  assert.deepEqual(d.map((a) => [a.token, a.spender, a.amount, a.risks]), [[OWNER, LIFI, null, ['unlimited']]])
  const off = new ApprovalsProtocolEvm(stubAccount(stubProvider(s), { readOnly: true }), { chainId: 1, includeDelegation: false })
  assert.deepEqual(byStandard((await off.getApprovals()).approvals, 'eip7702'), [])
})

test('RpcLogsSource: a refused range is halved until it fits; nothing is lost', async () => {
  const s = scenario()
  const provider = stubProvider(s, { maxRange: 64 })
  const protocol = new ApprovalsProtocolEvm(stubAccount(provider, { readOnly: true }), { chainId: 1, concurrency: 2 })
  const { approvals, coverage } = await protocol.getApprovals({ fromBlock: 0, toBlock: 255 })
  assert.equal(coverage.complete, true)
  assert.equal(approvals.length, 6)
  assert.ok(provider.calls.getLogs.length > 4)
  assert.ok(provider.calls.getLogs.every(([a, b]) => b >= a))
})

test('RpcLogsSource: blockRange pre-chunks; a single block that stays refused becomes a gap (complete: false, cache untouched)', async () => {
  const s = scenario()
  const provider = stubProvider(s, { brokenBlock: 150 })
  const cache = { get: async () => null, set: async () => { throw new Error('must not cache a partial scan') } }
  const protocol = new ApprovalsProtocolEvm(stubAccount(provider, { readOnly: true }), { chainId: 1, blockRange: 100, cache })
  const { approvals, coverage } = await protocol.getApprovals({ fromBlock: 0, toBlock: 299 })
  assert.equal(coverage.complete, false)
  assert.deepEqual(coverage.gaps, [[150, 150]])
  assert.equal(provider.calls.getLogs[0]![1] - provider.calls.getLogs[0]![0], 99)
  // the ApprovalForAll(false) at block 150 was skipped, but state says the operator is off anyway
  assert.equal(approvals.filter((a) => a.token === NFT && a.standard === 'erc721').length, 0)
})

test('RpcLogsSource: a non-range error is retried then surfaces as source-failed', async () => {
  const provider = stubProvider(scenario(), { failWith: 'connection reset' })
  const protocol = new ApprovalsProtocolEvm(stubAccount(provider, { readOnly: true }), { chainId: 1, retryDelay: 0 })
  await assert.rejects(() => protocol.getApprovals(), (e: unknown) => e instanceof ApprovalsError && e.reason === 'source-failed')
  assert.equal(provider.calls.getLogs.length, 3)
})

test('cache: a stored scan makes the next one incremental and merges candidates', async () => {
  const s = scenario()
  const provider = stubProvider(s)
  const store = new Map<string, { fromBlock: number; toBlock: number; candidates: unknown[] }>()
  const cache = { get: (k: string) => store.get(k) as never, set: (k: string, v: { fromBlock: number; toBlock: number; candidates: unknown[] }) => { store.set(k, v) } }
  const protocol = new ApprovalsProtocolEvm(stubAccount(provider, { readOnly: true }), { chainId: 1, fromBlock: 50, cache })
  const first = await protocol.getApprovals()
  assert.deepEqual(provider.calls.getLogs, [[50, 1000]])
  const entry = store.get(`1:${OWNER.toLowerCase()}`)!
  assert.equal(entry.toBlock, 1000)
  assert.equal(entry.fromBlock, 50)
  assert.equal(JSON.parse(JSON.stringify(entry)).candidates.length, entry.candidates.length, 'cache entry must be plain JSON')

  // second run: only new blocks are scanned; the stored candidates still get verified
  s.allowance[`${USDT}:${LIFI}`] = 0n // revoked elsewhere meanwhile
  s.head = 1200
  const second = await protocol.getApprovals()
  assert.deepEqual(provider.calls.getLogs.at(-1), [1001, 1200])
  assert.equal(second.coverage.fromBlock, 50)
  assert.deepEqual([store.get(`1:${OWNER.toLowerCase()}`)!.fromBlock, store.get(`1:${OWNER.toLowerCase()}`)!.toBlock], [50, 1200])
  assert.equal(first.approvals.length - second.approvals.length, 1)
})

test('StateVerifier: falls back to single eth_calls where Multicall3 is missing', async () => {
  const provider = stubProvider(scenario(), { multicall: false })
  const protocol = new ApprovalsProtocolEvm(stubAccount(provider, { readOnly: true }), { chainId: 1 })
  const { approvals } = await protocol.getApprovals()
  assert.equal(approvals.length, 6)
  assert.ok(provider.calls.eth_call > 6)
  const verifier = new StateVerifier({ provider: internals(protocol)._provider, multicall: false })
  assert.equal((await verifier.verify(OWNER, [{ kind: 'erc20', token: USDT, spender: LIFI, block: 1, txHash: HASH, logIndex: 0 }], { chainId: 1 })).length, 1)
})

test('revoke: routes by standard — approve(0) for ERC-20, setApprovalForAll(false), approve(0x0, id), lockdown, revokeDelegation', async () => {
  const provider = stubProvider(scenario())
  const account = stubAccount(provider, { delegation: true })
  const protocol = new ApprovalsProtocolEvm(account, { chainId: 1 })
  const { approvals } = await protocol.getApprovals()
  const pick = (standard: string): Approval => approvals.find((a) => a.standard === standard)!

  assert.deepEqual(await protocol.revoke(pick('erc20')), { hash: HASH, fee: 30_000n })
  assert.deepEqual(account.approved, [{ token: pick('erc20').token, spender: pick('erc20').spender, amount: 0n }])

  await protocol.revoke(pick('erc721'))
  assert.equal(lastSent(account).to, NFT2)
  assert.deepEqual([...decodeFunctionData({ abi: ERC721_ABI, data: lastSent(account).data as Hex }).args], [OPERATOR, false])

  await protocol.revoke(pick('erc721-token'))
  assert.deepEqual([...decodeFunctionData({ abi: ERC721_ABI, data: lastSent(account).data as Hex }).args], [zeroAddress, 7n])

  await protocol.revoke(pick('permit2'))
  assert.equal(lastSent(account).to, PERMIT2_ADDRESS)
  const { args: [pairs] } = decodeFunctionData({ abi: PERMIT2_ABI, data: lastSent(account).data as Hex })
  assert.deepEqual((pairs as ReadonlyArray<{ token: string; spender: string }>).map((p) => [p.token, p.spender]), [[USDC, ROUTER]])

  assert.deepEqual(await protocol.revoke({ id: 'x', standard: 'eip7702', chainId: 1, token: OWNER, spender: LIFI, amount: null, unlimited: true, risks: [] }), { hash: HASH, fee: 40_000n })

  // without account.approve the ERC-20 revoke is plain calldata
  const bare = stubAccount(provider, { approve: false })
  await new ApprovalsProtocolEvm(bare, { chainId: 1 }).revoke(pick('erc20'))
  assert.equal(lastSent(bare).data.slice(0, 10), SELECTORS.approve)
  assert.equal(decodeFunctionData({ abi: ERC20_ABI, data: lastSent(bare).data as Hex }).args[1], 0n)
})

test('revoke / quoteRevoke guards: read-only account, bad input, unsupported standard', async () => {
  const provider = stubProvider(scenario())
  const ro = new ApprovalsProtocolEvm(stubAccount(provider, { readOnly: true }), { chainId: 1 })
  const erc20: Approval = { id: 'x', standard: 'erc20', chainId: 1, token: USDT, spender: LIFI, amount: 1n, unlimited: false, risks: [] }
  await assert.rejects(() => ro.revoke(erc20), (e: unknown) => reason(e) === 'account-required')
  const rw = new ApprovalsProtocolEvm(stubAccount(provider), { chainId: 1 })
  await assert.rejects(() => rw.revoke({ ...erc20, standard: 'trc20' }), (e: unknown) => reason(e) === 'unsupported-standard')
  await assert.rejects(() => rw.revoke({ ...erc20, token: 'nope' }), (e: unknown) => reason(e) === 'invalid-approval')
  await assert.rejects(() => rw.revoke(null as unknown as Approval), (e: unknown) => reason(e) === 'invalid-approval')
  assert.deepEqual(await rw.quoteRevoke(erc20), { fee: 1_000n })
  assert.deepEqual(await rw.quoteRevoke({ ...erc20, standard: 'eip7702' }), { fee: 0n })
  assert.throws(() => internals(new ApprovalsProtocolEvm({ async getAddress () { return OWNER } }, {}))._requireProvider(), (e: unknown) => reason(e) === 'provider-required')
})

test('revokeAll: Permit2 pairs fold into one lockdown, others go one by one, failures do not stop the run', async () => {
  const provider = stubProvider(scenario())
  const account = stubAccount(provider)
  const protocol = new ApprovalsProtocolEvm(account, { chainId: 1 })
  const p2 = (token: string, spender: string): Approval => ({ id: `p2:${token}:${spender}`, standard: 'permit2', chainId: 1, token, spender, amount: 1n, unlimited: false, risks: [] })
  const list: Approval[] = [
    p2(USDC, ROUTER), { id: 'e20', standard: 'erc20', chainId: 1, token: USDT, spender: LIFI, amount: 1n, unlimited: false, risks: [] },
    p2(USDT, ROUTER), p2(USDC, LIFI),
    { id: 'op', standard: 'erc721', chainId: 1, token: NFT2, spender: OPERATOR, amount: null, unlimited: true, risks: [] }
  ]
  let n = 0
  account.sendTransaction = async (tx) => { account.sent.push(tx); if (++n === 2) throw new Error('user rejected'); return { hash: HASH, fee: 1n } }
  const results = await protocol.revokeAll(list)
  assert.equal(results.length, 3)
  assert.deepEqual(results[0]!.ids, [list[0]!.id, list[2]!.id, list[3]!.id])
  assert.equal(results[0]!.hash, HASH)
  const { args: [pairs] } = decodeFunctionData({ abi: PERMIT2_ABI, data: (account.sent[0] as RevokeTransaction).data as Hex })
  assert.equal((pairs as readonly unknown[]).length, 3)
  assert.deepEqual(results[1], { ids: ['e20'], hash: HASH, fee: 30_000n })
  assert.deepEqual(results[2]!.ids, ['op'])
  assert.match(results[2]!.error!.message, /user rejected/)
  assert.deepEqual(await protocol.revokeAll([]), [])
})

test('revokeAll with batch: everything with calldata becomes one sendTransaction(tx[]); the delegation stays separate', async () => {
  const provider = stubProvider(scenario())
  const account = stubAccount(provider, { delegation: true })
  const protocol = new ApprovalsProtocolEvm(account, { chainId: 1, batch: true })
  const list: Approval[] = [
    { id: 'e20', standard: 'erc20', chainId: 1, token: USDT, spender: LIFI, amount: 1n, unlimited: false, risks: [] },
    { id: 'p2', standard: 'permit2', chainId: 1, token: USDC, spender: ROUTER, amount: 1n, unlimited: false, risks: [] },
    { id: 'd', standard: 'eip7702', chainId: 1, token: OWNER, spender: LIFI, amount: null, unlimited: true, risks: [] }
  ]
  const results = await protocol.revokeAll(list)
  assert.equal(account.sent.length, 1)
  assert.ok(Array.isArray(account.sent[0]) && account.sent[0].length === 2)
  assert.equal((account.sent[0] as RevokeTransaction[])[1]!.data.slice(0, 10), SELECTORS.approve)
  assert.deepEqual(results.map((r) => r.ids), [['p2', 'e20'], ['d']])
  assert.equal(account.approved.length, 0)
})

test('isRevokeCalldata recognises the revoke calldata buildRevokeTransaction emits, isUnlimitedAmount the 2^255 threshold', () => {
  const protocol = new ApprovalsProtocolEvm({ async getAddress () { return OWNER } }, { provider: 'http://localhost', chainId: 1 })
  const setOff = protocol.buildRevokeTransaction(approval({ standard: 'erc721', token: NFT, spender: OPERATOR }))
  const lock = protocol.buildRevokeTransaction(approval({ standard: 'permit2', token: USDC, spender: ROUTER }))
  const zero = protocol.buildRevokeTransaction(approval({ standard: 'erc20', token: USDT, spender: LIFI }))
  assert.equal(isRevokeCalldata(setOff.data), true)
  assert.equal(isRevokeCalldata(lock.data), true)
  assert.equal(isRevokeCalldata(zero.data), true)
  assert.equal(isRevokeCalldata(encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [LIFI, 1n] })), false)
  assert.equal(isRevokeCalldata(encodeFunctionData({ abi: ERC721_ABI, functionName: 'setApprovalForAll', args: [OPERATOR, true] })), false)
  assert.equal(isRevokeCalldata(undefined), false)
  // Strict: trailing bytes, a dirty bool word and non-hex are refused (audit F8).
  assert.equal(isRevokeCalldata(zero.data + '00'.repeat(32)), false)
  assert.equal(isRevokeCalldata(setOff.data.slice(0, -2) + '02'), false)
  assert.equal(isRevokeCalldata(zero.data.slice(0, -1) + 'z'), false)
  assert.equal(isRevokeCalldata(lock.data + 'ab'.repeat(32)), false)
  // The whole transaction: no value, no 7702 authorization, lockdown only to Permit2, optional token targets.
  assert.equal(isRevokeTransaction({ to: USDT, data: zero.data }), true)
  assert.equal(isRevokeTransaction({ to: USDT, data: zero.data, value: 1n }), false)
  assert.equal(isRevokeTransaction({ to: USDT, data: zero.data, authorizationList: [{}] }), false)
  assert.equal(isRevokeTransaction({ to: USDT, data: zero.data, type: 'eip7702' }), false)
  assert.equal(isRevokeTransaction({ to: PERMIT2_ADDRESS, data: lock.data }), true)
  assert.equal(isRevokeTransaction({ to: USDT, data: lock.data }), false)
  assert.equal(isRevokeTransaction({ to: USDT, data: zero.data }, { targets: [USDC] }), false)
  assert.equal(isRevokeTransaction({ to: USDT, data: zero.data }, { targets: [USDT.toLowerCase()] }), true)
  assert.equal(isUnlimitedAmount(MAX_UINT256), true)
  assert.equal(isUnlimitedAmount(1n << 255n), true)
  assert.equal(isUnlimitedAmount((1n << 255n) - 1n), false)
})

test('getSupportedStandards lists the evm set', async () => {
  const protocol = new ApprovalsProtocolEvm({ async getAddress () { return OWNER } }, { provider: 'http://localhost' })
  assert.deepEqual(await protocol.getSupportedStandards(), ['erc20', 'erc721', 'erc721-token', 'erc1155', 'permit2', 'eip7702'])
  assert.ok(new RpcLogsSource({ provider: {} as PublicClient }).name === 'rpc-logs')
})

test('BlockscoutSource: one topic1-only request per range, transfers dropped, null-padded topics dropped, full page splits the range', async () => {
  const { BlockscoutSource, BLOCKSCOUT_HOSTS } = await import('../src/index.js')
  const s = scenario()
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const rowsOf = (logs: StubLog[]) => logs.map((l) => ({ address: l.address, topics: [...l.topics, ...Array<null>(4 - l.topics.length).fill(null)], data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex }))
  const urls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url)
    const u = new URL(url)
    const from = Number(u.searchParams.get('fromBlock')); const to = Number(u.searchParams.get('toBlock'))
    assert.equal(u.searchParams.get('topic1'), addrTopic(OWNER))
    assert.equal(u.searchParams.get('topic0'), null)
    if (from === 0 && to === 1000) return { ok: true, status: 200, json: async () => ({ status: '1', message: 'OK', result: Array.from({ length: 1000 }, () => rowsOf([s.logs[0]!])[0]) }) }
    const rows: unknown[] = rowsOf(s.logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to))
    // the owner's outgoing transfers share topic1 and must be ignored
    rows.push({ address: USDT, topics: [transferTopic, addrTopic(OWNER), addrTopic(STRANGER), null], data: encodeAbiParameters([abi.uint256], [1n]), blockNumber: numberToHex(from), transactionHash: HASH, logIndex: '0x0' })
    return { ok: true, status: 200, json: async () => ({ status: '1', message: 'OK', result: rows }) }
  }
  const source = new BlockscoutSource({ chainId: 1, fetch: fetchImpl, retryDelay: 0 })
  assert.equal(source.name, 'blockscout')
  const out = await source.collect(OWNER, { fromBlock: 0, toBlock: 1000 })
  assert.equal(out.complete, true)
  assert.deepEqual(out.candidates.map((c) => c.kind).sort(), ['erc20', 'erc20', 'erc20', 'erc721-token', 'nft-operator', 'nft-operator', 'nft-operator', 'permit2', 'permit2'].sort())
  assert.equal(urls.length, 3) // full page → two halves
  assert.ok(urls.every((u) => u.startsWith(BLOCKSCOUT_HOSTS[1]!)))
  assert.equal(source.requests, 3)

  // per-topic mode: five requests, apikey forwarded
  const perTopicUrls: string[] = []
  const pt = new BlockscoutSource({ chainId: 1, apiKey: 'k', perTopic: true, retryDelay: 0, fetch: async (u) => { perTopicUrls.push(u); return { ok: true, status: 200, json: async () => ({ status: '0', message: 'No records found', result: [] }) } } })
  await pt.collect(OWNER, { fromBlock: 0, toBlock: 10 })
  assert.equal(perTopicUrls.length, 5)
  assert.ok(perTopicUrls.every((u) => u.includes('apikey=k') && u.includes('topic0_1_opr=and')))

  // as the protocol's source: the same verified result as rpc-logs
  const provider = stubProvider(s)
  const protocol = new ApprovalsProtocolEvm(stubAccount(provider, { readOnly: true }), { chainId: 1, source })
  const { approvals, coverage } = await protocol.getApprovals()
  assert.equal(coverage.source, 'blockscout')
  assert.equal(approvals.length, 6)
  assert.deepEqual(provider.calls.getLogs, [])

  // transient failure is retried, a 4xx is not
  let n = 0
  const flaky = new BlockscoutSource({ baseUrl: 'https://x.test/', fetch: async () => (++n < 3 ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ status: '0', message: 'No records found', result: [] }) }), retryDelay: 0, concurrency: 1 })
  assert.equal((await flaky.collect(OWNER, { fromBlock: 0, toBlock: 1 })).candidates.length, 0)
  // 429 with Retry-After: waits at least that long before the retry, then succeeds
  let hits = 0; const stamps: number[] = []
  const limited = new BlockscoutSource({ baseUrl: 'https://x.test', retryDelay: 1, concurrency: 1, fetch: async () => { stamps.push(Date.now()); return ++hits === 1 ? { ok: false, status: 429, headers: { get: (h: string) => (h === 'retry-after' ? '1' : null) }, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ status: '0', message: 'No records found', result: [] }) } } })
  await limited.collect(OWNER, { fromBlock: 0, toBlock: 1 })
  assert.equal(hits, 2) // one range + one retry
  assert.ok(stamps[1]! - stamps[0]! >= 950, `retry waited ${stamps[1]! - stamps[0]!}ms`)
  // a 429 whose reset is far away fails at once with the wait in the message
  const exhausted = new BlockscoutSource({ baseUrl: 'https://x.test', retryDelay: 0, fetch: async () => ({ ok: false, status: 429, headers: { get: (h: string) => ({ 'x-ratelimit-reset': '1438705', 'x-ratelimit-limit': '10' } as Record<string, string>)[h] ?? null }, json: async () => ({}) }) })
  await assert.rejects(() => exhausted.collect(OWNER, { fromBlock: 0, toBlock: 1 }), (e: unknown) => reason(e) === 'source-failed' && /10 requests per window.*24 min/.test((e as Error).message))
  const denied = new BlockscoutSource({ baseUrl: 'https://x.test', fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }), retryDelay: 0 })
  await assert.rejects(() => denied.collect(OWNER, { fromBlock: 0, toBlock: 1 }), (e: unknown) => reason(e) === 'source-failed')
  assert.throws(() => new BlockscoutSource({ chainId: 424242 }), (e: unknown) => reason(e) === 'source-failed')
})

test('EtherscanSource: V2 query shape, proxy baseUrl + headers, Etherscan-style "rate limit" body retried, unsupported chain fatal', async () => {
  const { EtherscanSource, ETHERSCAN_V2_URL } = await import('../src/index.js')
  const s = scenario()
  const seen: Array<{ url: string; init: { headers: Record<string, string> } }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, init })
    const u = new URL(url)
    assert.equal(u.searchParams.get('chainid'), '1')
    assert.equal(u.searchParams.get('offset'), '1000')
    assert.equal(u.searchParams.get('topic1'), addrTopic(OWNER))
    if (seen.length === 1) return { ok: true, status: 200, json: async () => ({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' }) }
    const rows = s.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex }))
    return { ok: true, status: 200, json: async () => ({ status: '1', message: 'OK', result: rows }) }
  }
  const direct = new EtherscanSource({ chainId: 1, apiKey: 'k', fetch: fetchImpl, retryDelay: 1 })
  const out = await direct.collect(OWNER, { fromBlock: 0, toBlock: 1000 })
  assert.equal(out.candidates.length, 9)
  assert.equal(seen.length, 2)
  assert.ok(seen[0]!.url.startsWith(ETHERSCAN_V2_URL) && seen[0]!.url.includes('apikey=k'))

  seen.length = 0
  const proxied = new EtherscanSource({ chainId: 1, baseUrl: 'https://wallet.example/api/etherscan', headers: { authorization: 'Bearer t' }, fetch: fetchImpl, retryDelay: 1 })
  await proxied.collect(OWNER, { fromBlock: 0, toBlock: 1000 })
  assert.ok(seen[0]!.url.startsWith('https://wallet.example/api/etherscan?chainid=1&') && !seen[0]!.url.includes('apikey'))
  assert.equal(seen[0]!.init.headers.authorization, 'Bearer t')

  const paid = new EtherscanSource({ chainId: 56, fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.' }) }), retryDelay: 0 })
  await assert.rejects(() => paid.collect(OWNER, { fromBlock: 0, toBlock: 1 }), (e: unknown) => reason(e) === 'source-failed' && /Free API access/.test((e as Error).message))
  assert.throws(() => new EtherscanSource({}), (e: unknown) => reason(e) === 'source-failed')
})

test('EtherscanLabels: verified names attached as spenderLabel, one lookup per spender, cache honoured, failures ignored', async () => {
  const { EtherscanLabels } = await import('../src/index.js')
  const names: Record<string, string> = { [LIFI.toLowerCase()]: 'LiFiDiamond', [ROUTER.toLowerCase()]: 'THORChain_Router' }
  const asked: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    const u = new URL(url)
    assert.equal(u.searchParams.get('action'), 'getsourcecode')
    const a = u.searchParams.get('address')!; asked.push(a)
    if (a === OPERATOR.toLowerCase()) throw new Error('network down')
    if (a === VELORA.toLowerCase()) return { ok: true, status: 200, json: async () => ({ status: '1', message: 'OK', result: [{ ContractName: 'TransparentUpgradeableProxy', Proxy: '1', Implementation: GAME }] }) }
    if (a === GAME.toLowerCase()) return { ok: true, status: 200, json: async () => ({ status: '1', message: 'OK', result: [{ ContractName: 'OAdapterUpgradeable', Proxy: '0', Implementation: '' }] }) }
    return { ok: true, status: 200, json: async () => ({ status: '1', message: 'OK', result: [{ ContractName: names[a] ?? '', SourceCode: '' }] }) }
  }
  const store = new Map<string, SpenderLabel>()
  const labels = new EtherscanLabels({ chainId: 1, baseUrl: 'https://wallet.example/api/etherscan', headers: { authorization: 'Bearer t' }, explorerUrl: 'https://etherscan.io/', fetch: fetchImpl, cache: { get: (k) => store.get(k), set: (k, v) => { store.set(k, v as SpenderLabel) } } })
  const out = await labels.resolve([LIFI, LIFI.toLowerCase(), ROUTER, EOA_SPENDER, OPERATOR])
  assert.deepEqual(out, {
    [LIFI.toLowerCase()]: { name: 'LiFiDiamond', url: `https://etherscan.io/address/${LIFI}` },
    [ROUTER.toLowerCase()]: { name: 'THORChain_Router', url: `https://etherscan.io/address/${ROUTER}` }
  })
  assert.equal(asked.length, 4) // LIFI once despite two spellings
  await labels.resolve([LIFI, ROUTER, EOA_SPENDER])
  assert.equal(asked.length, 4) // memoised, including the empty answer
  // a proxy is labelled by its implementation's name (one extra lookup)
  assert.equal((await labels.resolve([VELORA]))[VELORA.toLowerCase()]!.name, 'OAdapterUpgradeable')
  assert.equal(asked.length, 6)
  assert.equal(store.get(`label:1:${EOA_SPENDER.toLowerCase()}`)!.name, '')

  // a fresh instance reads the persisted cache before asking
  const fresh = new EtherscanLabels({ chainId: 1, fetch: async () => { throw new Error('must not be called') }, cache: { get: (k) => store.get(k), set: () => {} } })
  assert.equal((await fresh.resolve([LIFI]))[LIFI.toLowerCase()]!.name, 'LiFiDiamond')

  // wired into the protocol
  const protocol = new ApprovalsProtocolEvm(stubAccount(stubProvider(scenario()), { readOnly: true }), { chainId: 1, labels })
  const { approvals } = await protocol.getApprovals()
  assert.equal(approvals.find((a) => a.standard === 'erc20' && a.spender === LIFI)!.spenderLabel!.name, 'LiFiDiamond')
  assert.equal(approvals.find((a) => a.standard === 'permit2')!.spenderLabel!.name, 'THORChain_Router')
  assert.equal(approvals.find((a) => a.spender === EOA_SPENDER)!.spenderLabel, undefined)
  const broken = new ApprovalsProtocolEvm(stubAccount(stubProvider(scenario()), { readOnly: true }), { chainId: 1, labels: { resolve: async () => { throw new Error('boom') } } })
  assert.equal((await broken.getApprovals()).approvals.length, 6)
})
