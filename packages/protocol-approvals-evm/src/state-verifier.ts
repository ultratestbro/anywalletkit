import { decodeFunctionResult, encodeFunctionData, getAddress, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'

import { ApprovalsError, type Approval, type ApprovalStandard } from './approvals-protocol.js'
import type { Candidate } from './sources/rpc-logs.js'
import {
  ERC1155_INTERFACE_ID, ERC20_ABI, ERC721_ABI, MAX_UINT160, MULTICALL3_ABI, MULTICALL3_ADDRESS,
  PERMIT2_ABI, PERMIT2_ADDRESS, UNLIMITED_THRESHOLD
} from './standards.js'

export interface StateVerifierOptions {
  /** A viem public client. */
  provider: PublicClient
  /** Multicall3 address, or false to always use single calls. */
  multicall?: string | false | undefined
  /** Calls per `aggregate3` (default 200). */
  batchSize?: number
  /** Parallel batches / code reads (default 4). */
  concurrency?: number
}

export interface VerifyOptions {
  chainId: number | string
  /** Also return zero / expired entries (default false). */
  includeZero?: boolean
  /** Unix seconds "now" for Permit2 expirations (default: the clock). */
  now?: number
}

interface Call { target: Address; callData: Hex }
interface ReadResult { success: boolean; returnData: Hex }

const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Builds the deterministic approval id. */
export function approvalId ({ chainId, standard, token, spender, tokenId }: { chainId: number | string; standard: ApprovalStandard; token: string; spender: string; tokenId?: string | undefined }): string {
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
  private readonly _provider: PublicClient
  private readonly _multicall: string | false
  private readonly _batchSize: number
  private readonly _concurrency: number
  private _multicallBroken: boolean

  constructor ({ provider, multicall = MULTICALL3_ADDRESS, batchSize = 200, concurrency = 4 }: StateVerifierOptions) {
    if (!provider) throw new ApprovalsError('StateVerifier needs a provider.', 'provider-required')
    this._provider = provider
    this._multicall = multicall
    this._batchSize = batchSize
    this._concurrency = Math.max(1, concurrency)
    this._multicallBroken = false
  }

  async verify (owner: string, candidates: Candidate[], { chainId, includeZero = false, now = Math.floor(Date.now() / 1000) }: VerifyOptions): Promise<Approval[]> {
    owner = getAddress(owner)
    const calls: Call[] = []
    const plan = candidates.map((c) => {
      const token = getAddress(c.token)
      const spender = getAddress(c.spender)
      const at = calls.length
      switch (c.kind) {
        case 'erc20':
          calls.push({ target: token, callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'allowance', args: [owner as Address, spender] }) })
          break
        case 'erc721-token':
          calls.push(
            { target: token, callData: encodeFunctionData({ abi: ERC721_ABI, functionName: 'getApproved', args: [BigInt(c.tokenId!)] }) },
            { target: token, callData: encodeFunctionData({ abi: ERC721_ABI, functionName: 'ownerOf', args: [BigInt(c.tokenId!)] }) }
          )
          break
        case 'nft-operator':
          calls.push(
            { target: token, callData: encodeFunctionData({ abi: ERC721_ABI, functionName: 'isApprovedForAll', args: [owner as Address, spender] }) },
            { target: token, callData: encodeFunctionData({ abi: ERC721_ABI, functionName: 'supportsInterface', args: [ERC1155_INTERFACE_ID] }) }
          )
          break
        case 'permit2':
          calls.push({ target: PERMIT2_ADDRESS, callData: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'allowance', args: [owner as Address, token, spender] }) })
          break
        default:
          throw new ApprovalsError(`Unknown candidate kind '${(c as Candidate).kind}'.`, 'invalid-approval', { candidate: c })
      }
      return { c, token, spender, at }
    })

    const results = await this._read(calls)
    const returned = (i: number): Hex | null => {
      const r = results[i]
      if (!r?.success || !r.returnData || r.returnData === '0x') return null
      return r.returnData
    }
    const decode = <T>(i: number, fn: (data: Hex) => T): T | null => {
      const data = returned(i)
      if (data === null) return null
      try { return fn(data) } catch { return null }
    }

    const approvals: Approval[] = []
    for (const { c, token, spender, at } of plan) {
      const grantedAt = { block: c.block, txHash: c.txHash }
      if (c.kind === 'erc20') {
        const d = decode(at, (data) => decodeFunctionResult({ abi: ERC20_ABI, functionName: 'allowance', data }))
        if (d === null) continue
        const amount = BigInt(d)
        if (amount === 0n && !includeZero) continue
        approvals.push(mk({ chainId, standard: 'erc20', token, spender, amount, unlimited: amount >= UNLIMITED_THRESHOLD, grantedAt }))
      } else if (c.kind === 'erc721-token') {
        const approved = decode(at, (data) => decodeFunctionResult({ abi: ERC721_ABI, functionName: 'getApproved', data }))
        const ownerOf = decode(at + 1, (data) => decodeFunctionResult({ abi: ERC721_ABI, functionName: 'ownerOf', data }))
        if (approved === null || ownerOf === null) continue
        const live = eqAddr(approved, spender) && approved !== zeroAddress && eqAddr(ownerOf, owner)
        if (!live && !includeZero) continue
        approvals.push(mk({ chainId, standard: 'erc721-token', token, spender, amount: live ? 1n : 0n, unlimited: false, tokenId: c.tokenId, grantedAt }))
      } else if (c.kind === 'nft-operator') {
        const flag = decode(at, (data) => decodeFunctionResult({ abi: ERC721_ABI, functionName: 'isApprovedForAll', data }))
        if (flag === null) continue
        const is1155 = decode(at + 1, (data) => decodeFunctionResult({ abi: ERC721_ABI, functionName: 'supportsInterface', data })) === true
        if (!flag && !includeZero) continue
        approvals.push(mk({ chainId, standard: is1155 ? 'erc1155' : 'erc721', token, spender, amount: null, unlimited: flag === true, grantedAt }))
      } else if (c.kind === 'permit2') {
        const d = decode(at, (data) => decodeFunctionResult({ abi: PERMIT2_ABI, functionName: 'allowance', data }))
        if (d === null) continue
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

  private async _read (calls: Call[]): Promise<ReadResult[]> {
    if (!calls.length) return []
    if (this._multicall && !this._multicallBroken) {
      try {
        return await this._readMulticall(calls)
      } catch {
        // No Multicall3 on this chain (or a node that cannot serve it): fall back for good.
        this._multicallBroken = true
      }
    }
    return this._readSingle(calls)
  }

  private async _readMulticall (calls: Call[]): Promise<ReadResult[]> {
    const batches: Call[][] = []
    for (let i = 0; i < calls.length; i += this._batchSize) batches.push(calls.slice(i, i + this._batchSize))
    const out: ReadResult[][] = new Array(batches.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < batches.length) {
        const i = next++
        const data = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: 'aggregate3', args: [batches[i]!.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))] })
        const raw = (await this._provider.call({ to: this._multicall as Address, data })).data
        if (!raw || raw === '0x') throw new Error('Multicall3 returned no data')
        out[i] = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', data: raw }).map((r) => ({ success: r.success, returnData: r.returnData }))
      }
    }
    await Promise.all(Array.from({ length: this._concurrency }, worker))
    return out.flat()
  }

  private async _readSingle (calls: Call[]): Promise<ReadResult[]> {
    const out: ReadResult[] = new Array(calls.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < calls.length) {
        const i = next++
        try {
          out[i] = { success: true, returnData: (await this._provider.call({ to: calls[i]!.target, data: calls[i]!.callData })).data ?? '0x' }
        } catch {
          out[i] = { success: false, returnData: '0x' }
        }
      }
    }
    await Promise.all(Array.from({ length: this._concurrency }, worker))
    return out
  }

  private async _flagEoaSpenders (approvals: Approval[]): Promise<void> {
    const spenders = [...new Set(approvals.map((a) => a.spender.toLowerCase()))]
    const isEoa = new Map<string, boolean>()
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < spenders.length) {
        const s = spenders[next++]!
        try {
          const code = await this._provider.getCode({ address: s as Address })
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

function mk ({ chainId, standard, token, spender, amount, unlimited, tokenId, expiration, grantedAt }: {
  chainId: number | string
  standard: ApprovalStandard
  token: string
  spender: string
  amount: bigint | null
  unlimited: boolean
  tokenId?: string | undefined
  expiration?: number | undefined
  grantedAt?: { block?: number; txHash?: string } | undefined
}): Approval {
  const a: Approval = { id: approvalId({ chainId, standard, token, spender, tokenId }), standard, chainId, token, spender, amount, unlimited, risks: [] }
  if (tokenId !== undefined) a.tokenId = tokenId
  if (expiration !== undefined) a.expiration = expiration
  if (grantedAt) a.grantedAt = grantedAt
  if (unlimited) a.risks.push('unlimited')
  return a
}
