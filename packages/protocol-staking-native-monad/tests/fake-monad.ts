import { decodeFunctionData, encodeFunctionResult, zeroAddress, type Hex } from 'viem'
import { STAKING_ABI } from '../src/abi.js'
import { STAKING_PRECOMPILE } from '../src/constants.js'

// An in-memory Monad node behind EIP-1193: eth_chainId, blocks, and eth_call to the staking
// precompile answered from a small model, with the precompile's real revert strings.

export const MON = 10n ** 18n
export const WALLET = '0x57A7c50E6C27B6252ff484785A6d75E294c8A0a5'
export const E = (pct: number) => (BigInt(Math.round(pct * 100)) * 10n ** 18n) / 10_000n // percent → 1e18 scale

export interface FakeValidator { auth: string; flags: bigint; stake: bigint; commission: bigint; consensusStake: bigint; consensusCommission: bigint }
export interface FakeDelegator { stake: bigint; rewards: bigint; delta: bigint; nextDelta: bigint; deltaEpoch: bigint; nextDeltaEpoch: bigint }

export class FakeMonad {
  chainId = 143
  epoch = 2332n
  inDelay = false
  balance = 1000n * MON
  validators = new Map<bigint, FakeValidator>()
  delegators = new Map<string, FakeDelegator>() // `${valId}:${address}`
  withdrawals = new Map<string, { amount: bigint; epoch: bigint }>() // `${valId}:${address}:${id}`
  consensus: bigint[] = []
  calls: Array<{ fn: string; args: readonly unknown[]; value?: bigint }> = []
  /** Force a revert reason for a function (as if the chain changed between the read and the call). */
  revertOn = new Map<string, string>()
  pageSize = 2

  constructor() {
    this.addValidator(97n, { commission: E(5), consensusStake: 2_000_000_000n * MON })
    this.addValidator(21n, { commission: E(10), consensusStake: 1_000_000_000n * MON })
    this.addValidator(165n, { commission: E(15), consensusStake: 500_000_000n * MON })
    this.addValidator(7n, { commission: E(0), consensusStake: 0n, flags: 2n }) // out of the set
  }

  addValidator(id: bigint, v: Partial<FakeValidator>) {
    const full: FakeValidator = { auth: '0x00000000000000000000000000000000000000a1', flags: 0n, stake: v.consensusStake ?? 0n, commission: 0n, consensusStake: 0n, consensusCommission: v.commission ?? 0n, ...v }
    this.validators.set(id, full)
    if (full.consensusStake > 0n) this.consensus.push(id)
  }

  delegator(valId: bigint, who = WALLET): FakeDelegator {
    const k = `${valId}:${who.toLowerCase()}`
    let d = this.delegators.get(k)
    if (!d) { d = { stake: 0n, rewards: 0n, delta: 0n, nextDelta: 0n, deltaEpoch: 0n, nextDeltaEpoch: 0n }; this.delegators.set(k, d) }
    return d
  }

  withdrawal(valId: bigint, id: number, amount: bigint, epoch: bigint, who = WALLET) {
    this.withdrawals.set(`${valId}:${who.toLowerCase()}:${id}`, { amount, epoch })
  }

  private revert(reason: string): never {
    throw Object.assign(new Error(`execution reverted: ${reason}`), { code: 3, data: '0x' })
  }

  private page(ids: bigint[], start: number): readonly [boolean, number, bigint[]] {
    const slice = ids.slice(start, start + this.pageSize)
    const next = start + slice.length
    return [next >= ids.length, next, slice]
  }

  private staking(data: Hex, from: string, value: bigint): Hex {
    const { functionName, args = [] } = decodeFunctionData({ abi: STAKING_ABI, data })
    const a = args as readonly unknown[]
    this.calls.push({ fn: functionName, args: a, value })
    const out = (result: unknown) => encodeFunctionResult({ abi: STAKING_ABI, functionName, result: result as never })
    const me = from.toLowerCase()
    const forced = this.revertOn.get(functionName)
    if (forced) this.revert(forced)
    switch (functionName) {
      case 'getEpoch': return out([this.epoch, this.inDelay])
      case 'getValidator': {
        const v = this.validators.get(a[0] as bigint)
        if (!v) return out([zeroAddress, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, '0x', '0x'])
        return out([v.auth, v.flags, v.stake, 0n, v.commission, 0n, v.consensusStake, v.consensusCommission, v.consensusStake, v.consensusCommission, '0x02', '0x03'])
      }
      case 'getDelegator': {
        const d = this.delegators.get(`${a[0]}:${(a[1] as string).toLowerCase()}`)
        return out(d ? [d.stake, 0n, d.rewards, d.delta, d.nextDelta, d.deltaEpoch, d.nextDeltaEpoch] : [0n, 0n, 0n, 0n, 0n, 0n, 0n])
      }
      case 'getWithdrawalRequest': {
        const w = this.withdrawals.get(`${a[0]}:${(a[1] as string).toLowerCase()}:${a[2]}`)
        return out(w ? [w.amount, 0n, w.epoch] : [0n, 0n, 0n])
      }
      case 'getConsensusValidatorSet': return out(this.page(this.consensus, a[0] as number))
      case 'getExecutionValidatorSet': case 'getSnapshotValidatorSet': return out(this.page(this.consensus, a[0] as number))
      case 'getDelegations': {
        // Like the precompile: a validator leaves the list once the wallet's stake there (incl. pending) is zero,
        // even while a withdrawal from it is still pending.
        const who = (a[0] as string).toLowerCase()
        const ids = [...this.delegators.entries()].filter(([k, d]) => k.split(':')[1] === who && d.stake + d.delta + d.nextDelta > 0n).map(([k]) => BigInt(k.split(':')[0]!))
        const start = Number(a[1] as bigint)
        const [done, next, list] = this.page(ids, start)
        return out([done, BigInt(next), list])
      }
      case 'delegate': {
        if (!this.validators.has(a[0] as bigint)) this.revert('unknown validator')
        if (value < 10n ** 9n) this.revert('delegation is too small')
        return out(true)
      }
      case 'undelegate': {
        // The precompile's order: unknown validator → withdrawal id exists → insufficient stake.
        if (!this.validators.has(a[0] as bigint)) this.revert('unknown validator')
        if (this.withdrawals.has(`${a[0]}:${me}:${a[2]}`)) this.revert('withdrawal id exists')
        const d = this.delegators.get(`${a[0]}:${me}`)
        if ((d?.stake ?? 0n) < (a[1] as bigint)) this.revert('insufficient stake')
        return out(true)
      }
      case 'withdraw': {
        const w = this.withdrawals.get(`${a[0]}:${me}:${a[1]}`)
        if (!w) this.revert('unknown withdrawal id')
        if (this.epoch < w.epoch + 1n) this.revert('withdrawal not ready')
        return out(true)
      }
      case 'compound': case 'claimRewards': return out(true)
      default: throw new Error(`FakeMonad: ${functionName}`)
    }
  }

  request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const p = (params ?? []) as unknown[]
    switch (method) {
      case 'eth_chainId': return `0x${this.chainId.toString(16)}`
      case 'eth_blockNumber': return '0x6f2a1b0'
      case 'eth_getBlockByNumber': {
        const head = 116_565_424n
        const n = p[0] === 'latest' ? head : BigInt(p[0] as string)
        // 300 ms blocks
        return { number: `0x${n.toString(16)}`, timestamp: `0x${(1_790_000_000n + ((n * 3n) / 10n)).toString(16)}`, hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, transactions: [], gasLimit: '0x1', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0', extraData: '0x', logsBloom: `0x${'00'.repeat(256)}`, miner: zeroAddress, mixHash: `0x${'00'.repeat(32)}`, nonce: '0x0000000000000000', receiptsRoot: `0x${'00'.repeat(32)}`, sha3Uncles: `0x${'00'.repeat(32)}`, size: '0x1', stateRoot: `0x${'00'.repeat(32)}`, totalDifficulty: '0x0', transactionsRoot: `0x${'00'.repeat(32)}`, uncles: [] }
      }
      case 'eth_call': {
        const call = p[0] as { to?: string; data?: Hex; from?: string; value?: string }
        if (call.to?.toLowerCase() !== STAKING_PRECOMPILE) throw new Error(`eth_call to ${call.to}`)
        return this.staking(call.data!, call.from ?? zeroAddress, call.value ? BigInt(call.value) : 0n)
      }
      default: throw new Error(`FakeMonad: no ${method}`)
    }
  }
}
