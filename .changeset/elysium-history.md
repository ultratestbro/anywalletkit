---
"@anywalletkit/history-evm": minor
---

Elysium by Kinetiq (`eip155:99901`) has keyless history: its Blockscout's Etherscan-format API `https://elysium.kinetiq.xyz/api` is in `ETHERSCAN_COMPAT_URLS` (the `/api/v2` endpoints sit behind a Vercel bot checkpoint), and `EXPLORER_TX_BASE` links to `https://elysium.kinetiq.xyz/tx/<hash>`. Checked live on 2026-11-10 through `createEvmHistory({ chainId: 99901 })`: `listActivity` and `getTransaction`.

Blockscout's Etherscan-format answers `No internal transactions found` and `No token transfers found` are now read as empty lists. Before, an address with no internal transfers failed the whole page on that API, and on Blockscout PRO.
