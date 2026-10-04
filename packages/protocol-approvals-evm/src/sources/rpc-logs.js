'use strict'

import { AbiCoder } from 'ethers'

import { ApprovalsError } from '../approvals-protocol.js'
import { DISCOVERY_TOPICS, PERMIT2_ADDRESS, TOPICS, ownerTopic, topicAddress } from '../standards.js'

/**
 * A `(token, spender)` pair seen in the account's approval events. Only a
 * hint: the current on-chain state is what {@link StateVerifier} reads.
 * Plain JSON (no bigint) so hosts can persist it as the scan cache.
 *
 * @typedef {Object} Candidate
 * @property {'erc20' | 'erc721-token' | 'nft-operator' | 'permit2'} kind
 * @property {string} token
 * @property {string} spender
 * @property {string} [tokenId] - Decimal string, `erc721-token` only.
 * @property {number} block
 * @property {string} txHash
 * @property {number} logIndex
 */

/**
 * @typedef {Object} CollectResult
 * @property {Candidate[]} candidates
 * @property {boolean} complete
 * @property {Array<[number, number]>} gaps - Block ranges that stayed too large to fetch.
 */

/**
 * Discovery source contract: turn a block range into candidate pairs.
 *
 * @typedef {Object} ApprovalSource
 * @property {string} name
 * @property {(owner: string, range: { fromBlock: number, toBlock: number }) => Promise<CollectResult>} collect
 */

const coder = AbiCoder.defaultAbiCoder()
const eqAddr = (a, b) => a.toLowerCase() === b.toLowerCase()

/** Deterministic key of a candidate (used for de-duplication and cache merges). */
export function candidateKey (c) {
  return `${c.kind}:${c.token.toLowerCase()}:${c.spender.toLowerCase()}${c.tokenId !== undefined ? ':' + c.tokenId : ''}`
}

/**
 * Classifies one raw `eth_getLogs` entry. Returns null for logs that are not
 * an approval granted BY the owner (e.g. a Permit2 event on a look-alike
 * contract, or an ERC-721 `Approval` where the owner sits in another slot).
 *
 * @param {{ address: string, topics: string[], data: string, blockNumber: number, transactionHash: string, index?: number, logIndex?: number }} log
 * @param {string} owner
 * @returns {Candidate | null}
 */
export function parseApprovalLog (log, owner) {
  const [topic0, topic1, topic2, topic3] = log.topics
  if (!topic1 || !eqAddr(topicAddress(topic1), owner)) return null
  const base = { block: Number(log.blockNumber), txHash: log.transactionHash, logIndex: Number(log.index ?? log.logIndex ?? 0) }
  const address = log.address

  if (topic0 === TOPICS.approval) {
    if (log.topics.length === 3) return { kind: 'erc20', token: address, spender: topicAddress(topic2), ...base }
    if (log.topics.length === 4) return { kind: 'erc721-token', token: address, spender: topicAddress(topic2), tokenId: BigInt(topic3).toString(), ...base }
    return null
  }
  if (topic0 === TOPICS.approvalForAll && log.topics.length === 3) {
    return { kind: 'nft-operator', token: address, spender: topicAddress(topic2), ...base }
  }
  if (!eqAddr(address, PERMIT2_ADDRESS)) return null
  if ((topic0 === TOPICS.permit2Approval || topic0 === TOPICS.permit2Permit) && log.topics.length === 4) {
    return { kind: 'permit2', token: topicAddress(topic2), spender: topicAddress(topic3), ...base }
  }
  if (topic0 === TOPICS.permit2Lockdown && log.topics.length === 2) {
    const [token, spender] = coder.decode(['address', 'address'], log.data)
    return { kind: 'permit2', token, spender, ...base }
  }
  return null
}

/** Keeps the most recent event per key. */
export function mergeCandidates (...lists) {
  const byKey = new Map()
  for (const list of lists) {
    for (const c of list) {
      const key = candidateKey(c)
      const prev = byKey.get(key)
      if (!prev || prev.block < c.block || (prev.block === c.block && prev.logIndex < c.logIndex)) byKey.set(key, c)
    }
  }
  return [...byKey.values()]
}

/**
 * True for the node errors that mean "narrow the block range" (the
 * DivideAndConquer heuristic of revoke.cash). Only the node's own message is
 * inspected — ethers' wrapper repeats the whole request payload, whose hex
 * would trip the patterns.
 */
export function isRangeError (err) {
  const text = err?.error?.message ?? err?.info?.error?.message ?? err?.shortMessage ?? err?.message ?? String(err)
  if (/rate limit/i.test(text)) return false // a throttled node wants a pause, not a narrower range
  return /too (many|large)|exceed|limit|range|response size|more than \d+ (results|logs)|query timeout/i.test(text)
}

/**
 * Discovers candidates from `eth_getLogs` alone — no indexer, no API key.
 *
 * One request asks for every approval-shaped event with the owner in
 * `topic1` and no `address` filter, so a range covers every token at once.
 * A range the node refuses ("too many results", "range too large") is split
 * in half and retried; a single block that is still refused becomes a gap
 * (`complete: false`) instead of an exception, so a very active address
 * degrades to "partial" rather than "nothing".
 */
export default class RpcLogsSource {
  /**
   * @param {Object} options
   * @param {import('ethers').Provider} options.provider - An ethers provider.
   * @param {number | null} [options.blockRange] - Pre-chunk requests to this many blocks (QuickNode: 10 000). Null tries the whole range first.
   * @param {number} [options.concurrency] - Parallel `eth_getLogs` requests (default 4).
   * @param {number} [options.retries] - Retries for transient (non-range) errors (default 2).
   * @param {number} [options.retryDelay] - Milliseconds between those retries (default 300).
   */
  constructor ({ provider, blockRange = null, concurrency = 4, retries = 2, retryDelay = 300 }) {
    if (!provider) throw new ApprovalsError('RpcLogsSource needs a provider.', 'provider-required')
    this.name = 'rpc-logs'
    /** @private */
    this._provider = provider
    /** @private */
    this._blockRange = blockRange
    /** @private */
    this._concurrency = Math.max(1, concurrency)
    /** @private */
    this._retries = retries
    /** @private */
    this._retryDelay = retryDelay ?? 300
    /** How many `eth_getLogs` requests the last `collect` issued (diagnostics). */
    this.requests = 0
  }

  /**
   * @param {string} owner
   * @param {{ fromBlock: number, toBlock: number }} range
   * @returns {Promise<CollectResult>}
   */
  async collect (owner, { fromBlock, toBlock }) {
    this.requests = 0
    if (toBlock < fromBlock) return { candidates: [], complete: true, gaps: [] }
    const topics = [DISCOVERY_TOPICS.slice(), ownerTopic(owner)]
    const pending = []
    if (this._blockRange && this._blockRange > 0) {
      for (let a = fromBlock; a <= toBlock; a += this._blockRange) pending.push([a, Math.min(toBlock, a + this._blockRange - 1)])
    } else {
      pending.push([fromBlock, toBlock])
    }
    // Newest ranges first: the cache benefits most from recent state when a
    // scan is interrupted, and the newest event per pair wins on merge anyway.
    pending.reverse()

    const found = []
    const gaps = []
    let failure = null
    const worker = async () => {
      while (pending.length && !failure) {
        const [a, b] = pending.pop()
        try {
          const logs = await this._getLogs({ fromBlock: a, toBlock: b, topics })
          for (const log of logs) {
            const c = parseApprovalLog(log, owner)
            if (c) found.push(c)
          }
        } catch (err) {
          if (!isRangeError(err)) { failure = err; break }
          if (a === b) { gaps.push([a, b]); continue }
          const mid = a + Math.floor((b - a) / 2)
          pending.push([a, mid], [mid + 1, b])
        }
      }
    }
    await Promise.all(Array.from({ length: this._concurrency }, worker))
    if (failure) {
      throw new ApprovalsError(`eth_getLogs failed: ${failure.message ?? failure}`, 'source-failed', { cause: failure })
    }
    gaps.sort((x, y) => x[0] - y[0])
    return { candidates: mergeCandidates(found), complete: gaps.length === 0, gaps }
  }

  /** @private */
  async _getLogs (filter) {
    let lastErr
    for (let attempt = 0; attempt <= this._retries; attempt++) {
      try {
        this.requests++
        return await this._provider.getLogs(filter)
      } catch (err) {
        lastErr = err
        if (isRangeError(err)) throw err
        if (attempt < this._retries && this._retryDelay > 0) await new Promise((resolve) => setTimeout(resolve, this._retryDelay * (attempt + 1)))
      }
    }
    throw lastErr
  }
}
