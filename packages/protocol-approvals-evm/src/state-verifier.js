'use strict'

import { ZeroAddress, getAddress } from 'ethers'

import { ApprovalsError } from './approvals-protocol.js'
import {
  ERC1155_INTERFACE_ID, ERC20_ABI, ERC721_ABI, MAX_UINT160, MULTICALL3_ABI, MULTICALL3_ADDRESS,
  PERMIT2_ABI, PERMIT2_ADDRESS, UNLIMITED_THRESHOLD
} from './standards.js'

/** @typedef {import('./approvals-protocol.js').Approval} Approval */
/** @typedef {import('./sources/rpc-logs.js').Candidate} Candidate */

const eqAddr = (a, b) => a.toLowerCase() === b.toLowerCase()

/** Builds the deterministic approval id. */
export function approvalId ({ chainId, standard, token, spender, tokenId }) {
  return `${chainId}:${standard}:${token.toLowerCase()}:${spender.toLowerCase()}${tokenId !== undefined ? ':' + tokenId : ''}`
}

/**
 * Turns candidates into approvals by reading the chain: the current
 * allowance / operator flag / Permit2 allowance is the truth, the log that
 * produced the candidate is only where it was granted. Reads are batched
 * through Multicall3 (`aggregate3`, allowFailure) and fall back to one
 * `eth_call` per read where Multicall3 is not deployed. Spender code is
 * read once per unique spender to flag EOAs.
 */
export default class StateVerifier {
  /**
   * @param {Object} options
   * @param {import('ethers').Provider} options.provider
   * @param {string | false} [options.multicall] - Multicall3 address, or false to always use single calls.
   * @param {number} [options.batchSize] - Calls per `aggregate3` (default 200).
   * @param {number} [options.concurrency] - Parallel batches / code reads (default 4).
   */
  constructor ({ provider, multicall = MULTICALL3_ADDRESS, batchSize = 200, concurrency = 4 }) {
    if (!provider) throw new ApprovalsError('StateVerifier needs a provider.', 'provider-required')
    /** @private */
    this._provider = provider
    /** @private */
    this._multicall = multicall
    /** @private */
    this._batchSize = batchSize
    /** @private */
    this._concurrency = Math.max(1, concurrency)
    /** @private */
    this._multicallBroken = false
  }

  /**
   * @param {string} owner
   * @param {Candidate[]} candidates
   * @param {{ chainId: number | string, includeZero?: boolean, now?: number }} options
   * @returns {Promise<Approval[]>}
   */
  async verify (owner, candidates, { chainId, includeZero = false, now = Math.floor(Date.now() / 1000) }) {
    owner = getAddress(owner)
    const calls = []
    const plan = candidates.map((c) => {
      const token = getAddress(c.token)
      const spender = getAddress(c.spender)
      const at = calls.length
      switch (c.kind) {
        case 'erc20':
          calls.push({ target: token, callData: ERC20_ABI.encodeFunctionData('allowance', [owner, spender]) })
          break
        case 'erc721-token':
          calls.push(
            { target: token, callData: ERC721_ABI.encodeFunctionData('getApproved', [c.tokenId]) },
            { target: token, callData: ERC721_ABI.encodeFunctionData('ownerOf', [c.tokenId]) }
          )
          break
        case 'nft-operator':
          calls.push(
            { target: token, callData: ERC721_ABI.encodeFunctionData('isApprovedForAll', [owner, spender]) },
            { target: token, callData: ERC721_ABI.encodeFunctionData('supportsInterface', [ERC1155_INTERFACE_ID]) }
          )
          break
        case 'permit2':
          calls.push({ target: PERMIT2_ADDRESS, callData: PERMIT2_ABI.encodeFunctionData('allowance', [owner, token, spender]) })
          break
        default:
          throw new ApprovalsError(`Unknown candidate kind '${c.kind}'.`, 'invalid-approval', { candidate: c })
      }
      return { c, token, spender, at }
    })

    const results = await this._read(calls)
    const decode = (i, abi, fn) => {
      const r = results[i]
      if (!r?.success || !r.returnData || r.returnData === '0x') return null
      try { return abi.decodeFunctionResult(fn, r.returnData) } catch { return null }
    }

    /** @type {Approval[]} */
    const approvals = []
    for (const { c, token, spender, at } of plan) {
      const grantedAt = { block: c.block, txHash: c.txHash }
      if (c.kind === 'erc20') {
        const d = decode(at, ERC20_ABI, 'allowance')
        if (!d) continue
        const amount = BigInt(d[0])
        if (amount === 0n && !includeZero) continue
        approvals.push(mk({ chainId, standard: 'erc20', token, spender, amount, unlimited: amount >= UNLIMITED_THRESHOLD, grantedAt }))
      } else if (c.kind === 'erc721-token') {
        const approved = decode(at, ERC721_ABI, 'getApproved')
        const ownerOf = decode(at + 1, ERC721_ABI, 'ownerOf')
        if (!approved || !ownerOf) continue
        const live = eqAddr(approved[0], spender) && approved[0] !== ZeroAddress && eqAddr(ownerOf[0], owner)
        if (!live && !includeZero) continue
        approvals.push(mk({ chainId, standard: 'erc721-token', token, spender, amount: live ? 1n : 0n, unlimited: false, tokenId: c.tokenId, grantedAt }))
      } else if (c.kind === 'nft-operator') {
        const flag = decode(at, ERC721_ABI, 'isApprovedForAll')
        if (!flag) continue
        const is1155 = decode(at + 1, ERC721_ABI, 'supportsInterface')?.[0] === true
        if (!flag[0] && !includeZero) continue
        approvals.push(mk({ chainId, standard: is1155 ? 'erc1155' : 'erc721', token, spender, amount: null, unlimited: flag[0] === true, grantedAt }))
      } else if (c.kind === 'permit2') {
        const d = decode(at, PERMIT2_ABI, 'allowance')
        if (!d) continue
        const amount = BigInt(d[0])
        const expiration = Number(d[1])
        const expired = expiration !== 0 && expiration <= now
        if ((amount === 0n || expired) && !includeZero) continue
        const a = mk({ chainId, standard: 'permit2', token, spender, amount, unlimited: amount >= MAX_UINT160, expiration, grantedAt })
        if (expired) a.risks.push('expired')
        approvals.push(a)
      }
    }

    await this._flagEoaSpenders(approvals)
    return approvals
  }

  /**
   * @private
   * @param {Array<{ target: string, callData: string }>} calls
   * @returns {Promise<Array<{ success: boolean, returnData: string }>>}
   */
  async _read (calls) {
    if (!calls.length) return []
    if (this._multicall && !this._multicallBroken) {
      try {
        return await this._readMulticall(calls)
      } catch (err) {
        // No Multicall3 on this chain (or a node that cannot serve it): fall back for good.
        this._multicallBroken = true
      }
    }
    return this._readSingle(calls)
  }

  /** @private */
  async _readMulticall (calls) {
    const batches = []
    for (let i = 0; i < calls.length; i += this._batchSize) batches.push(calls.slice(i, i + this._batchSize))
    const out = new Array(batches.length)
    let next = 0
    const worker = async () => {
      while (next < batches.length) {
        const i = next++
        const data = MULTICALL3_ABI.encodeFunctionData('aggregate3', [batches[i].map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))])
        const raw = await this._provider.call({ to: this._multicall, data })
        if (!raw || raw === '0x') throw new Error('Multicall3 returned no data')
        out[i] = MULTICALL3_ABI.decodeFunctionResult('aggregate3', raw)[0].map((r) => ({ success: r.success, returnData: r.returnData }))
      }
    }
    await Promise.all(Array.from({ length: this._concurrency }, worker))
    return out.flat()
  }

  /** @private */
  async _readSingle (calls) {
    const out = new Array(calls.length)
    let next = 0
    const worker = async () => {
      while (next < calls.length) {
        const i = next++
        try {
          out[i] = { success: true, returnData: await this._provider.call({ to: calls[i].target, data: calls[i].callData }) }
        } catch {
          out[i] = { success: false, returnData: '0x' }
        }
      }
    }
    await Promise.all(Array.from({ length: this._concurrency }, worker))
    return out
  }

  /** @private */
  async _flagEoaSpenders (approvals) {
    const spenders = [...new Set(approvals.map((a) => a.spender.toLowerCase()))]
    const isEoa = new Map()
    let next = 0
    const worker = async () => {
      while (next < spenders.length) {
        const s = spenders[next++]
        try {
          const code = await this._provider.getCode(s)
          isEoa.set(s, !code || code === '0x')
        } catch {
          isEoa.set(s, false)
        }
      }
    }
    await Promise.all(Array.from({ length: this._concurrency }, worker))
    for (const a of approvals) {
      if (isEoa.get(a.spender.toLowerCase())) a.risks.push('eoa-spender')
    }
  }
}

function mk ({ chainId, standard, token, spender, amount, unlimited, tokenId, expiration, grantedAt }) {
  const a = { id: approvalId({ chainId, standard, token, spender, tokenId }), standard, chainId, token, spender, amount, unlimited, risks: [] }
  if (tokenId !== undefined) a.tokenId = tokenId
  if (expiration !== undefined) a.expiration = expiration
  if (grantedAt) a.grantedAt = grantedAt
  if (unlimited) a.risks.push('unlimited')
  return a
}
