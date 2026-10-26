# @anywalletkit/tokens

[![npm](https://img.shields.io/npm/v/@anywalletkit/tokens?label=npm)](https://www.npmjs.com/package/@anywalletkit/tokens)

Tokens users add themselves, by address and at their own risk: read the token from the chain, warn about what matters before it is saved, keep the list, and swap it through the engines that accept tokens outside the catalog. EVM contracts and Solana mints (Token-2022 included).

## Install

```sh
npm install @anywalletkit/tokens
# or: pnpm add @anywalletkit/tokens  ·  yarn add @anywalletkit/tokens
```

On npm: [@anywalletkit/tokens](https://www.npmjs.com/package/@anywalletkit/tokens), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

Pure TypeScript; depends on `@anywalletkit/swap2-assets` (the catalog it checks against) and takes `@anywalletkit/core` types. Runs under Hermes.

```ts
import { inspectToken, TokensTable, swapSource } from '@anywalletkit/tokens'

const found = await inspectToken(account, '0x6982508145454Ce325dDbE47a25d4ec3d2311933') // an EVM or Solana account
if (found.listed) {
  // already in the catalog: nothing to add
} else {
  found.assessment // { level: 'caution' | 'danger', risks: [{ code, level, message }] } — show before saving
  const tokens = new TokensTable(myJsonStorage)      // AsyncStorage / chrome.storage / memoryJsonStorage()
  await tokens.load()
  await tokens.add(found.token)                      // after the user accepted the warnings
}

// Swap a user token: the engine must opt in
const swaps = new RouterSwap2Protocol(account, { fromChain: 'eip155:1', providers, allowUnlistedTokens: true })
await swaps.quoteSwap2Routes({ ...swapSource(token), toToken: 'USDC', fromTokenAmount })
```

## What it checks

`inspectToken` calls the account's `getTokenInfo(address)` (`wallet-evm`, `wallet-solana`): decimals, symbol, name, supply and holder-relevant flags. A wallet, an NFT or a plain contract throws `NotATokenError`. `assessToken(info, chain)` then lists every warning, worst first:

- **danger**: `impersonation` (the symbol reads as a catalog token of the same chain, or as a native coin or major stablecoin anywhere, after folding Cyrillic / Greek look-alikes, `$` → S, `₮` → T, fullwidth and invisible characters), `permanent-delegate`, `transfer-hook`, `non-transferable`;
- **caution**: `unlisted` (always), `upgradeable`, `mint-authority`, `freeze-authority`, `transfer-fee`, `default-frozen`, `pausable`, `odd-characters`, `no-symbol`, `zero-supply`, `unusual-decimals`.

A user token's symbol and name are what the token says about itself: display them next to the address, never identify the token by them.

## TokensTable

One JSON value in the app's storage. `load()` once (a failed read throws and leaves the table unloaded instead of empty), then `list(chain?)` / `get(chain, address)` synchronously; `add` / `remove` queue behind each other and a failed save leaves memory as stored. Catalog tokens, malformed entries and more than `maxTokens` (200) are refused; stored entries that do not validate are dropped on load. Solana is keyed by the catalog's `solana:mainnet`, whichever id the account reports.

## Testing

- `pnpm test`: assessment rules (look-alikes, flags, levels), the table (persistence, refusals, failed reads and saves), `inspectToken`.
- `pnpm verify:live`: mainnet reads (PEPE, USDC, MKR, an NFT, BONK, JUP, a wallet) and quotes of tokens outside the catalog through the real router and providers — PEPE ⇄ USDC on Ethereum, PEPE → USDC on Base, BONK ⇄ USDC on Solana — refused without `allowUnlistedTokens`. Nothing is signed.

Apache-2.0
