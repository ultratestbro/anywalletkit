# @anywalletkit/names-ens

## 0.5.0

### Minor Changes

- 0c5730b: A CCIP-Read gateway's answer is capped and timed on the device too (scan 2026-10-30, F13). `ensCcipRequest` (the default for `ensResolver({ rpcUrl })`) buffered the whole answer a name's gateway sent — any size, never ending, error statuses included.
  
  - The status and the declared `content-length` are checked first: a non-2xx or oversized answer is not read, and its body is cancelled.
  - The body is read to at most `EnsCcipOptions.maxResponseBytes` (default 1 MiB) — streamed where the runtime has a stream, `text()` otherwise (React Native) — then parsed.
  - `EnsCcipOptions.timeoutMs` (default 10 s) covers one gateway's request and whole answer, next to the caller's signal (merged by hand; Hermes-safe).
  - The reader is shared with `createEnsCcipHandler`, whose cap and deadline are unchanged.
  
  Behaviour: a gateway answer above 1 MiB or slower than 10 s fails the lookup (`lookup-failed`) where it used to be waited for; real gateway answers are a few KB.
- 94ae905: On Node, CCIP-Read gateways are asked through the pinned transport (scan 2026-10-30, F17). `ensCcipRequest` checked only the URL text, so a public-looking gateway host that resolves to 127.0.0.1 or a LAN address was connected to.
  
  - Node without `ccip.fetch`: each gateway call runs through `createEnsCcipHandler`'s transport, in process — every DNS answer checked (a host with any private, loopback, link-local, CGNAT or IPv4-carrying IPv6 record is refused), the connection pinned to the checked address, no redirects, the 1 MiB cap and the deadline. It is loaded with a dynamic import from a separate file that package.json's `browser` / `react-native` fields swap for a stub, so browser and React Native bundles contain neither `node:` modules nor `import()`.
  - Browsers and other runtimes keep the global fetch; the docs now say there is no DNS-level isolation there and recommend `ensCcipViaProxy`. React Native is unchanged.
  
  **Breaking (Node):** a gateway host whose records mix public and private addresses is refused, and gateways are no longer reached through a global fetch dispatcher (an outbound proxy) or a split-horizon DNS that answers private addresses — pass `ccip: { fetch }` there. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

### Patch Changes

- Updated dependencies [4191e15]
  - @anywalletkit/networks@0.5.0

## 0.4.0

### Minor Changes

- ab8bdb7: CCIP-Read on React Native: its fetch follows a gateway's redirect whatever `redirect: 'error'` says, so a resolver's gateway could send the device's request to a LAN or loopback host before the final URL was checked. There, no resolver-chosen gateway is fetched with the global fetch any more. New `EnsCcipOptions` (`ensResolver({ ccip })`, `createEnsCcipRead(opts)`, `ensCcipRequest(params, opts)`): `fetch` is an app-supplied fetch that does not follow redirects (typically one that goes through your server's CCIP-Read proxy; the https / public-host check still runs first), and `allowRedirectFollowingFetch: true` restores direct lookups and accepts that a redirecting gateway can make the device send one blind request. A 3xx answer is never used. Browsers, extensions and Node, whose fetch honours `redirect: 'error'`, are unchanged.
  
  The safe path is as short as the unsafe one. New `@anywalletkit/names-ens/server` entry with `createEnsCcipHandler(opts?)`: a framework-free handler, `(body) → { status, body }`, for one CCIP-Read gateway call `{ url, method, body? }`. It asks only https gateways on public hosts; resolves the host and refuses it when any address is private, loopback, link-local, CGNAT, multicast or an IPv6 address carrying one (mapped, NAT64, 6to4); connects with `node:https` to the address it checked, so a second DNS answer cannot move the request; never follows a redirect; applies a timeout (10 s) and an answer cap (1 MiB); sends GET, or POST with exactly `{ sender, data }`; forwards none of the caller's headers or cookies. Options: `allowHosts`, `denyHosts`, `timeoutMs`, `maxResponseBytes`, `maxRequestBytes`, and `lookup` / `fetch` doubles for tests. New `ensCcipViaProxy(proxyUrl, opts?)` (`headers`, `timeoutMs`, `fetch`, `allowInsecureProxyUrl`) is the app side: a `fetch` for `ensResolver({ ccip: { fetch } })` that sends each gateway call to that route, with no Node API (Hermes). On React Native with no `ccip` option, offchain names now fail with an `EnsNameError` whose new `reason` is `ccip-proxy-required` and whose message names `ccip.fetch` with `ensCcipViaProxy` / `createEnsCcipHandler`, or `allowRedirectFollowingFetch`; `ensResolver().resolve` reports it as itself, including through viem's batch gateway. New types: `EnsCcipViaProxyOptions`, `EnsCcipProxyRequest`, `EnsNameErrorReason`, `EnsCcipHandlerOptions`, `EnsCcipResponse`.
  
  **Breaking:** on React Native, offchain (CCIP-Read) names such as `cb.id`, Basenames and `uni.eth` subnames fail with `lookup-failed` (`reason: 'ccip-proxy-required'`) unless `ccip.fetch` (e.g. `ensCcipViaProxy` to a `createEnsCcipHandler` route) or `ccip.allowRedirectFollowingFetch` is set.

### Patch Changes

- Updated dependencies [834c24d]
- Updated dependencies [d37a88e]
  - @anywalletkit/core@0.7.0
  - @anywalletkit/networks@0.4.0

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
- Updated dependencies [5de7e66]
- Updated dependencies [0e43992]
  - @anywalletkit/networks@0.3.0

## 0.2.8

### Patch Changes

- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.2.7

### Patch Changes

- f743c06: `assertNameUnchanged` — the signing-time check that a name still points where it pointed when it was typed — now asks for a fresh resolution (`resolve(name, chain, { fresh: true })`). It went through the resolver's cache (ENS: 5 minutes), so a name re-pointed in between passed. `NameResolver.resolve` takes the optional `{ fresh }` (a caching resolver must bypass its cache for it), `nameResolvers` passes it on, and the ENS resolver honours it (the fresh answer then refreshes the cache).
- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.2.6

### Patch Changes

- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.2.5

### Patch Changes

- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.2.4

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0

## 0.2.3

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.2.2

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

## 0.2.1

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.2.0

### Minor Changes

- 386615c: New package: ENS on the core `NameResolver` — ENSIP-15 normalization, Universal Resolver forward resolution with wildcard + CCIP-Read, one chain per call via ENSIP-9/11 coin types (EVM L2s, Bitcoin script records, Solana keys) with no fallback to the mainnet address, forward-verified primary names incl. ENSIP-19 L2 names, avatars as URLs, confusable / mixed-script / punycode warnings, TTL cache.

### Patch Changes

- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @anywalletkit/core@0.2.0
