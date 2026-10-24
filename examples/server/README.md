# Reference wallet server

A small backend for a wallet built on Any Wallet Kit, on `node:http` with no framework:

- `POST /swap2/:action` — swap and bridge providers run here through
  [`createSwap2Handler`](https://docs.anywallet.tech/build-a-wallet/your-server/) from
  `@anywalletkit/protocol-swap2-core/server`; the app reaches them with `remoteProvider`.
  Quotes are sealed (HMAC), so the server builds a deposit only for terms a provider really quoted.
- `POST /rpc/:caip2` — a JSON-RPC proxy that adds your keyed upstream, with failover. Only the
  methods a wallet needs pass; signing and node-admin methods are refused.
- `GET /health`.

The docs page [Ship a wallet](https://docs.anywallet.tech/build-a-wallet/ship-a-wallet/) walks
through the app and this server end to end. CI runs `test/server.test.ts` against it.

## Run

```sh
cp .env.example .env            # fill in SEAL_SECRET, API_TOKEN and your RPC URLs
set -a; . ./.env; set +a
pnpm start                      # node --experimental-strip-types src/main.ts (Node ≥ 22.6)
```

## Deploy

Any Node host works (Fly.io, Railway, Render, a VM): `node --experimental-strip-types src/main.ts`
with the environment above. On Vercel or another serverless platform, call `createSwap2Handler`
and `createRpcProxy` from your route handlers instead of `createServer`: both are plain functions
of `(action, body, context)` / `(chain, rawBody)`.

## Before production

This is a reference, not a hardened service. Add:

- **User authentication.** The bearer token in this example is a stand-in: a token inside an app
  bundle is not a secret. Authenticate the user (Sign-In with Ethereum, your accounts) and, if you
  can, the app (App Attest, Play Integrity). `guard` is where it goes.
- **Rate limits in a shared store** (Redis, Upstash), per user, not in process memory. Keep the
  separate buckets: display quotes, live quotes, status polling, RPC.
- **Logs without bodies.** Requests carry addresses, quotes and signed transactions; log method,
  path, status and timing only. Never log `SEAL_SECRET`, `API_TOKEN` or RPC URLs.
- **Secrets in the host's secret store**, rotated; `SEAL_SECRET` rotation invalidates quotes in flight
  (they are minutes long).
- **Monitoring**: upstream error rates per chain, provider refusal rates, 429s.

Not here yet (SDK-38): notifications (address watching → push), a price cache, the Omniston
durable store for EVM → TON orders.
