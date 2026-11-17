/**
 * Shutter's encrypted mempool: the transaction is signed and then encrypted on the device, and only the ciphertext
 * goes on chain (`Sequencer.submitEncryptedTransaction`). The keypers release its key for the slot it is scheduled in,
 * a Shutter validator decrypts it and puts it in that block — the order is fixed before anyone can read it, so nobody
 * can front-run or sandwich it. No operator ever sees the plaintext (unlike an encrypting RPC).
 *
 * The wallet sends two transactions from one account: the submission (nonce n, to the Sequencer, paying the
 * encrypted-gas fee) and, inside the ciphertext, the transaction itself (nonce n + 1). Until the decrypted one is in a
 * block the account must send nothing else: any transaction with nonce n + 1 replaces it (that is also how to cancel).
 */
import { keccak_256 } from '@noble/hashes/sha3.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { bytesOf, randomHex32, toHex, utf8Encode, type BytesLike } from './bytes.js'
import { encrypt } from './crypto.js'
import { ShutterCryptoError, ShutterError } from './errors.js'
import { rlpDecode, rlpUint } from './rlp.js'

/** Where a Shutter encrypted mempool runs: the contracts its keypers and validators watch. */
export interface ShutterMempoolNetwork {
  readonly name: string
  readonly chainId: number
  /** Takes the ciphertexts: `submitEncryptedTransaction(eon, identityPrefix, encryptedTransaction, gasLimit)`. */
  readonly sequencer: string
  /** Which keyper set (eon) serves which block. */
  readonly keyperSetManager: string
  /** Where each eon's public key is published by its keypers. */
  readonly keyBroadcast: string
  /** The eon is chosen for the block this many blocks ahead (a keyper-set change must not strand the ciphertext). */
  readonly eonLookahead: number
  /** Gas set aside per block for decrypted transactions: a transaction with a larger gas limit is never included. */
  readonly maxEncryptedGas: bigint
  /** Unix time, seconds: from then on the network is refused (the mempool is shut down). */
  readonly sunsetAt?: number | undefined
}

/**
 * Shutterized Gnosis Chain (contracts read on chain 2026-11-18: eon 10; 37 of ~296k validators registered, so a
 * decrypting block comes about every 11 hours). Shutter decommissions it on 2026-11-25; refused from 2026-11-24 00:00 UTC.
 */
export const SHUTTER_GNOSIS_MEMPOOL: ShutterMempoolNetwork = {
  name: 'gnosis',
  chainId: 100,
  sequencer: '0xc5C4b277277A1A8401E0F039dfC49151bA64DC2E',
  keyperSetManager: '0x7C2337f9bFce19d8970661DA50dE8DD7d3D34abb',
  keyBroadcast: '0x626dB87f9a9aC47070016A50e802dd5974341301',
  eonLookahead: 1,
  maxEncryptedGas: 1_000_000n,
  sunsetAt: Date.UTC(2026, 10, 24) / 1000,
}

/** An EIP-1193 provider, or anything with its `request` (a viem client, a wallet-evm RPC). Reads and one broadcast. */
export interface ShutterRpc {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

/** The fully specified EIP-1559 transaction the account is asked to sign (and not send). */
export interface ShutterSignRequest {
  readonly type: 2
  readonly chainId: number
  readonly nonce: number
  readonly to: string
  readonly value: bigint
  readonly data: `0x${string}`
  readonly gasLimit: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
}

/** The sending account: it signs both transactions offline; this module broadcasts only the submission. */
export interface ShutterMempoolAccount {
  readonly address: string
  /** Sign without broadcasting; return the signed transaction (`0x02…`). wallet-evm's `signTransaction` fits. */
  signTransaction(tx: ShutterSignRequest): Promise<string>
}

export interface EncryptedTransactionRequest {
  readonly to: string
  readonly data?: `0x${string}` | undefined
  readonly value?: bigint | undefined
  /** Estimated (+20 %) when absent. It is also the encrypted-gas limit the fee is paid for. */
  readonly gasLimit?: bigint | undefined
}

export interface SendEncryptedInput {
  readonly rpc: ShutterRpc
  readonly account: ShutterMempoolAccount
  readonly tx: EncryptedTransactionRequest
  /** Default Shutterized Gnosis Chain. */
  readonly network?: ShutterMempoolNetwork | undefined
  /** Default 2 × the latest base fee + the tip. Used for both transactions. */
  readonly maxFeePerGas?: bigint | undefined
  /** Default `eth_maxPriorityFeePerGas`, at least 1 gwei. */
  readonly maxPriorityFeePerGas?: bigint | undefined
}

export interface EncryptedSend {
  readonly network: string
  readonly chainId: number
  readonly from: `0x${string}`
  /** Hash of the transaction itself: it lands under this hash once decrypted. */
  readonly transactionHash: `0x${string}`
  /** Its nonce (the submission's nonce is one less). Any other transaction with this nonce replaces it. */
  readonly nonce: number
  /** The public submission to the Sequencer (it carries only the ciphertext). */
  readonly submissionHash: `0x${string}`
  readonly eon: number
  readonly identityPrefix: `0x${string}`
  readonly gasLimit: bigint
  /** Paid to the Sequencer for the encrypted gas (gasLimit × maxFeePerGas). */
  readonly encryptedGasFee: bigint
  /** Block number when it was submitted, for the wait. */
  readonly submittedAtBlock: number
}

const SUBMIT_SELECTOR = toHex(keccak_256(utf8Encode('submitEncryptedTransaction(uint64,bytes32,bytes,uint256)'))).slice(2, 10)
const GET_EON_SELECTOR = toHex(keccak_256(utf8Encode('getKeyperSetIndexByBlock(uint64)'))).slice(2, 10)
const GET_EON_KEY_SELECTOR = toHex(keccak_256(utf8Encode('getEonKey(uint64)'))).slice(2, 10)
const GWEI = 1_000_000_000n

/** A bigint known to be small (nonce, block number, offset): checked, then converted through its decimal string. */
function safeInt(n: bigint, what: string): number {
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ShutterError(`unexpected ${what}`)
  return Number(n.toString())
}

const word = (n: bigint) => {
  if (n < 0n || n >= 1n << 256n) throw new ShutterError('value does not fit uint256')
  return n.toString(16).padStart(64, '0')
}

function address(value: string, what: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new ShutterError(`${what} is not an EVM address`)
  return value.toLowerCase() as `0x${string}`
}

function quantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new ShutterError(`the RPC answered without a valid ${what}`)
  return BigInt(value)
}

function hexData(value: unknown, what: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new ShutterError(`the RPC answered without valid ${what}`)
  return value.toLowerCase() as `0x${string}`
}

/** One ABI `bytes` return value. */
function abiBytes(result: `0x${string}`): Uint8Array {
  const b = bytesOf(result, 'answer')
  if (b.length < 64) throw new ShutterError('unexpected contract answer')
  const offset = safeInt(BigInt(toHex(b.subarray(0, 32))), 'contract answer')
  if (offset + 32 > b.length) throw new ShutterError('unexpected contract answer')
  const len = safeInt(BigInt(toHex(b.subarray(offset, offset + 32))), 'contract answer')
  if (offset + 32 + len > b.length) throw new ShutterError('unexpected contract answer')
  return b.slice(offset + 32, offset + 32 + len)
}

/** Calldata of `submitEncryptedTransaction(eon, identityPrefix, encryptedTransaction, gasLimit)`. */
export function submitEncryptedCalldata(input: { eon: number | bigint; identityPrefix: BytesLike; ciphertext: BytesLike; gasLimit: bigint }): `0x${string}` {
  const prefix = bytesOf(input.identityPrefix, 'identity prefix')
  if (prefix.length !== 32) throw new ShutterCryptoError('identity prefix must be 32 bytes')
  const ct = bytesOf(input.ciphertext, 'ciphertext')
  const padded = toHex(concatBytes(ct, new Uint8Array((32 - (ct.length % 32)) % 32))).slice(2)
  return `0x${SUBMIT_SELECTOR}${word(BigInt(input.eon))}${toHex(prefix).slice(2)}${word(128n)}${word(input.gasLimit)}${word(BigInt(ct.length))}${padded}`
}

/** The identity preimage the keypers release a key for: identityPrefix ‖ the submitting account (52 bytes). */
export function mempoolIdentity(identityPrefix: BytesLike, sender: string): Uint8Array {
  const prefix = bytesOf(identityPrefix, 'identity prefix')
  if (prefix.length !== 32) throw new ShutterCryptoError('identity prefix must be 32 bytes')
  return concatBytes(prefix, bytesOf(address(sender, 'sender'), 'sender'))
}

/** Encrypt a signed transaction for the mempool. Pure: no network. */
export function encryptTransaction(input: { signedTransaction: BytesLike; sender: string; eonKey: BytesLike; identityPrefix?: BytesLike | undefined }): { identityPrefix: `0x${string}`; ciphertext: `0x${string}` } {
  const identityPrefix = input.identityPrefix === undefined ? randomHex32() : toHex(bytesOf(input.identityPrefix, 'identity prefix'))
  const ciphertext = toHex(encrypt({ message: bytesOf(input.signedTransaction, 'signed transaction'), identity: mempoolIdentity(identityPrefix, input.sender), eonKey: input.eonKey }))
  return { identityPrefix, ciphertext }
}

async function call(rpc: ShutterRpc, to: string, data: string): Promise<`0x${string}`> {
  return hexData(await rpc.request({ method: 'eth_call', params: [{ to, data }, 'latest'] }), 'call result')
}

/** The eon serving `blockNumber` and its public key, read from the keypers' contracts. */
export async function readEonKey(rpc: ShutterRpc, network: ShutterMempoolNetwork, blockNumber: bigint): Promise<{ eon: number; eonKey: `0x${string}` }> {
  const eonWord = await call(rpc, network.keyperSetManager, `0x${GET_EON_SELECTOR}${word(blockNumber)}`)
  if (eonWord.length !== 66) throw new ShutterError('no active Shutter keyper set (getKeyperSetIndexByBlock)')
  const eon = BigInt(eonWord)
  const key = abiBytes(await call(rpc, network.keyBroadcast, `0x${GET_EON_KEY_SELECTOR}${word(eon)}`))
  if (key.length === 0) throw new ShutterError(`the keypers have not published the key of eon ${eon} yet`)
  if (key.length !== 96) throw new ShutterCryptoError(`eon ${eon} key has an unexpected length (${key.length} bytes)`)
  return { eon: safeInt(eon, 'eon'), eonKey: toHex(key) }
}

/** Read back what the account signed and check it is exactly what was asked. */
function checkSigned(raw: string, want: ShutterSignRequest, what: string): `0x${string}` {
  const bytes = bytesOf(raw, what)
  if (bytes[0] !== 0x02) throw new ShutterError(`${what}: the account did not sign an EIP-1559 transaction`)
  const f = rlpDecode(bytes.subarray(1))
  if (!Array.isArray(f) || f.length !== 12) throw new ShutterError(`${what}: not a signed EIP-1559 transaction`)
  const to = f[5]
  const data = f[7]
  if (!(to instanceof Uint8Array) || !(data instanceof Uint8Array)) throw new ShutterError(`${what}: not a signed EIP-1559 transaction`)
  const same = rlpUint(f[0]) === BigInt(want.chainId) && rlpUint(f[1]) === BigInt(want.nonce) && rlpUint(f[2]) === want.maxPriorityFeePerGas
    && rlpUint(f[3]) === want.maxFeePerGas && rlpUint(f[4]) === want.gasLimit && toHex(to) === want.to.toLowerCase()
    && rlpUint(f[6]) === want.value && toHex(data) === want.data.toLowerCase()
  if (!same) throw new ShutterError(`${what}: the account signed something other than what it was asked to sign`)
  return toHex(keccak_256(bytes))
}

/**
 * Sign the transaction, encrypt it on the device and submit the ciphertext to the Sequencer. Returns once the
 * submission is broadcast; {@link waitForEncryptedTransaction} follows it to the block. Refuses (before signing
 * anything) a wrong chain, a decommissioned network, a gas limit over the per-block encrypted gas, or a balance that
 * cannot pay both transactions. The eon key comes from `rpc`: use an RPC you trust.
 */
export async function sendEncryptedTransaction(input: SendEncryptedInput): Promise<EncryptedSend> {
  const network = input.network ?? SHUTTER_GNOSIS_MEMPOOL
  const { rpc, account } = input
  if (network.sunsetAt !== undefined && Date.now() / 1000 >= network.sunsetAt) throw new ShutterError(`the Shutter encrypted mempool on ${network.name} is shut down`)
  const from = address(account.address, 'account address')
  const to = address(input.tx.to, 'recipient')
  const data = input.tx.data === undefined ? '0x' : hexData(input.tx.data, 'calldata')
  const value = input.tx.value ?? 0n
  if (value < 0n) throw new ShutterError('value must not be negative')

  const chainId = quantity(await rpc.request({ method: 'eth_chainId' }), 'chain id')
  if (chainId !== BigInt(network.chainId)) throw new ShutterError(`the RPC is on chain ${chainId}, not ${network.name} (${network.chainId})`)
  const block = (await rpc.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })) as Record<string, unknown> | null
  if (!block) throw new ShutterError('the RPC answered without the latest block')
  const blockNumber = quantity(block.number, 'block number')
  const baseFee = quantity(block.baseFeePerGas, 'base fee')
  const suggestedTip = quantity(await rpc.request({ method: 'eth_maxPriorityFeePerGas' }), 'priority fee')
  const maxPriorityFeePerGas = input.maxPriorityFeePerGas ?? (suggestedTip > GWEI ? suggestedTip : GWEI)
  const maxFeePerGas = input.maxFeePerGas ?? baseFee * 2n + maxPriorityFeePerGas
  if (maxFeePerGas < baseFee || maxFeePerGas < maxPriorityFeePerGas) throw new ShutterError('maxFeePerGas is below the base fee or the tip')

  let gasLimit = input.tx.gasLimit
  if (gasLimit === undefined) {
    const est = quantity(await rpc.request({ method: 'eth_estimateGas', params: [{ from, to, data, value: `0x${value.toString(16)}` }] }), 'gas estimate')
    gasLimit = (est * 12n + 9n) / 10n
  }
  if (gasLimit < 21_000n) throw new ShutterError('gasLimit is below 21000')
  if (gasLimit > network.maxEncryptedGas) throw new ShutterError(`gasLimit ${gasLimit} is over the ${network.maxEncryptedGas} gas set aside per block for encrypted transactions: it could never be included`)

  const { eon, eonKey } = await readEonKey(rpc, network, blockNumber + BigInt(network.eonLookahead))
  const nonceN = quantity(await rpc.request({ method: 'eth_getTransactionCount', params: [from, 'pending'] }), 'nonce')
  if (nonceN + 1n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ShutterError('unexpected nonce')
  const submitNonce = safeInt(nonceN, 'nonce')

  const inner: ShutterSignRequest = { type: 2, chainId: network.chainId, nonce: submitNonce + 1, to, value, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas }
  const encryptedGasFee = gasLimit * maxFeePerGas
  // The ciphertext length depends only on the signed transaction's length; estimate the submission with a stand-in.
  const placeholder = submitEncryptedCalldata({ eon, identityPrefix: `0x${'11'.repeat(32)}`, ciphertext: new Uint8Array(1 + 96 + 32 + Math.ceil((data.length / 2 + 160) / 32) * 32), gasLimit })
  const submitEst = quantity(await rpc.request({ method: 'eth_estimateGas', params: [{ from, to: network.sequencer, data: placeholder, value: `0x${encryptedGasFee.toString(16)}` }] }), 'gas estimate')
  const submitGas = (submitEst * 13n + 9n) / 10n

  const balance = quantity(await rpc.request({ method: 'eth_getBalance', params: [from, 'pending'] }), 'balance')
  const need = submitGas * maxFeePerGas + encryptedGasFee + gasLimit * maxFeePerGas + value
  if (balance < need) throw new ShutterError(`insufficient balance for an encrypted send: need ${need} wei (submission gas, encrypted-gas fee, the transaction's own gas and value), have ${balance}`)

  const signedInner = await account.signTransaction(inner)
  const transactionHash = checkSigned(signedInner, inner, 'encrypted transaction')
  const { identityPrefix, ciphertext } = encryptTransaction({ signedTransaction: signedInner, sender: from, eonKey })
  const submit: ShutterSignRequest = {
    type: 2, chainId: network.chainId, nonce: submitNonce, to: network.sequencer.toLowerCase(), value: encryptedGasFee,
    data: submitEncryptedCalldata({ eon, identityPrefix, ciphertext, gasLimit }), gasLimit: submitGas, maxFeePerGas, maxPriorityFeePerGas,
  }
  const signedSubmit = await account.signTransaction(submit)
  const submissionHash = checkSigned(signedSubmit, submit, 'submission')
  await rpc.request({ method: 'eth_sendRawTransaction', params: [signedSubmit] })

  return {
    network: network.name, chainId: network.chainId, from, transactionHash, nonce: submitNonce + 1, submissionHash, eon, identityPrefix,
    gasLimit, encryptedGasFee, submittedAtBlock: safeInt(blockNumber, 'block number'),
  }
}

export type EncryptedSendStatus =
  | { readonly status: 'included'; readonly blockNumber: number; readonly success: boolean; readonly blocksAfterSubmission: number }
  /** The submission reverted: nothing was queued (the nonce after it is free again). */
  | { readonly status: 'submission-failed'; readonly blockNumber: number }
  /** Another transaction took the nonce: the encrypted one can no longer run. */
  | { readonly status: 'replaced' }
  /** Not in a block yet. Send a transaction with the same nonce to cancel it (or to send it publicly). */
  | { readonly status: 'pending'; readonly submissionMined: boolean }

/** One look at where an encrypted send is. */
export async function getEncryptedSendStatus(rpc: ShutterRpc, sent: EncryptedSend): Promise<EncryptedSendStatus> {
  const receipt = (await rpc.request({ method: 'eth_getTransactionReceipt', params: [sent.transactionHash] })) as Record<string, unknown> | null
  if (receipt) {
    const blockNumber = safeInt(quantity(receipt.blockNumber, 'block number'), 'block number')
    return { status: 'included', blockNumber, success: receipt.status === '0x1', blocksAfterSubmission: blockNumber - sent.submittedAtBlock }
  }
  const submission = (await rpc.request({ method: 'eth_getTransactionReceipt', params: [sent.submissionHash] })) as Record<string, unknown> | null
  if (submission && submission.status !== '0x1') return { status: 'submission-failed', blockNumber: safeInt(quantity(submission.blockNumber, 'block number'), 'block number') }
  const nonce = quantity(await rpc.request({ method: 'eth_getTransactionCount', params: [sent.from, 'latest'] }), 'nonce')
  if (nonce > BigInt(sent.nonce)) {
    // The nonce is used; re-check the receipt once (it may have landed between the two reads).
    const again = await rpc.request({ method: 'eth_getTransactionReceipt', params: [sent.transactionHash] })
    if (again) return getEncryptedSendStatus(rpc, sent)
    return { status: 'replaced' }
  }
  return { status: 'pending', submissionMined: !!submission }
}

/**
 * Poll until the encrypted transaction is in a block, the submission failed, or the nonce was taken by another
 * transaction; `pending` after `timeoutMs` (default 10 minutes: only blocks of Shutter validators decrypt).
 */
export async function waitForEncryptedTransaction(rpc: ShutterRpc, sent: EncryptedSend, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<EncryptedSendStatus> {
  const until = Date.now() + Math.min(options.timeoutMs ?? 600_000, 2 ** 31 - 1)
  const pollMs = Math.min(Math.max(options.pollMs ?? 5_000, 500), 60_000)
  for (;;) {
    const s = await getEncryptedSendStatus(rpc, sent)
    if (s.status !== 'pending' || Date.now() + pollMs > until) return s
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
