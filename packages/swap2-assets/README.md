# @anywalletkit/swap2-assets

[![npm](https://img.shields.io/npm/v/@anywalletkit/swap2-assets?label=npm)](https://www.npmjs.com/package/@anywalletkit/swap2-assets)

The cross-chain asset catalog the swap2 packages share: chains by CAIP-2 id, and per chain the native coin plus the major stables, each with decimals, contract (EVM / SPL / TRC-20 / jetton / NEP-141) and icon. It is not a general token list: every entry has been routed through a live provider.

## Install

```sh
npm install @anywalletkit/swap2-assets
# or: pnpm add @anywalletkit/swap2-assets  ·  yarn add @anywalletkit/swap2-assets
```

On npm: [@anywalletkit/swap2-assets](https://www.npmjs.com/package/@anywalletkit/swap2-assets), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

```ts
import { CC_SOURCE_CHAINS, ccChain, ccAsset, ccAssetByToken, displaySymbol } from '@anywalletkit/swap2-assets'

ccAsset('eip155:8453', 'USDC') // { symbol, assetId, decimals, contract, icon }
```

Tokens the catalog does not list (a user's own, named by address): `isTokenAddress(chain, ref)` accepts an EVM contract or a Solana mint, `unlistedAsset(chain, contract, decimals)` builds an `UnlistedAsset` whose symbol is the address itself, and `resolveAsset(chain, ref, { allowUnlisted, decimals })` always returns the catalog's entry first. `catalogChainId` maps ids accounts report (`solana:5eykt4…`) to the catalog's keys.

No dependencies — usable in an app, a server and a worker alike.


Apache-2.0
