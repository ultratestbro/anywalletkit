# LayerZero Value Transfer API (private, in development)

Work for [SDK-330](https://megabunny.xyz/b/SDK/t/330) and
[SDK-331](https://megabunny.xyz/b/SDK/t/331). This package provides public discovery
and a separate server-only transport for requesting quotes and status evidence.
It does not yet provide an executable swap2 provider, wallet steps or signature submission.
Direct Stargate Taxi/Bus is implemented separately in `protocol-swap2-stargate`.

```ts
import {createLayerZeroDiscovery} from '@anywalletkit/protocol-swap2-layerzero'

const api = createLayerZeroDiscovery()
const chains = await api.chains()
const destinations = await api.tokens({from: {
  chainKey: 'base', tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
}})
// Each result has items and an optional nextToken; request subsequent pages explicitly.
const metadata = await api.metadata()
```

The public catalogs are discovery hints. `isSupported` does not mean this SDK can
execute a route. Deployment metadata is not an approval allowlist: LZMultiCall is
never a token spender. Unknown chain types remain catalog data; chain IDs from
different VM families are not interchangeable. Prices and logos are omitted from
the normalized catalog. Token identity uses chain key and address, not symbol.

On a Node backend only:

```ts
import {createLayerZeroServerApi} from '@anywalletkit/protocol-swap2-layerzero/server'

const api = createLayerZeroServerApi({apiKey: serverSecret})
const evidence = await api.requestQuotes({
  srcChainKey: 'base', dstChainKey: 'arbitrum',
  srcTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  dstTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  srcWalletAddress: sender, dstWalletAddress: recipient, amount: 10_000_000n,
})
```

Never bundle `serverSecret` or the server entry point into an app. Construction is
refused outside Node and when `window` exists. The public entry point accepts no key.
The quote transport preserves integer base units and returns `UnverifiedLayerZeroQuotes`:
the envelope is checked, but nested quotes/steps remain `unknown`. This is an evidence
collector, not an execution validator. Do not sign or broadcast its output directly.
API status likewise does not independently prove a destination payout.

Transport uses HTTPS, refuses redirects, redacts upstream errors and applies a total
deadline including retry waits. Only GET requests retry 429/503 with bounded
Retry-After handling; POST requests never retry automatically. Requests support
AbortSignal. The default timeout is 20 seconds and the default GET retry count is two.
An explicit HTTPS `baseUrl` may point to an application-owned proxy; it must not
contain credentials, query parameters or a fragment.

## Evidence and checks

`tests/fixtures/public.json` records live, unauthenticated HTTP 200 responses captured
on 2026-11-16: 96 chains, deployment metadata and 1,587 destinations returned for Base
USDC. It includes request URLs, timestamps and unmodified response bodies. The capture
script requests only these public endpoints, sends no signatures and reads no secrets.

```sh
pnpm --filter @anywalletkit/protocol-swap2-layerzero fixtures:public
pnpm --filter @anywalletkit/protocol-swap2-layerzero test
pnpm --filter @anywalletkit/protocol-swap2-layerzero typecheck
pnpm --filter @anywalletkit/protocol-swap2-layerzero build
```

Tests replay those public responses. Quote transport tests use explicitly synthetic
responses; there are no authenticated quote/status fixtures yet. API access is required
to finish schema validation and route adapters. SDK-330 remains open. SDK-331 still needs
validated multicall/delegate calls, EIP-712 domains/signers, fresh Solana builds and
durable ordered step checkpoints before those routes can enter the router. Every other
VM or unknown step must be refused until its wallet operation has a reviewed validator.

References: [API authentication](https://docs.layerzero.network/v2/developers/value-transfer-api/api-reference/overview),
[chains](https://docs.layerzero.network/v2/developers/value-transfer-api/api-reference/chains),
[tokens](https://docs.layerzero.network/v2/developers/value-transfer-api/api-reference/tokens),
[metadata](https://docs.layerzero.network/v2/developers/value-transfer-api/api-reference/metadata),
[quote contract](https://docs.layerzero.network/v2/developers/value-transfer-api/api-reference/quotes),
[execution contracts](https://docs.layerzero.network/v2/developers/value-transfer-api/contracts/overview).
