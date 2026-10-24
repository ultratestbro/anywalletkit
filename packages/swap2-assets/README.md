# @anywalletkit/swap2-assets

The cross-chain asset catalog the swap2 packages share: chains by CAIP-2 id, and per chain the native coin plus the major stables, each with decimals, contract (EVM / SPL / TRC-20 / jetton / NEP-141) and icon. It is not a general token list: every entry has been routed through a live provider.

```ts
import { CC_SOURCE_CHAINS, ccChain, ccAsset, ccAssetByToken, displaySymbol } from '@anywalletkit/swap2-assets'

ccAsset('eip155:8453', 'USDC') // { symbol, assetId, decimals, contract, icon }
```

No dependencies — usable in an app, a server and a worker alike.

```sh
pnpm add @anywalletkit/swap2-assets
```

Apache-2.0
