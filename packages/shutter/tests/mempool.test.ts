import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, parseTransaction, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  decrypt, encryptTransaction, getEncryptedSendStatus, mempoolIdentity, sendEncryptedTransaction, submitEncryptedCalldata, waitForEncryptedTransaction,
  SHUTTER_GNOSIS_MEMPOOL, ShutterError, type EncryptedSend, type ShutterMempoolAccount, type ShutterSignRequest,
} from '../src/index.js'
import { toHex } from '../src/bytes.js'
import { keyper } from './keyper.js'

const k = keyper()
const signer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const SEQ = parseAbi(['function submitEncryptedTransaction(uint64 eon, bytes32 identityPrefix, bytes encryptedTransaction, uint256 gasLimit) payable'])
const TO = '0x00000000000000000000000000000000000000aa'
const GWEI = 1_000_000_000n
const word = (n: bigint) => n.toString(16).padStart(64, '0')
const abiBytes = (hex: string) => {
  const b = hex.slice(2)
  return `0x${word(32n)}${word(BigInt(b.length / 2))}${b.padEnd(Math.ceil(b.length / 64) * 64, '0')}`
}

/**
 * Intrinsic gas after Pectra: 21000 + calldata at 16 gas per non-zero byte and 4 per zero byte, but at least the
 * EIP-7623 floor of 21000 + 10 per token (a zero byte is 1 token, a non-zero byte 4). Gnosis applies the floor.
 */
function calldataGas(data: string): { standard: bigint; floor: bigint } {
  let zero = 0n
  let nonzero = 0n
  for (let i = 2; i < data.length; i += 2) if (data.slice(i, i + 2) === '00') zero++; else nonzero++
  return { standard: 21_000n + 4n * zero + 16n * nonzero, floor: 21_000n + 10n * (zero + 4n * nonzero) }
}
const max = (a: bigint, b: bigint) => (a > b ? a : b)
const intrinsicGas = (data: string) => max(calldataGas(data).standard, calldataGas(data).floor)
/** What a node answers for the submission: the standard cost plus ~30k of execution (the event), or the floor. */
const submissionEstimate = (data: string) => max(calldataGas(data).standard + 30_000n, calldataGas(data).floor)

/** The account as a wallet would hand it over: signs offline, nothing else. */
function account(over: { tamper?: boolean } = {}): ShutterMempoolAccount & { signed: ShutterSignRequest[] } {
  const signed: ShutterSignRequest[] = []
  return {
    address: signer.address,
    signed,
    async signTransaction(tx) {
      signed.push(tx)
      return signer.signTransaction({ type: 'eip1559', chainId: tx.chainId, nonce: tx.nonce, to: tx.to as Hex, value: tx.value, data: tx.data, gas: over.tamper ? tx.gasLimit + 1n : tx.gasLimit, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas })
    },
  }
}

/** A Gnosis RPC stand-in with the Shutter contracts (one-key keyper set, eon 10). */
function fakeRpc(over: { innerGas?: bigint; chainId?: number; eonKey?: string; balance?: bigint; nonce?: number; latestNonce?: number; receipts?: Record<string, unknown> } = {}) {
  const sent: string[] = []
  const calls: string[] = []
  const rpc = {
    sent,
    calls,
    async request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
      calls.push(method)
      switch (method) {
        case 'eth_chainId': return `0x${(over.chainId ?? 100).toString(16)}`
        case 'eth_getBlockByNumber': return { number: '0x2f0c000', baseFeePerGas: `0x${GWEI.toString(16)}` }
        case 'eth_maxPriorityFeePerGas': return '0x1'
        case 'eth_estimateGas': {
          const { to, data } = params[0] as { to: string; data: string }
          return to.toLowerCase() === SHUTTER_GNOSIS_MEMPOOL.sequencer.toLowerCase() ? `0x${submissionEstimate(data).toString(16)}` : `0x${(over.innerGas ?? 21_000n).toString(16)}`
        }
        case 'eth_getTransactionCount': return `0x${((params[1] === 'latest' ? over.latestNonce : undefined) ?? over.nonce ?? 7).toString(16)}`
        case 'eth_getBalance': return `0x${(over.balance ?? 10n ** 18n).toString(16)}`
        case 'eth_call': {
          const { to, data } = params[0] as { to: string; data: string }
          if (to === SHUTTER_GNOSIS_MEMPOOL.keyperSetManager) return `0x${word(10n)}`
          if (to === SHUTTER_GNOSIS_MEMPOOL.keyBroadcast) { expect(data.slice(10)).toBe(word(10n)); return abiBytes(over.eonKey ?? k.eonKey) }
          throw new Error(`unexpected call to ${to}`)
        }
        case 'eth_sendRawTransaction': sent.push(params[0] as string); return keccak256(params[0] as Hex)
        case 'eth_getTransactionReceipt': return over.receipts?.[params[0] as string] ?? null
        default: throw new Error(`unexpected ${method}`)
      }
    },
  }
  return rpc
}

describe('mempool encoding', () => {
  it('builds the same submitEncryptedTransaction calldata as viem', () => {
    const args = { eon: 10, identityPrefix: `0x${'ab'.repeat(32)}` as Hex, ciphertext: `0x03${'cd'.repeat(200)}` as Hex, gasLimit: 51_807n }
    expect(submitEncryptedCalldata(args)).toBe(encodeFunctionData({ abi: SEQ, functionName: 'submitEncryptedTransaction', args: [10n, args.identityPrefix, args.ciphertext, 51_807n] }))
  })

  it('encrypts for identityPrefix ‖ sender: the keypers\' key for that preimage opens it', () => {
    const raw = '0x02f86b64078203e8843b9aca00825208940000000000000000000000000000000000aa8080c0'
    const { identityPrefix, ciphertext } = encryptTransaction({ signedTransaction: raw, sender: signer.address, eonKey: k.eonKey })
    const preimage = mempoolIdentity(identityPrefix, signer.address)
    expect(preimage.length).toBe(52)
    expect(toHex(decrypt(ciphertext, k.keyFor(toHex(preimage))))).toBe(raw)
    // Another sender's identity does not open it.
    expect(() => decrypt(ciphertext, k.keyFor(toHex(mempoolIdentity(identityPrefix, TO))))).toThrow()
  })
})

describe('sendEncryptedTransaction', () => {
  it('signs nonce n+1 inside the ciphertext, submits it with nonce n, and pays the encrypted gas', async () => {
    const rpc = fakeRpc()
    const acc = account()
    const sent = await sendEncryptedTransaction({ rpc, account: acc, tx: { to: TO, value: 5n } })
    expect(acc.signed.map((t) => t.nonce)).toEqual([8, 7])
    expect(rpc.sent).toHaveLength(1)

    const submission = parseTransaction(rpc.sent[0] as Hex)
    expect(submission.nonce).toBe(7)
    expect(submission.chainId).toBe(100)
    expect(submission.to?.toLowerCase()).toBe(SHUTTER_GNOSIS_MEMPOOL.sequencer.toLowerCase())
    expect(keccak256(rpc.sent[0] as Hex)).toBe(sent.submissionHash)
    const { args } = decodeFunctionData({ abi: SEQ, data: submission.data! })
    const [eon, prefix, ciphertext, gasLimit] = args
    expect(eon).toBe(10n)
    expect(prefix).toBe(sent.identityPrefix)
    expect(gasLimit).toBe(25_200n) // 21000 + 20 %
    expect(submission.value).toBe(gasLimit * submission.maxFeePerGas!)
    expect(sent.encryptedGasFee).toBe(submission.value)
    expect(submission.maxFeePerGas).toBe(3n * GWEI) // 2 × base fee + the 1 gwei floor tip

    // What the keypers' key opens is the signed transaction itself, under the returned hash.
    const inner = toHex(decrypt(ciphertext, k.keyFor(toHex(mempoolIdentity(prefix, signer.address)))))
    expect(keccak256(inner)).toBe(sent.transactionHash)
    const tx = parseTransaction(inner)
    expect({ nonce: tx.nonce, to: tx.to, value: tx.value, gas: tx.gas, chainId: tx.chainId }).toEqual({ nonce: 8, to: TO, value: 5n, gas: 25_200n, chainId: 100 })
    expect(sent).toMatchObject({ nonce: 8, eon: 10, network: 'gnosis', from: signer.address.toLowerCase() })
  })

  it('gives a swap-sized submission enough gas for its random ciphertext (intrinsic gas regression)', async () => {
    const rpc = fakeRpc({ innerGas: 516_137n })
    const swapData = `0x${'5a'.repeat(2020)}` as Hex
    await sendEncryptedTransaction({ rpc, account: account(), tx: { to: TO, value: 10n ** 16n, data: swapData } })
    const submission = parseTransaction(rpc.sent[0] as Hex)
    expect(submission.gas! >= intrinsicGas(submission.data!)).toBe(true)
  })

  it('refuses before signing anything: wrong chain, gas over the per-block cap, a balance short of both transactions, no eon key, shut down', async () => {
    const cases: [ReturnType<typeof fakeRpc>, Parameters<typeof sendEncryptedTransaction>[0]['tx'], RegExp, typeof SHUTTER_GNOSIS_MEMPOOL?][] = [
      [fakeRpc({ chainId: 1 }), { to: TO }, /chain 1/],
      [fakeRpc(), { to: TO, gasLimit: 1_000_001n }, /set aside per block/],
      [fakeRpc({ balance: 1000n }), { to: TO }, /insufficient balance/],
      [fakeRpc({ eonKey: '0x' }), { to: TO }, /not published the key of eon 10/],
      [fakeRpc(), { to: TO }, /shut down/, { ...SHUTTER_GNOSIS_MEMPOOL, sunsetAt: 1 }],
    ]
    for (const [rpc, tx, message, network] of cases) {
      const acc = account()
      await expect(sendEncryptedTransaction({ rpc, account: acc, tx, network })).rejects.toThrow(message)
      expect(acc.signed).toHaveLength(0)
      expect(rpc.sent).toHaveLength(0)
    }
  })

  it('refuses a signature for something other than what was asked, and sends nothing', async () => {
    const rpc = fakeRpc()
    await expect(sendEncryptedTransaction({ rpc, account: account({ tamper: true }), tx: { to: TO } })).rejects.toThrow(/signed something other/)
    expect(rpc.sent).toHaveLength(0)
  })

  it('the Gnosis preset is refused from 2026-11-24 (decommissioned 11-25)', () => {
    expect(new Date(SHUTTER_GNOSIS_MEMPOOL.sunsetAt! * 1000).toISOString()).toBe('2026-11-24T00:00:00.000Z')
  })
})

describe('encrypted send status', () => {
  const sent: EncryptedSend = {
    network: 'gnosis', chainId: 100, from: signer.address.toLowerCase() as Hex, transactionHash: `0x${'11'.repeat(32)}`, nonce: 8, submissionHash: `0x${'22'.repeat(32)}`,
    eon: 10, identityPrefix: `0x${'33'.repeat(32)}`, gasLimit: 21_000n, encryptedGasFee: 1n, submittedAtBlock: 100,
  }

  it('included, with how many blocks it took', async () => {
    const rpc = fakeRpc({ receipts: { [sent.transactionHash]: { blockNumber: '0x6e', status: '0x1' } } })
    expect(await getEncryptedSendStatus(rpc, sent)).toEqual({ status: 'included', blockNumber: 110, success: true, blocksAfterSubmission: 10 })
  })

  it('submission reverted', async () => {
    const rpc = fakeRpc({ receipts: { [sent.submissionHash]: { blockNumber: '0x65', status: '0x0' } } })
    expect(await getEncryptedSendStatus(rpc, sent)).toEqual({ status: 'submission-failed', blockNumber: 101 })
  })

  it('replaced when another transaction took the nonce', async () => {
    const rpc = fakeRpc({ latestNonce: 9, receipts: { [sent.submissionHash]: { blockNumber: '0x65', status: '0x1' } } })
    expect(await getEncryptedSendStatus(rpc, sent)).toEqual({ status: 'replaced' })
  })

  it('pending until the timeout', async () => {
    const rpc = fakeRpc({ latestNonce: 8 })
    expect(await waitForEncryptedTransaction(rpc, sent, { timeoutMs: 10, pollMs: 500 })).toEqual({ status: 'pending', submissionMined: false })
  })
})

describe('errors', () => {
  it('are ShutterErrors', async () => {
    await expect(sendEncryptedTransaction({ rpc: fakeRpc({ chainId: 1 }), account: account(), tx: { to: TO } })).rejects.toBeInstanceOf(ShutterError)
  })
})
