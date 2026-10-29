# @anywalletkit/tokens

## 0.2.1

### Patch Changes

- Updated dependencies [834c24d]
  - @anywalletkit/core@0.7.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.0

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

## 0.1.2

### Patch Changes

- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.1.1

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0
  - @anywalletkit/swap2-assets@0.2.1

## 0.1.0

### Minor Changes

- 3cf33ef: New package: tokens users add by address, at their own risk. `inspectToken(account, address)` reads the token from the chain through the account's `getTokenInfo` (EVM contracts, Solana mints including Token-2022) and returns `{ listed }` for a catalog token or `{ info, assessment, token }`. `assessToken` lists every warning, worst first: `impersonation` when the symbol reads as a catalog token of the same chain or a native coin / major stablecoin anywhere (Cyrillic and Greek look-alikes, `$`, `₮`, fullwidth and invisible characters folded), issuer powers (`permanent-delegate`, `transfer-hook`, `non-transferable` as danger; `upgradeable`, mint / freeze authority, transfer fee, default-frozen, pausable as caution) and `unlisted` always. `TokensTable` keeps the list over any JSON storage (queued writes, a failed read stays unloaded, catalog tokens and malformed entries refused). `swapSource(token)` gives the swap options for engines with `allowUnlistedTokens`.

### Patch Changes

- Updated dependencies [6dde4e4]
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0
  - @anywalletkit/core@0.5.0
