#!/usr/bin/env node
// Calls every builtin endpoint for real (identity + tip + latency). Not part of `pnpm test`.
//   node scripts/verify-live.mjs [caip2 …]
import { BUILTIN_NETWORKS, verifyRpcs } from '../dist/index.js'

const only = process.argv.slice(2)
let bad = 0
for (const n of BUILTIN_NETWORKS) {
  if (only.length && !only.includes(n.caip2)) continue
  if (n.rpcs.length === 0) { console.log(`${n.caip2.padEnd(44)} ${n.name.padEnd(18)} (no default endpoint)`); continue }
  const results = await verifyRpcs(n, { timeoutMs: 15_000 })
  for (const { rpc, result } of results) {
    if (!result.ok) bad++
    console.log(`${n.caip2.padEnd(44)} ${n.name.padEnd(18)} ${result.ok ? 'ok  ' : 'FAIL'} ${String(result.latencyMs).padStart(5)} ms ${result.tip !== undefined ? `tip ${result.tip}` : ''} ${rpc}${result.error ? `  — ${result.error}` : ''}`)
  }
}
console.log(bad ? `${bad} endpoint(s) failed` : 'all endpoints ok')
process.exit(bad ? 1 : 0)
