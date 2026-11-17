#!/usr/bin/env node
// Live check of the encrypted mempool on Gnosis: sign a small xDAI transfer to yourself, encrypt it on this machine,
// submit the ciphertext to the Sequencer, wait until a Shutter validator decrypts it into a block, and check that the
// mempool never saw it in the clear (it lands at the transaction's own hash, never broadcast by us).
//   SHUTTER_ENV_FILE=<file with TEST_WALLET_MNEMONIC=…> node scripts/send-encrypted-live.mjs [--wei 1000000000000000]
// Any other transaction (a swap from an aggregator, say): --to <address> --data-file <file with 0x calldata> --wei <value> --label <name>.
// --wait-min <minutes> (default 30): how long to follow it; only Shutter validators' blocks decrypt.
// GNOSIS_RPC_URL overrides the public RPC. Results are appended to tests/fixtures/live-mempool-gnosis.json.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { sendEncryptedTransaction, waitForEncryptedTransaction, SHUTTER_GNOSIS_MEMPOOL } from '../dist/index.js'

const args = process.argv.slice(2)
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const wei = BigInt(arg('--wei') ?? '1000000000000000')
const label = arg('--label') ?? 'self-transfer'
const data = arg('--data-file') ? readFileSync(arg('--data-file'), 'utf8').trim() : undefined
const rpcUrl = process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com'
let id = 0
const rpc = {
  // A long wait outlives blips of a public RPC: retry reads a few times (never the broadcast).
  async request({ method, params = [] }) {
    for (let i = 0; ; i++) {
      try {
        const r = await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json()
        if (r.error) throw new Error(`${method}: ${r.error.message}`)
        return r.result
      } catch (e) {
        if (method === 'eth_sendRawTransaction' || i >= 10) throw e
        await new Promise((r) => setTimeout(r, 10_000))
      }
    }
  },
}

const file = process.env.SHUTTER_ENV_FILE
if (!file) throw new Error('needs SHUTTER_ENV_FILE')
const mnemonic = readFileSync(file, 'utf8').match(/^TEST_WALLET_MNEMONIC=["']?([^"'\n]+)/m)?.[1]
if (!mnemonic) throw new Error('TEST_WALLET_MNEMONIC not found')
const { mnemonicToAccount } = await import('viem/accounts')
const signer = mnemonicToAccount(mnemonic)
const account = {
  address: signer.address,
  signTransaction: (tx) => signer.signTransaction({ type: 'eip1559', chainId: tx.chainId, nonce: tx.nonce, to: tx.to, value: tx.value, data: tx.data, gas: tx.gasLimit, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }),
}
const balance = BigInt(await rpc.request({ method: 'eth_getBalance', params: [signer.address, 'latest'] }))
console.log(`from ${signer.address}, balance ${balance} wei`)

const t0 = Date.now()
const sent = await sendEncryptedTransaction({ rpc, account, tx: { to: arg('--to') ?? signer.address, value: wei, data } })
console.log(`submitted: ciphertext in ${sent.submissionHash} (eon ${sent.eon}, nonce ${sent.nonce - 1}); encrypted tx ${sent.transactionHash} (nonce ${sent.nonce}, gas ${sent.gasLimit}, fee ${sent.encryptedGasFee} wei), ${Date.now() - t0} ms`)

// While it waits, nobody may know it: the hash must not be in the public mempool.
const seen = await rpc.request({ method: 'eth_getTransactionByHash', params: [sent.transactionHash] })
console.log(seen ? 'WARNING: the transaction is visible before inclusion' : 'not visible before inclusion: ok')

const status = await waitForEncryptedTransaction(rpc, sent, { timeoutMs: Number(arg('--wait-min') ?? 30) * 60_000, pollMs: Number(arg('--wait-min') ?? 30) > 30 ? 30_000 : 5_000 })
const seconds = Math.round((Date.now() - t0) / 1000)
console.log(`status after ${seconds} s:`, status)
let position
if (status.status === 'included') {
  const tx = await rpc.request({ method: 'eth_getTransactionByHash', params: [sent.transactionHash] })
  position = Number(tx.transactionIndex)
  console.log(`decrypted into block ${status.blockNumber}, position ${position}, ${status.blocksAfterSubmission} blocks after the submission`)
}

const out = new URL('../tests/fixtures/live-mempool-gnosis.json', import.meta.url)
mkdirSync(new URL('.', out), { recursive: true })
const runs = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []
runs.push({
  at: new Date(t0).toISOString(), label, from: sent.from, eon: sent.eon, submissionHash: sent.submissionHash, transactionHash: sent.transactionHash, nonce: sent.nonce,
  gasLimit: String(sent.gasLimit), encryptedGasFee: String(sent.encryptedGasFee), submittedAtBlock: sent.submittedAtBlock, visibleBeforeInclusion: !!seen,
  status: status.status, ...(status.status === 'included' ? { blockNumber: status.blockNumber, position, blocksAfterSubmission: status.blocksAfterSubmission, success: status.success } : {}), seconds,
  sequencer: SHUTTER_GNOSIS_MEMPOOL.sequencer,
})
writeFileSync(out, JSON.stringify(runs, null, 2) + '\n')
if (status.status !== 'included' || !status.success) process.exit(1)
