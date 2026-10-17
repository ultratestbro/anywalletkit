import { expect, test } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, getAbiItem, parseAbi, toFunctionSelector, type AbiFunction, type Hex } from 'viem'

import LidoProtocolEvm, { StakingProtocol, splitWithdrawalAmounts, type StakingWalletAccount } from '../src/index.js'

const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84'
const WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'
const QUEUE = '0x889edc2edab5f40e902b864ad4d7ade8e412f9b1'
const OWNER = '0x1111111111111111111111111111111111111111'
const E18 = 10n ** 18n

const erc20 = parseAbi([
  'function nonces(address _owner) view returns (uint256)',
  'function allowance(address _owner, address _spender) view returns (uint256)',
  'function approve(address _spender, uint256 _amount) returns (bool)',
  'function isStakingPaused() view returns (bool)',
  'function getCurrentStakeLimit() view returns (uint256)',
  'function submit(address _referral) payable returns (uint256)',
])
const queueAbi = parseAbi([
  'function requestWithdrawals(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function requestWithdrawalsWstETH(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWstETHWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function getWithdrawalRequests(address _owner) view returns (uint256[])',
])
const selector = (abi: typeof erc20 | typeof queueAbi, name: (typeof erc20)[number]['name'] | (typeof queueAbi)[number]['name']): string =>
  toFunctionSelector(getAbiItem({ abi, name } as never) as AbiFunction)

/** Decode calldata and assert it targets `functionName` (what ethers' Interface.decodeFunctionData(name, data) enforced). */
function decodeAs<const TAbi extends typeof erc20 | typeof queueAbi>(abi: TAbi, functionName: string, data: string) {
  const decoded = decodeFunctionData({ abi, data: data as Hex })
  expect(decoded.functionName).toBe(functionName)
  return decoded.args as readonly unknown[]
}

const SIG = '0x' + '12'.repeat(32) + '34'.repeat(32) + '1b'

type Eip1193 = { request(args: { method: string; params?: unknown }): Promise<unknown> }

/** Minimal EIP-1193 provider answering the calls this module makes. */
function stubEip1193({ allowance = 0n }: { allowance?: bigint } = {}): Eip1193 {
  return {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_call') {
        const { data } = (params as [{ data: string }])[0]
        const sel = data.slice(0, 10)
        if (sel === selector(erc20, 'nonces')) {
          return encodeFunctionResult({ abi: erc20, functionName: 'nonces', result: 0n })
        }
        if (sel === selector(erc20, 'allowance')) {
          return encodeFunctionResult({ abi: erc20, functionName: 'allowance', result: allowance })
        }
        if (sel === selector(erc20, 'isStakingPaused')) {
          return encodeFunctionResult({ abi: erc20, functionName: 'isStakingPaused', result: false })
        }
        if (sel === selector(erc20, 'getCurrentStakeLimit')) {
          return encodeFunctionResult({ abi: erc20, functionName: 'getCurrentStakeLimit', result: 150000n * E18 })
        }
        if (sel === selector(queueAbi, 'getWithdrawalRequests')) {
          return encodeFunctionResult({ abi: queueAbi, functionName: 'getWithdrawalRequests', result: [] })
        }
        return '0x' // the permit-proof call just needs to not revert
      }
      throw new Error(`stub provider: unexpected method ${method}`)
    },
  }
}

type TypedData = Parameters<NonNullable<StakingWalletAccount['signTypedData']>>[0]
type SentTx = Parameters<NonNullable<StakingWalletAccount['sendTransaction']>>[0]

interface StubAccount extends StakingWalletAccount {
  sent: SentTx[]
  typedDataCalls: TypedData[]
}

function stubAccount(provider: Eip1193, { signTypedData }: { signTypedData?: (typedData: TypedData) => string } = {}): StubAccount {
  const sent: SentTx[] = []
  return {
    sent,
    typedDataCalls: [],
    async getAddress() { return OWNER },
    async signTypedData(typedData) {
      this.typedDataCalls.push(typedData)
      if (signTypedData) return signTypedData(typedData)
      return SIG
    },
    async sendTransaction(tx) {
      sent.push(tx)
      return { hash: '0x' + 'ab'.repeat(32), fee: 5n }
    },
    async quoteSendTransaction(_tx) { return { fee: 3n } },
    _config: { provider },
  }
}

test('the base class throws NotImplementedError on every method', async () => {
  const base = new StakingProtocol({} as never) as unknown as Record<string, (o: unknown) => Promise<unknown>>
  for (const method of ['stake', 'quoteStake', 'requestWithdrawal', 'quoteRequestWithdrawal', 'getWithdrawalRequests', 'claimWithdrawals', 'quoteClaimWithdrawals', 'getStakedBalance', 'getApr']) {
    await expect(base[method]!({ amount: 1n })).rejects.toSatisfy((err: unknown) => (err as Error).name === 'NotImplementedError')
  }
})

test('splitWithdrawalAmounts splits over-cap amounts into caps plus remainder', () => {
  expect(splitWithdrawalAmounts(5n, 10n)).toEqual([5n])
  expect(splitWithdrawalAmounts(10n, 10n)).toEqual([10n])
  expect(splitWithdrawalAmounts(25n, 10n)).toEqual([10n, 10n, 5n])
})

test('constructor refuses unknown chains without explicit addresses', () => {
  expect(() => new LidoProtocolEvm({} as never, { chainId: 560048 })).toThrow(/addresses/)
  expect(() => new LidoProtocolEvm({} as never, { referral: 'not-an-address' })).toThrow(/referral/)
})

test('amount validation and the writable-account gate', async () => {
  const protocol = new LidoProtocolEvm(stubAccount(stubEip1193()))
  await expect(protocol.stake({ amount: 0n })).rejects.toThrow(/greater than zero/)
  await expect(protocol.stake({ amount: 1.5 })).rejects.toThrow(/bigint or a safe integer/)
  await expect(protocol.requestWithdrawal({ amount: 1n, token: 'wETH' as never })).rejects.toThrow(/'stETH' or 'wstETH'/)

  const readOnly = new LidoProtocolEvm({ async getAddress() { return OWNER }, _config: { provider: stubEip1193() } })
  await expect(readOnly.stake({ amount: 1n })).rejects.toThrow(/non read-only/)
})

test('stake submits with the configured referral', async () => {
  const referral = '0x2222222222222222222222222222222222222222'
  const account = stubAccount(stubEip1193())
  const protocol = new LidoProtocolEvm(account, { referral })
  const result = await protocol.stake({ amount: E18 })
  expect(result.hash).toBe('0x' + 'ab'.repeat(32))
  expect(account.sent.length).toBe(1)
  expect(account.sent[0]!.to.toLowerCase()).toBe(STETH)
  expect(account.sent[0]!.value).toBe(E18)
  const decoded = decodeAs(erc20, 'submit', account.sent[0]!.data!)
  expect((decoded[0] as string).toLowerCase()).toBe(referral)
})

test('requestWithdrawal goes permit-first: one transaction, no approval', async () => {
  const account = stubAccount(stubEip1193())
  const protocol = new LidoProtocolEvm(account)
  const result = await protocol.requestWithdrawal({ amount: E18 })
  expect(result.approveHash).toBe(null)
  expect(account.sent.length).toBe(1)
  expect(account.sent[0]!.to.toLowerCase()).toBe(QUEUE)
  const decoded = decodeAs(queueAbi, 'requestWithdrawalsWithPermit', account.sent[0]!.data!)
  expect([...(decoded[0] as readonly bigint[])]).toEqual([E18])
  expect((decoded[1] as string).toLowerCase()).toBe(OWNER)
  // and the permit was signed against the verified stETH domain
  const typed = account.typedDataCalls[0]!
  expect(typed.domain.name).toBe('Liquid staked Ether 2.0')
  expect(typed.domain.version).toBe('2')
  expect((typed.message.spender as string).toLowerCase()).toBe(QUEUE)
})

test('requestWithdrawal falls back to plain request when the permit leg fails and allowance suffices', async () => {
  const account = stubAccount(stubEip1193({ allowance: 10n * E18 }), {
    signTypedData: () => { throw new Error('user rejected') },
  })
  const protocol = new LidoProtocolEvm(account)
  const result = await protocol.requestWithdrawal({ amount: E18 })
  expect(result.approveHash).toBe(null)
  expect(account.sent.length).toBe(1)
  const decoded = decodeAs(queueAbi, 'requestWithdrawals', account.sent[0]!.data!)
  expect([...(decoded[0] as readonly bigint[])]).toEqual([E18])
})

test('wstETH withdrawals use the wstETH queue entrypoints, domain and 800-token cap', async () => {
  const account = stubAccount(stubEip1193())
  const protocol = new LidoProtocolEvm(account)
  await protocol.requestWithdrawal({ amount: 1600n * E18, token: 'wstETH' })
  const decoded = decodeAs(queueAbi, 'requestWithdrawalsWstETHWithPermit', account.sent[0]!.data!)
  expect([...(decoded[0] as readonly bigint[])]).toEqual([800n * E18, 800n * E18])
  const typed = account.typedDataCalls[0]!
  expect(typed.domain.name).toBe('Wrapped liquid staked Ether 2.0')
  expect(typed.domain.version).toBe('1')
  expect((typed.domain.verifyingContract as string).toLowerCase()).toBe(WSTETH)
})

test('an empty queue reads back as an empty view', async () => {
  const protocol = new LidoProtocolEvm(stubAccount(stubEip1193()))
  const view = await protocol.getWithdrawalRequests()
  expect(view).toEqual({ requests: [], pendingAmount: 0n, claimableAmount: 0n, claimableIds: [] })
})

test('claimWithdrawals refuses when nothing is claimable', async () => {
  const protocol = new LidoProtocolEvm(stubAccount(stubEip1193()))
  await expect(protocol.claimWithdrawals()).rejects.toThrow(/no claimable/)
})
