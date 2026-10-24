// The "Ship a wallet" docs page renders the #region blocks of this file.
// Run: SEAL_SECRET=… API_TOKEN=… RPC_EIP155_1=https://… node --experimental-strip-types src/main.ts
import { lifiProvider } from '@anywalletkit/protocol-swap2-lifi/provider'
import { nearIntentsProvider } from '@anywalletkit/protocol-swap2-near-intents/provider'
import { thorchainProvider } from '@anywalletkit/protocol-swap2-thorchain/provider'
import { chainflipProvider } from '@anywalletkit/protocol-swap2-chainflip/provider'
import { createServer } from './server.ts'

// #region providers
/** The real providers, configured with the keys that must never ship in the app. */
export function providersFromEnv(env: NodeJS.ProcessEnv) {
  return [
    lifiProvider({ ...(env.LIFI_API_KEY ? { apiKey: env.LIFI_API_KEY } : {}) }),
    nearIntentsProvider({ ...(env.NEAR_INTENTS_JWT ? { jwt: env.NEAR_INTENTS_JWT } : {}) }),
    thorchainProvider({}),
    chainflipProvider(),
  ]
}

/** RPC_EIP155_1=https://a,https://b → { 'eip155:1': [a, b] }; RPC_SOLANA_MAINNET → 'solana:5eykt…'. */
export function upstreamsFromEnv(env: NodeJS.ProcessEnv): Record<string, string[]> {
  const ALIASES: Record<string, string> = { 'solana:mainnet': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(env)) {
    const m = /^RPC_([A-Z0-9]+)_([A-Z0-9]+)$/.exec(key)
    if (!m || !value) continue
    const chain = `${m[1]!.toLowerCase()}:${m[2]!.toLowerCase()}`
    out[ALIASES[chain] ?? chain] = value.split(',').map((u) => u.trim()).filter(Boolean)
  }
  return out
}
// #endregion providers

function required(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`${name} is required (see .env.example)`); process.exit(1) }
  return v
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer({
    providers: providersFromEnv(process.env),
    upstreams: upstreamsFromEnv(process.env),
    sealSecret: required('SEAL_SECRET'),
    apiToken: required('API_TOKEN'),
    ...(process.env.ALLOWED_ORIGIN ? { allowedOrigin: process.env.ALLOWED_ORIGIN } : {}),
  })
  const port = Number(process.env.PORT ?? 8787)
  server.listen(port, () => console.log(`wallet server on :${port} — /health, POST /swap2/:action, POST /rpc/:caip2`))
}
