---
"@anywalletkit/wallet-tron": minor
"@anywalletkit/kit": patch
---

Tron `signRaw` runs what `prepare()` runs for the wallet's own builds. With a provider, the reference block must be a block of the configured network (`/wallet/getnowblock` + `/wallet/getblockbynum`, code `ref-block-mismatch`), also for node builds and prebuilt `sendTransaction` input; offline, a non-mainnet account refuses to sign unless the new config `allowOfflineTestnetSigning` is set (code `offline-network`). Under a fee cap, the bytes are priced (fee_limit + bandwidth, memo and activation fees) and refused above the cap, a contract call without `fee_limit` is refused, and so is any transaction without a provider to price it. `raw_data.data` above 512 bytes is refused (code `memo`). For contract types without a schema, a JSON copy that names a payment field (`to_address`, `amount`, `contract_address`…) is `raw-mismatch`. In the kit, the `signRaw` intent's `to`, `amount` and `token` are read off `raw_data_hex` (TransferContract, TRC-10, TRC-20 calls), never the JSON copy.
