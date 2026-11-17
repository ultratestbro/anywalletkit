#!/usr/bin/env node
// Live check against the Shutter API: seal a message for ~90 s ahead, try to open it early (must refuse), wait,
// open it (decryption key checked by pairing, decrypted on this machine), confirm the registration on chain.
//   node scripts/verify-live.mjs [gnosis|chiado] [--self] [--seconds 90]
// --self registers from your own account: SHUTTER_ENV_FILE=<file with TEST_WALLET_MNEMONIC=…> and an RPC for the
// chain (GNOSIS_RPC_URL / CHIADO_RPC_URL, default the public ones). Mainnet without an API key allows 5
// registrations per day per IP. Results are appended to tests/fixtures/live-<network>.json.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { ShutterApi, seal, openText, readRegistration, ShutterNotYetRevealedError, SHUTTER_NETWORKS } from '../dist/index.js'

const args = process.argv.slice(2)
const name = args.find((a) => !a.startsWith('--') && SHUTTER_NETWORKS[a]) ?? 'gnosis'
const self = args.includes('--self')
const seconds = Number(args[args.indexOf('--seconds') + 1]) || 90
const network = SHUTTER_NETWORKS[name]
const rpcUrl = (name === 'gnosis' ? process.env.GNOSIS_RPC_URL : process.env.CHIADO_RPC_URL) ?? (name === 'gnosis' ? 'https://rpc.gnosischain.com' : 'https://rpc.chiadochain.net')
const rpc = async (method, params) => {
  const r = await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  if (r.error) throw new Error(`${method}: ${r.error.message}`)
  return r.result
}
const api = new ShutterApi({ network, apiKey: process.env.SHUTTER_API_KEY })

let registrant
if (self) {
  const file = process.env.SHUTTER_ENV_FILE
  if (!file) throw new Error('--self needs SHUTTER_ENV_FILE')
  const mnemonic = readFileSync(file, 'utf8').match(/^TEST_WALLET_MNEMONIC=["']?([^"'\n]+)/m)?.[1]
  if (!mnemonic) throw new Error('TEST_WALLET_MNEMONIC not found')
  const { mnemonicToAccount } = await import('viem/accounts')
  const { createWalletClient, http, defineChain } = await import('viem')
  const account = mnemonicToAccount(mnemonic)
  const chain = defineChain({ id: network.chainId, name, nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
  registrant = { address: account.address, sendTransaction: async (tx) => ({ hash: await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value }) }) }
  console.log(`self-registering from ${account.address} (balance ${BigInt(await rpc('eth_getBalance', [account.address, 'latest']))} wei)`)
}

const revealAt = Math.floor(Date.now() / 1000) + seconds
const text = `AnyWalletKit sealed note · ${name} · ${new Date().toISOString()}`
const t0 = Date.now()
const sealed = await seal({ api, message: text, revealAt, registrant })
console.log(`sealed: identity ${sealed.identity}, registration ${sealed.registration.by} ${sealed.registration.txHash}, ciphertext ${(sealed.ciphertext.length - 2) / 2} bytes, ${Date.now() - t0} ms`)

try { await openText(sealed, api); throw new Error('opened before its time') } catch (e) { if (!(e instanceof ShutterNotYetRevealedError)) throw e; console.log('early open refused:', e.message) }

let receipt
for (let i = 0; i < 40 && !receipt; i++) { receipt = await rpc('eth_getTransactionReceipt', [sealed.registration.txHash]); if (!receipt) await new Promise((r) => setTimeout(r, 3000)) }
if (!receipt || receipt.status !== '0x1') throw new Error(`registration ${sealed.registration.txHash} not confirmed: ${JSON.stringify(receipt)}`)
const onChain = await readRegistration((to, data) => rpc('eth_call', [{ to, data }, 'latest']), api, sealed.identity)
console.log(`registration mined in block ${BigInt(receipt.blockNumber)}; registry says eon ${onChain?.eon}, revealAt ${onChain?.revealAt}`)
if (!onChain || onChain.revealAt !== BigInt(revealAt)) throw new Error('the registry does not hold this registration')

await new Promise((r) => setTimeout(r, Math.max(0, revealAt * 1000 - Date.now())))
let opened, tries = 0
const tOpen = Date.now()
while (opened === undefined) {
  try { opened = await openText(sealed, api) } catch (e) { if (!(e instanceof ShutterNotYetRevealedError) || ++tries > 40) throw e; await new Promise((r) => setTimeout(r, 5000)) }
}
const lag = Math.round((Date.now() - revealAt * 1000) / 1000)
if (opened !== text) throw new Error('decrypted text differs')
console.log(`opened ${lag} s after the reveal time (${Date.now() - tOpen} ms of polling): "${opened}"`)

const out = new URL(`../tests/fixtures/live-${name}.json`, import.meta.url)
mkdirSync(new URL('../tests/fixtures/', import.meta.url), { recursive: true })
const runs = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []
runs.push({ at: new Date().toISOString(), network: name, registration: sealed.registration, registrant: sealed.registrant, identity: sealed.identity, eon: sealed.eon, revealAt, block: Number(BigInt(receipt.blockNumber)), openedSecondsAfterReveal: lag, sealed })
writeFileSync(out, JSON.stringify(runs, null, 2) + '\n')
console.log(`saved → tests/fixtures/live-${name}.json`)
