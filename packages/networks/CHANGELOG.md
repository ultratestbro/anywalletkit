# @anywalletkit/networks

## 0.2.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/swap2-assets@0.1.3

## 0.2.0

### Minor Changes

- a17a31c: New package `@anywalletkit/networks`: one table of networks for every wallet build. The catalog mainnets (30 EVM chains plus Solana, TON, Tron, Bitcoin, NEAR, Zcash) with the public RPC failover lists the mobile app and the extension used to keep separately; default testnets for every family (Sepolia, Base / Arbitrum / OP Sepolia, Polygon Amoy, BSC testnet, Monad testnet, Solana devnet, Bitcoin testnet4, TON testnet, Tron Nile, NEAR testnet, Zcash testnet), shipped disabled; `NetworksTable` over any `JsonStorage` (AsyncStorage, chrome.storage, memory) — user RPCs are prepended to a builtin list, builtins cannot be deleted, `onlyOwnRpc` drops the public fallback, custom networks have none, a user RPC whose check failed is parked with the reason; `verifyNetwork` per family (EVM `eth_chainId`, Solana `getGenesisHash`, TON config param 19 global id, Tron genesis block id, BTC / Zcash genesis over Esplora / Blockbook / Blockchair, NEAR `status.chain_id`) with latency and tip; the URL policy (https only, `http://` for private addresses behind the explicit opt-in); `parseAddChainParams` (EIP-3085) lifted from the extension kit with the site origin recorded as the network's source.

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [e4083a3]
  - @anywalletkit/swap2-assets@0.1.2
