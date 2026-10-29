# @anywalletkit/networks

## 0.4.0

### Minor Changes

- d37a88e: `parseUrl` refuses a URL with a backslash, a tab, CR/LF or another control character anywhere in it, and treats `\` as the end of the authority. A WHATWG parser (browsers, Node, the extension's service worker) and OkHttp end the host at a backslash, so `https://192.168.1.1\admin` was checked as the public host `192.168.1.1\admin` and fetched from 192.168.1.1. This closes the gap for every caller of the shared policy: `checkRpcUrl`, `parseAddChainParams`, `isPublicHttpsUrl`, extension-kit's `wallet_addEthereumChain` RPC filter and names-ens gateway and avatar checks.
  
  **Breaking:** URLs containing `\`, a tab, CR, LF or another control character are refused (`checkRpcUrl` answers `not-a-url`, `isPublicHttpsUrl` answers false, a site's `rpcUrls` entry is dropped).

### Patch Changes

- @anywalletkit/swap2-assets@0.2.2

## 0.3.0

### Minor Changes

- 5de7e66: Token symbols and ENS lookups are checked the way users meet them. tokens: a symbol and name are trimmed and cut (`tokenText`, `TOKEN_SYMBOL_MAX` = 32, `TOKEN_NAME_MAX` = 128 code points) before they are stored **or assessed** — "USDC" + 124 spaces + "X" is stored as "USDC" and flagged as impersonation; `foldSymbol` is a confusables skeleton (ASCII `l` / `1` / `|` → I, `0` → O, `rn` → m, `cl` → d, `vv` → w, accents dropped), so "DAl" reads as DAI and "USDl" as USD1; letters that pass for Latin ones (Cyrillic, Greek, Armenian, Cherokee, Canadian syllabics, small capitals, letterlike, enclosed and math letters) or characters that hide in text (zero-width, bidi) in a symbol are `odd-characters` at `danger`; emoji, CJK and accented Latin stay a `caution`. names-ens: the client built from `rpcUrl` asks CCIP-Read gateways only over https on public hosts and refuses redirects (`ensCcipRequest` / `ensCcipRead` — pass `ccipRead: ensCcipRead` when you bring your own client); `avatar` returns the avatar record itself, filtered the same way (`avatarUrl`), and no longer resolves NFT avatars, so nothing is fetched to decide. networks: `isPrivateHost` knows link-local, CGNAT, benchmark and multicast ranges, every IPv4 spelling a URL parser accepts (`127.1`, `2130706433`, `0x7f.0.0.1`), the IPv4 inside mapped and NAT64 IPv6, IPv6 zones and `*.internal` / `*.home.arpa` / `*.lan`; new `isPublicHttpsUrl`; both also in `@anywalletkit/networks/url`, which does not load the catalog. extension-kit: `wallet_addEthereumChain` keeps a site's RPC URL only when `isPublicHttpsUrl` passes it, so `https://2130706433/` or `https://100.64.0.1/` no longer points the wallet's reads at the user's network.
  
  **Breaking:** stored token symbols are cut to 32 characters (on load too); names-ens `avatar` returns only an https URL on a public host or an `ipfs://` one (NFT, `http://`, `data:`, `ipns://` and `ar://` avatars come back `null`), and a host's own ENS client should get `ccipRead: ensCcipRead`; `isPrivateHost` treats more hosts as private. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

### Patch Changes

- 0e43992: Follow-ups from a review of the modules-scan fixes against the code (2026-10-28).
  - **CCIP-Read is off** in every viem client the SDK creates: wallet-evm, approvals and the protocol modules. names-ens keeps its own filtered one. A contract's `OffchainLookup` revert no longer makes the device fetch URLs it names, LAN addresses included. Two cases were reachable: an approvals scan calls every contract that emitted an Approval naming the user, spam tokens included, and wallet-evm reads tokens the user added.
  - **networks:** `isPrivateHost` treats a host that is not printable ASCII as private. A URL parser maps `127.0.0.１`, `127。0。0。1` and `ｒｏｕｔｅｒ.ｌａｎ` to 127.0.0.1 and router.lan (IDNA), so these got past `isPublicHttpsUrl`. Names in other scripts arrive as punycode and stay public. 6to4 addresses (`2002::/16`) carry their IPv4.
  - **tokens:**
    - The look-alike danger rule now also covers more lettering: Roman numerals, small capitals from Latin Extended-D/E, enclosed letters of the supplement (🅤), Tifinagh, Vai, Deseret, Osage, Lycian, Carian, Old Italic, Warang Citi and Georgian's look-alike letters.
    - It now covers more characters that hide: C0 and C1 controls, line breaks inside a symbol, the braille blank, interlinear annotation, tag characters (ASCII smuggling) and astral format controls.
    - It reads the stored symbol as well as the raw head, so leading spaces cannot push a look-alike out.
    - Fewer false alarms: ™ ℠ ℗, the tag-sequence flag emoji and ZWNJ in Persian or Indic spelling stay a caution.
    - `foldSymbol` drops spaces after NFKD, so "USDC´" reads as USDC.
  - **names-ens:** `ipfsGateway` may be an origin (`/ipfs/<cid>` is appended, as before the fix) or a prefix ending in `/ipfs/`.
  - **approvals:** `isRevokeTransaction` never throws, and `targets` may also be a plain object or `[address, standard]` pairs.
  - **mellow:** `claimWithdrawals` claims only on pinned redeem queues, like every other queue call.
  - **swap2-core:** `remoteProvider` trims `baseUrl` and refuses a scheme-relative one (`//host`). A leading space or `//` used to get past the https check.
  - **omniston:** `createOmnistonTonValidators()` declares the validators it always returns as required, so `omnistonVerifyBuild({ ...createOmnistonTonValidators() })` typechecks.
- @anywalletkit/swap2-assets@0.2.2

## 0.2.7

### Patch Changes

- Updated dependencies [eb14cb5]
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.6

### Patch Changes

- eec3745: Three gaps in the networks table closed. `verifyNetwork` checks the genesis of `bitcoin:signet`, `bitcoin:regtest` and `zcash:regtest` (it passed any endpoint for them — the expected genesis was empty) and refuses a UTXO network it cannot identify instead of waving it through. `parseAddChainParams` drops private / local RPC hosts (localhost, 10.x, 192.168.x, *.local…) even over https unless `allowHttpLocal` is passed — a site must not point the wallet at the user's own network. And turning "Allow http for local nodes" off parks the `http://` local RPCs stored while it was on (skipped, with the reason) instead of still using them; turning it on again restores them.
- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [398129f]
  - @anywalletkit/swap2-assets@0.2.1

## 0.2.5

### Patch Changes

- Updated dependencies [6dde4e4]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0

## 0.2.4

### Patch Changes

- 8aa911d: Audit 2026-10-25 (post-release), low findings L3–L7:
  
  - **backup-cloud (L3).** `iCloudKeychain().getOrCreate` runs one call at a time per keychain item, process-wide. Two at once (a double tap on "back up") both saw no key, both created one, and the second overwrote the key the first backup had just been sealed with, so that file no longer opened without its password. Each caller still gets its own copy of the key.
  - **keyring (L4).** `importMnemonic(phrase, { adoptId })` reads the id once and requires it to hold this phrase and passphrase (`{"type":"mnemonic",…}`). Before, the source took the id unread: the accounts' addresses came from the phrase passed in, while signatures used whatever the id held. A missing, different or unreadable secret is refused with `invalid-input`; a bad or taken id and a phrase already in the keyring are refused before that read (no prompt).
  - **extension-kit (L5).** `Vault.addPasskey` is refused (`invalid-input`) while the vault holds no secret. With nothing to prove the DEK against, any 32 bytes were sealed under the passkey, and every later passkey unlock handed out that wrong key.
  - **core (L6).** `assertNameUnchanged` compares addresses without case only on `eip155:*`. On other chains a case variant of a base58 address is another key, and it passed as "unchanged".
  - **networks (L7).** `rpcUrlsForSync` / `usesUserRpcSync` throw `NetworkError('not-loaded')` before `load()`. They answered from the builtin table, so a client built at cold start used public RPCs the user had turned off (`onlyOwnRpc`), and the review sheet called the RPC not custom. `listSync` / `getSync` still answer builtin-only before `load()`. A failed storage read no longer counts as an empty table: `load()` rejects and stays retryable, and no write runs on top of it (the next write used to replace the user's stored RPCs).
- @anywalletkit/swap2-assets@0.1.5

## 0.2.3

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: `NetworksTable` writes made at once all land. Every write read the state, awaited, and saved a copy of what it had read, so with an asynchronous storage (AsyncStorage, `chrome.storage`) two writes at once (two `addRpc`, two `markRpc` after a verification round) lost one; `addRpc` / `removeRpc` read and wrote in two separate steps. Each write is now one serialized read → change → save, and memory changes only after the storage accepted the write. Audit 2026-10-25, #1.7.
- Updated dependencies [07db4c1]
- Updated dependencies [a9a5e0a]
  - @anywalletkit/swap2-assets@0.1.5

## 0.2.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/swap2-assets@0.1.4

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
