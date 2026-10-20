'use strict'

/**
 * Live check against a real chain (build first: `pnpm build`, the script imports dist/):
 *
 *   node scripts/verify-live.mjs <address> [rpc] [--chain 1] [--from <block>] [--range 10000] [--include-zero]
 *   LIVE_PK=0x… node scripts/verify-live.mjs <address> [rpc] --revoke <approval id>
 *
 * Discovery runs on a read-only account (address + provider). With
 * `--revoke` and LIVE_PK the script sends the real revoke through a viem
 * local account shaped like a wallet account and waits for the receipt.
 */
import { createPublicClient, createWalletClient, formatUnits, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import ApprovalsProtocolEvm from '../dist/index.js'

const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2)
    if (key === 'include-zero') flags[key] = true
    else flags[key] = argv[++i]
  } else positional.push(argv[i])
}
const address = positional[0]
if (!address) {
  console.error('usage: node scripts/verify-live.mjs <address> [rpc] [--chain 1] [--from <block>] [--range 10000] [--include-zero] [--revoke <id>]')
  process.exit(2)
}
const rpc = positional[1] ?? process.env.LIVE_RPC ?? 'https://ethereum-rpc.publicnode.com'
const chainId = flags.chain ? Number(flags.chain) : undefined
const fromBlock = flags.from ? Number(flags.from) : undefined
const blockRange = flags.range ? Number(flags.range) : null

const readOnly = { async getAddress () { return address } }
const started = Date.now()
const view = new ApprovalsProtocolEvm(readOnly, { provider: rpc, chainId, fromBlock, blockRange })
const { approvals, coverage } = await view.getApprovals({ includeZero: flags['include-zero'] === true })
const source = view._source
console.log(`chain ${coverage.source} scan ${coverage.fromBlock} → ${coverage.toBlock} in ${((Date.now() - started) / 1000).toFixed(1)}s, ${source?.requests ?? '?'} eth_getLogs, complete=${coverage.complete}${coverage.gaps?.length ? ` gaps=${JSON.stringify(coverage.gaps)}` : ''}`)
console.log(`${approvals.length} approval(s) for ${address}:`)
for (const a of approvals) {
  const amount = a.amount === null ? (a.standard === 'eip7702' ? 'delegated' : 'all') : a.unlimited ? 'UNLIMITED' : formatUnits(a.amount, 0)
  const extra = [a.tokenId !== undefined ? `#${a.tokenId}` : '', a.expiration ? `exp ${new Date(a.expiration * 1000).toISOString().slice(0, 10)}` : '', a.grantedAt?.block ? `@${a.grantedAt.block}` : ''].filter(Boolean).join(' ')
  console.log(`  ${a.standard.padEnd(12)} ${a.token} → ${a.spender}  ${amount} ${extra}  ${a.risks.length ? '⚠ ' + a.risks.join(',') : ''}\n    id ${a.id}`)
}

if (flags.revoke) {
  const pk = process.env.LIVE_PK
  if (!pk) throw new Error('--revoke needs LIVE_PK')
  const target = approvals.find((a) => a.id === flags.revoke)
  if (!target) throw new Error(`approval ${flags.revoke} not in the list above`)
  const publicClient = createPublicClient({ transport: http(rpc) })
  const signer = privateKeyToAccount(pk)
  const wallet = createWalletClient({ account: signer, transport: http(rpc) })
  if (signer.address.toLowerCase() !== address.toLowerCase()) throw new Error(`LIVE_PK is ${signer.address}, not ${address}`)
  // A wallet-shaped account over a viem local account: the same three methods a module calls.
  const account = {
    async getAddress () { return signer.address },
    async quoteSendTransaction (tx) {
      const [gas, fees] = await Promise.all([publicClient.estimateGas({ ...tx, account: signer.address }), publicClient.estimateFeesPerGas()])
      return { fee: gas * (fees.maxFeePerGas ?? fees.gasPrice) }
    },
    async sendTransaction (tx) {
      const hash = await wallet.sendTransaction({ ...tx, chain: null })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`)
      return { hash, fee: receipt.gasUsed * receipt.effectiveGasPrice }
    }
  }
  const protocol = new ApprovalsProtocolEvm(account, { provider: rpc, chainId })
  const quote = await protocol.quoteRevoke(target)
  console.log(`revoking ${target.id} (quoted ${formatUnits(quote.fee, 18)} ETH)…`)
  const res = await protocol.revoke(target)
  console.log(`revoked: ${res.hash} fee ${formatUnits(res.fee, 18)} ETH`)
  const after = await new ApprovalsProtocolEvm(readOnly, { provider: rpc, chainId, fromBlock: coverage.toBlock }).getApprovals({ spenders: [target.spender], tokens: [target.token] })
  const still = after.approvals.find((a) => a.id === target.id)
  console.log(still ? `STILL PRESENT after revoke: ${JSON.stringify(still)}` : 'gone after revoke ✓')
  if (still) process.exit(1)
}
