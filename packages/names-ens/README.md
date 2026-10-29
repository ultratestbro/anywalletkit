# @anywalletkit/names-ens

[![npm](https://img.shields.io/npm/v/@anywalletkit/names-ens?label=npm)](https://www.npmjs.com/package/@anywalletkit/names-ens)

**ENS names for wallets built on Any Wallet Kit: `vitalik.eth`, `name.base.eth`, `alice.cb.id` → the address for one chain, verified primary names, avatars, and the warnings a user should see next to a name.**

## Install

```sh
npm install @anywalletkit/names-ens @anywalletkit/core
# or: pnpm add @anywalletkit/names-ens @anywalletkit/core  ·  yarn add @anywalletkit/names-ens @anywalletkit/core
```

On npm: [@anywalletkit/names-ens](https://www.npmjs.com/package/@anywalletkit/names-ens), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

Implements the `NameResolver` interface from `@anywalletkit/core`, so SNS (`.sol`), TON DNS (`.ton`) and NEAR accounts can sit behind the same `nameResolvers([...])` later.

## What it does

- **Normalization per ENSIP-15** (viem's `normalize`, i.e. `@adraffy/ens-normalize`). Invalid names and illegal script mixtures are refused with the reason as the message, before any I/O.
- **Forward resolution** through the Universal Resolver: wildcard names (ENSIP-10) and off-chain resolvers via CCIP-Read (`cb.id`, `uni.eth`, Basenames) work out of the box.
- **One chain per call (ENSIP-9/11).** `resolve(name, 'eip155:8453')` reads the Base record (coin type `0x80000000 | 8453`), `bip122:…` reads the Bitcoin script record, `solana:…` the Solana key. A name with no record for that chain is `no-address-for-chain`. **It never falls back to the Ethereum address** — sending vitalik's mainnet address to Base is the bug this guards against.
- **Reverse / primary name**, including L2 primary names (ENSIP-19) by coin type. A primary name counts only when it resolves forward to the same address.
- **Avatars** (ENSIP-12): https / ipfs / NFT, returned as a URL. Fetch it through your own proxy; the resolver never fetches the image.
- **Warnings** on every resolution: `confusable` (a label written in Cyrillic lookalikes of Latin letters), `mixed-script`, `punycode`.
- **Cache** with a TTL (default 5 min), bounded.
- **Signing-time check**: `assertNameUnchanged(resolver, name, chain, address)` re-resolves and throws `changed` if the address moved.

## Usage

```ts
import { ensResolver } from '@anywalletkit/names-ens'
import { assertNameUnchanged, isNameLike, NameError } from '@anywalletkit/core'

const ens = ensResolver({ rpcUrl: 'https://ethereum-rpc.publicnode.com' }) // or { client } (viem PublicClient on mainnet)

if (isNameLike(input) && ens.supports(input)) {
  try {
    const r = await ens.resolve(input, 'eip155:8453')
    // r.address (checksummed), r.name (normalized), r.warnings[] to show
  } catch (e) {
    if (e instanceof NameError) console.log(e.code) // invalid-name | not-found | no-address-for-chain | unsupported | lookup-failed
  }
}

await ens.reverse('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'eip155:1') // 'vitalik.eth'
await ens.avatar('vitalik.eth') // 'https://euc.li/vitalik.eth'

// right before signing:
await assertNameUnchanged(ens, 'vitalik.eth', 'eip155:1', addressShownToUser)
```

Options: `client` / `rpcUrl` (mainnet; required), `ccip` (how gateways are asked, below), `cacheTtlMs`, `ipfsGateway` (point it at your proxy), `foreignTlds` (TLDs left to other resolvers; default `sol`, `near`, `ton`, `me`).

Offchain names (CCIP-Read, EIP-3668) make the device fetch gateway URLs that the name's resolver chooses. The client built from `rpcUrl` asks only https gateways on public hosts (`ensCcipRead`: no `http://`, no localhost / LAN / link-local / CGNAT address in any spelling, redirects refused). **If you pass your own `client`, create it with `ccipRead: ensCcipRead`** (or `ccipRead: false`), or viem's default fetches whatever URL a resolver names, `http://192.168.1.1/…` included.

React Native's fetch follows redirects whatever `redirect: 'error'` says, so a gateway's redirect would send the device's request to a LAN or loopback host before the final URL can be checked. There, offchain names are off unless you pass `ccip: { fetch }` (a fetch that does not follow redirects, usually one that goes through your server; the https / public-host check still runs first) or `ccip: { allowRedirectFollowingFetch: true }` (direct lookups; a redirecting gateway can then make the device send one blind request to a host on the user's network). With your own client: `ccipRead: createEnsCcipRead({ … })`.

`avatar` returns the `avatar` text record when it is an https URL on a public host, or an `ipfs://` one through `ipfsGateway` (an origin, `/ipfs/<cid>` appended, or a prefix ending in `/ipfs/`; `avatarUrl(record, gateway)` is the same filter). Everything else comes back `null`: NFT avatars (`eip155:1/erc721:…`; resolving one means fetching the metadata URL its issuer chose), and `http://`, `data:`, `ipns://` and `ar://` ones. Nothing is fetched to decide.

## Tests

`pnpm test` — 15 unit tests over a stubbed client plus the conformance `namesSuite`. `pnpm verify:live` — mainnet via a public RPC: vitalik.eth forward / reverse / avatar, `jesse.base.eth` through CCIP-Read on the Base coin type, a name without a Base record, unregistered and invalid names.
