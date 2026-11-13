# @anywalletkit/extension-kit

## 0.5.1

### Patch Changes

- Updated dependencies [b1ac0e3]
  - @anywalletkit/protocol-swap2-core@0.11.0
  - @anywalletkit/wallet-ton@0.8.1

## 0.5.0

### Minor Changes

- 87fbc2d: A `personal_sign` whose message comes as text but whose UTF-8 encoding — the bytes the signer signs — is exactly
  32 bytes is no longer a normal message: it reaches the sheet with `blindHash: true` and the new
  `blindHashForm: 'text'`. Those are the same 32 bytes behind the EIP-191 "\n32" prefix that CoW Protocol's
  `ethsign` order scheme and similar verifiers accept as an order or a transfer, and a site can grind an order until
  its digest is valid UTF-8 and send it decoded. It is not refused, and `allowBlindHash` does not change it: show it as
  a danger screen ("This looks like a hidden hash. Signing it may authorize a transfer or an order.", Reject / Sign
  anyway). **Breaking:** until now `blindHash` came only with the `allowBlindHash` opt-in, so a wallet that never
  turned it on may have no danger screen for it; it now gets `blindHash: true` without the opt-in, and a sheet with no
  `blindHash` branch shows it as an ordinary message. Add that branch (red screen, Reject / Sign anyway) before you
  bump. A sheet that already turns `blindHash` into a danger screen covers it without changes. The hex form (`0x` + 64
  hex) is unchanged — refused unless `allowBlindHash`, then `blindHash: true` — and now also carries
  `blindHashForm: 'hex'`. The 32-byte check reads the bytes the signer is handed (hex decoded, any other string as
  UTF-8), not the string's length: multi-byte characters, a BOM and hex-looking text count as the bytes they encode
  to; only a message of at most 66 characters is encoded for it. New type `PersonalSignBlindHashForm`
  (`'hex' | 'text'`).

### Patch Changes

- @anywalletkit/wallet-evm@0.8.0
  - @anywalletkit/keyring@0.3.10

## 0.4.0

### Minor Changes

- d9791fe: A `personal_sign` whose message is a raw 32-byte hash (`0x` + 64 hex) is refused (4200) before any sheet: the
  bytes are signed as an EIP-191 "\n32" message, which CoW Protocol's `ethsign` order scheme, Safe owner signatures
  (v > 30) and similar verifiers accept as an order or a transfer to someone else. A wallet can opt in per request with
  the new `SignDeps.allowBlindHash` (or `allowBlindHash` on `classifySignRequest`); the request then reaches the sheet
  with `blindHash: true`, which the sheet should show as a danger screen.
- 16078d4: Signing sheet signals from the 2026-11-09 extension audit:
  
  - `messageText` and the typed-data `text` now show every invisible or direction-changing character
    (Unicode Cf — bidi overrides / isolates, zero-width characters, BOM… — plus line separators and stray
    controls) as a visible `⟨U+XXXX⟩`; the request carries `hiddenChars: true` when anything was escaped. The
    bytes that get signed are unchanged. New export `revealHidden`.
  - A Sign-In with Ethereum message containing bidi controls or zero-width characters is refused (-32602),
    like one with hidden control characters. New export `SIWE_FORBIDDEN_CHARS`.
  - `describeSiwe` sets `crossSite: { domain, origin }` when the sign-in names another site than the one
    asking (new export `siweCrossSite`), so a sheet can make it the headline.
  - `prepareTransaction` still signs a page's gas limit as given, but now also asks the wallet's RPC for an
    estimate and returns `gasCheck: { estimate, excessive }` — `excessive` when the page's limit is above
    max(estimate × 1.5, estimate + 50 000) (new export `gasLimitExcessive`). A failing estimate leaves
    `gasCheck` out and does not fail the request.
- a7c092d: Elysium by Kinetiq (`eip155:99901`, gas in HYPE) is a builtin network: `EVM_MAINNETS` / `CATALOG_NETWORKS` and the extension's `DEFAULT_NETWORKS` carry its public RPC `https://rpc.elysium.kinetiq.xyz` (CORS-open, `eth_chainId` 0x1863d, checked with `verifyRpcs` on 2026-11-10) and its explorer `https://elysium.kinetiq.xyz`. 31 EVM mainnets.

### Patch Changes

- c88afea: The `deposit-address` route flag can now be set per route, not only per provider:
  
  - `RankOptions.depositAddressRoute(quote)` and `QuoteRoutesOptions.depositAddressRoute(quote, params)` — the app's predicate for a provider that pays a server-assigned address only on some routes (a THORChain inbound vault on a non-EVM source chain, a Bitcoin deposit address) and verifiable calldata on the rest. A route is flagged when its provider is in `depositAddressProviders` or the predicate returns true; a predicate that throws counts as flagged.
  - BEST still never goes to a flagged route while an unflagged route exists; when every route is flagged, the best of them is BEST. Flagged routes stay listed and selectable.
  
  `depositAddressProviders` keeps working as before; without the new option nothing changes.
- 31aa916: A fee that rose after the review is asked again on a follow-up sheet that the queue limits do not refuse. `ApprovalQueue.request(input, { followUp: true })` is another sheet for a request the user has just approved: each approval pays for one follow-up of the same origin, kind and chain, which skips the per-origin / per-site / total limits and the rate limit and is shown ahead of the requests already waiting (a refused origin stays refused). The `eth_sendTransaction` re-ask uses it, carries the max fee shown before (`SignApproval.repricedFrom`), stops after `MAX_FEE_REASKS` (3) re-asks in a row with nothing signed, and refuses a new fee above `SignDeps.feeCeiling(network)` without a second sheet.
- b5810c3: `DEFAULT_NETWORKS`: Plasma gains a second RPC endpoint run by a different operator — `https://plasma.gateway.tenderly.co` (Tenderly's public gateway, no key) after `https://rpc.plasma.to`. A wallet that requires two independent operators before it acts (the Omniston HTLC-secret quorum) could not reach that on Plasma with one endpoint; ordinary reads gain a failover. Checked live on 2026-11-10: chain id 0x2611, no redirect, CORS open, the same block hashes and escrow-factory logs as `rpc.plasma.to`, state reads at past blocks. An extension that allowlists hosts must list the new one.
- 394c908: New: `storageVersionLedger({ manifest, mark })` and the `versions` option of `macJsonStorage` — rollback protection for signed stores. A MAC alone proves who wrote a value, not that it is the latest: an older signed value copied back verified. With a ledger every signed value carries a version inside its MAC (`STORAGE_VERSION_FIELD`), a signed manifest kept next to the stores lists the latest version of each, and `mark` (session storage) remembers the highest manifest epoch seen. `read()` answers the new state `stale` (and `get()` `null`) for an older signed value put back, for a store deleted after it was written, and for every store when the manifest is missing, unsigned, edited, or older than the mark. A value exactly one version ahead of the manifest is accepted and recorded (a worker killed between the two writes). `ledger.condemn(key)` starts a sealed manifest above everything before it; `ledger.rekey(oldKey, newKey)` goes before the stores' `rekey`, which keep their versions; `acceptUnversioned` lets values signed before the ledger existed through until they are rewritten (off by default). Not detectable, by design of the platform: the whole storage area put back or wiped consistently when there is no mark (across a browser restart or an extension reload). Also new: `NetworksTable.reload()` and `RecipientBook.reload()` drop the in-memory copy, for a storage that only answers once the wallet is unlocked. Nothing changes for code that passes no `versions`; `MacState` gains the member `'stale'`, which only a store with a ledger returns.
- f9e0bdf: `Session.setAutoLockMs` no longer pushes the auto-lock deadline out. Before, it ended with `touch()`, so a wallet that applied its stored setting at every service-worker start (alarms, page loads and port reconnects all restart the worker) extended the deadline by a full period each time and never locked. Now it stores the period, re-arms the alarm at the stored deadline (a missed alarm comes back, an expired record locks), and only brings the deadline forward when the new period ends sooner. A longer period, or 0 (never), applies from the next `touch()` / `unlock()`: call `session.touch()` right after the user changed the setting. Call `touch()` for explicit user gestures only, not for passive polls or page requests.
- 97197e2: New: `macJsonStorage(store, { label, key })` and `deriveStorageMacKey(dek)` — integrity for the small JSON stores a wallet keeps in `chrome.storage.local` (settings, per-site permissions), which that area does not authenticate. Each value is stored with an HMAC-SHA256 under a key derived from the vault key (HKDF-SHA256, one-way, so a wallet may keep it in `chrome.storage.session` while locked). `get()` answers `null` for a value that is plain (written before, or planted), edited, signed for another store or under another key; `read()` tells which (`ok` / `empty` / `unsigned` / `invalid` / `no-key`) and `rekey(oldKey, newKey)` re-signs after `rotateVaultKey`. Without a key, reads return the stored value unverified (or `null`, `readWithoutKey: 'null'`) and writes store it unsigned so it fails verification later (or throw `locked`, `writeWithoutKey: 'refuse'`). It plugs into anything that takes a `JsonStorage`, e.g. `new PermissionStore(macJsonStorage(chromeJsonStorage(area, key), { label, key }))`. Nothing changes for code that does not use it.
- a96508b: Per-site EVM grants in `RequestRouter`. An origin sees the accounts it was granted that the wallet exposes right now (`accounts()`, the active account), as before; what changes is that connecting another account (`eth_requestAccounts` / `wallet_requestPermissions` after a switch) now ADDS it to that origin's grant through the new `PermissionStore.grant` instead of replacing the list, so switching back to an account the site already had needs no new sheet. `wallet_getPermissions` lists only the visible accounts. A signing request is refused with 4100 and a message that says to switch accounts when it names a granted account that is not the active one (or when the wallet is locked), and the `sign` hook now receives the visible accounts instead of the whole grant. `PermissionStore.setAccountsEverywhere` is deprecated: it rewrote every origin's grant to the active account and showed that account to sites it was never connected to; nothing in the package calls it, call sites should stop calling it.
  
  `eth_getLogs` from an origin without an EVM grant may span at most `GETLOGS_MAX_SPAN_UNCONNECTED` (1000) blocks; a wider range (block tags resolved against `eth_blockNumber`) is refused with -32005 before it reaches the RPC. Connected origins and `blockHash` filters are unchanged.
- c8c4f4b: `ApprovalQueue` limits beyond one origin, so a page that hops over subdomains cannot bury a real request under windows. New defaults: at most `APPROVALS_MAX_PENDING_PER_SITE` (5) requests waiting per site (registrable domain; subdomains share them) and `APPROVALS_MAX_PENDING_TOTAL` (20) in the whole queue, both -32005; and a per-site sheet rate (`openRate`: a token bucket, 10 at once and 10 a minute by default; running dry refuses with -32005 for a cooldown that starts at 30 s and doubles on each repeat, up to 10 min). Options `maxPendingPerSite`, `maxPendingTotal`, `openRate` (`false` turns the rate off), `siteOf` and `exempt` (origins that skip every limit — pass the wallet's own pages). New methods `declineOrigin(origin)` (the origin's last page closed) and `declineSite(site)` ("decline all from this site"), `siteFor(origin)` and `pendingForSite(site)`.
  
  New helpers `siteOf(origin)` (a conservative registrable domain without a full Public Suffix List: the last two labels, three under `MULTI_LABEL_SUFFIXES` such as `co.uk`, `github.io`, `vercel.app`; a pseudo-origin such as `wc:<topic>` is its own site) and `TokenBucket` (a token bucket per key, memory only).
- 84a9097: Swap routes carry what the wallet cannot vouch for, and BEST respects it (warnings, never refusals):
  
  - `rank(quotes, options)` takes `RankOptions` (`slippageBps`, `depositAddressProviders`); `RouteView.warnings` lists `min-below-slippage` (the provider's minimum sits further under its own quote than the requested slippage, with `minGapBps`) and `deposit-address` (the route pays an address the provider's server assigns, e.g. a NEAR Intents 1Click deposit address). A route below the slippage is never BEST; a deposit-address route is BEST only when no other provider's route exists. The BEST route is listed first, the rest keep the output order; with no eligible route there is no BEST.
  - `quoteRoutes` passes `params.slippageBps` to the providers and ranks with it, but a quote whose minimum still lands under it is kept and flagged instead of refused as "invalid"; `QuoteRoutesOptions.depositAddressProviders` names the deposit-address providers (the app's choice).
  - `SwapReviewMeta.slippageBps` adds a sheet check (`Minimum within your X% slippage`, or a warning when the plan's minimum is further under the output) and `SwapApproval.slippage`; `SwapReviewMeta.depositAddressAssignedByProvider` turns the deposit check into a warning ("Deposit address assigned by the … server — funds go to an address the wallet cannot verify"), sets `SwapApproval.depositAssignedByProvider`, and the recipient check is no longer "Funds arrive at your address" on `plan.recipient` alone (status `unknown`).
  
  Without the new options nothing changes.
- 68f3fe1: `Vault.unlock` and `Vault.unlockWithPasskey` now prove that the unwrapped key is the vault's own (its DEK check, or the first secret in an envelope written before the check existed) and fail with `wrong-password` otherwise. Before, a dek box or passkey box spliced in from another vault "unlocked" with the attacker's password or passkey and returned a foreign key; a wallet that used `unlock(password)` as a yes/no password check (for example before showing the seed phrase) accepted it. `changePassword` and `rotateVaultKey` refuse such a box too.
  
  `rotateVaultKey(password, newPassword?)`: with `newPassword`, the fresh DEK is wrapped under the new password, so changing the password and retiring the old DEK is one step (one envelope write). Passkeys are dropped as before, since their boxes hold the old DEK.
- Updated dependencies [56e3c33]
- Updated dependencies [9677422]
- Updated dependencies [9677422]
- Updated dependencies [867041b]
- Updated dependencies [b5810c3]
- Updated dependencies [6d6e801]
- Updated dependencies [ff6582a]
- Updated dependencies [a7c092d]
- Updated dependencies [89feb83]
- Updated dependencies [ca72d9b]
  - @anywalletkit/wallet-evm@0.8.0
  - @anywalletkit/wallet-ton@0.8.1
  - @anywalletkit/networks@0.6.0
  - @anywalletkit/swap2-assets@0.3.0
  - @anywalletkit/protocol-swap2-core@0.10.3
  - @anywalletkit/keyring@0.3.10

## 0.3.6

### Patch Changes

- 023f997: New package `@anywalletkit/walletconnect-ton`: WalletConnect for TON, so TON dApps that offer WalletConnect (`@tonconnect/sdk` 3.4+ `initializeWalletConnect`, STON.fi among them) connect to a wallet that is not listed in the TON wallets registry. `tonSessionNamespace` (user-friendly CAIP-10 account), `tonSessionProperties` (`ton_getPublicKey`, `ton_getStateInit`), `tonProofAuthentication` (the proposal's CAIP-122 `ton_proof`), and `handleTonRequest` for `ton_sendMessage` / `ton_signData`: parsed and checked, shown to the app's review, then one signing call (`sendTransaction` under the account's policies, one signature, the broadcast bytes as the reply; `signTonConnectData` bound to the peer domain). No WalletConnect runtime dependency.
  
  `wallet-ton`: TON Connect request parsing now lives here, in one place for every transport — `parseConnectRequest`, `parseSendTransaction` (network / `from` / `valid_until` / message cap checks, structured items and extra currencies refused), `parseSignData` (`cell` refused), `TonConnectError` / `TONCONNECT_ERRORS`, address helpers (`tonConnectRawAddress`, `tonConnectFriendlyAddress`, `sameTonConnectAddress`) — from the main entry and the light subpath `@anywalletkit/wallet-ton/tonconnect` (no `@ton/core`). `sendTransaction` and `transfer` also return `boc`: the external message exactly as broadcast.
  
  `extension-kit`: its TON Connect parsing and digests are the shared ones from `wallet-ton/tonconnect` (same exports; `wallet-ton` is now a dependency). `parseSendTransaction` / `parseSignData` additionally check `from` against the wallet when given an `address`, and refuse structured items and extra currencies (400).
- Updated dependencies [10e06dc]
- Updated dependencies [993fb58]
- Updated dependencies [023f997]
  - @anywalletkit/swap2-assets@0.2.3
  - @anywalletkit/wallet-ton@0.8.0
  - @anywalletkit/networks@0.5.2
  - @anywalletkit/protocol-swap2-core@0.10.2
  - @anywalletkit/keyring@0.3.9
  - @anywalletkit/wallet-evm@0.7.0

## 0.3.5

### Patch Changes

- @anywalletkit/protocol-swap2-core@0.10.1
  - @anywalletkit/swap2-assets@0.2.2
  - @anywalletkit/wallet-evm@0.7.0

## 0.3.4

### Patch Changes

- f7f2a08: `eth_sendTransaction`: when the network's fees fell to less than a quarter of the cap the review sheet showed (a fee spike passed while the sheet was open), the transaction is now signed at the current fees (2 × base fee + tip, or the current gas price) instead of the stale cap, without a second sheet — the user pays at most what they approved. Before, a provider-backed signer (a `WalletAccountEvm` with a `provider`, which refuses caller-set fees far above the network quote) could refuse the approved transaction after the user said yes. A rise in fees still asks again, as before.
- 3b81a37: A CCTP swap claimed through `claimSwap2` reaches `completed` again without an RPC for the destination chain, when the destination account proves the claim.
  
  - `claimSwap2` already waits for the claim with the account's `waitForTransaction`. When that wait resolves (the claim was included and succeeded), the id it returns now ends in `.ok` after the claim hash: `awk1.<provider>.<intent>.<sourceTx>.<claimTx>.ok`. Polling that id passes the new `IntentRef.destTxConfirmed: true` to the provider (a remote backend forwards it too).
  - The CCTP provider takes a confirmed claim as the mint, since `receiveMessage` reverts once the message's nonce is used: `completed` without a destination RPC. With a destination RPC that does not show the mint yet, it reads `pending` (claim not ready) instead of offering the claim again.
  - A bare claim hash (an account without `waitForTransaction`, or a wait that timed out) still proves nothing and stays `pending` until the destination's `usedNonces` shows the mint.
  - `parseSwapId` (extension kit) reads the `.ok` segment as `destTxConfirmed`.
  
  What to do: keep polling with the id `claimSwap2` returns (store it in place of the old one), and give the destination account `waitForTransaction` (the SDK's EVM accounts have it). If you parse swap ids yourself, accept a fifth segment `ok`. An RPC for each destination in `rpcUrls` is still the way to see a claim sent from elsewhere complete.
- 9620342: An empty vault now tells its own key from any other. New envelopes carry `dekCheck`, a fixed value sealed under the vault key (written by `create`, `changePassword`, `rotateVaultKey` and the v1→v2 upgrade). Before, a vault with no secrets accepted any 32 bytes in `setSecret`: after `rotateVaultKey` and deleting the last secret, a session still holding the retired key could seal a secret that the password would never open again. Now `setSecret` refuses such a key with `locked`, and `addPasskey` works on an empty vault when given the vault's own key (a wrong one is `locked`). Vaults written by earlier versions open as before and get the check the next time the envelope is re-sealed (change the password or rotate the key to add it right away). Nothing else to change.
- Updated dependencies [f2d2e4f]
- Updated dependencies [2e5fcf4]
- Updated dependencies [7c2f089]
- Updated dependencies [eb3af5f]
- Updated dependencies [204217e]
- Updated dependencies [6820874]
- Updated dependencies [3b81a37]
- Updated dependencies [b16f9b1]
- Updated dependencies [0919427]
- Updated dependencies [ac56c9b]
- Updated dependencies [21f2b25]
- Updated dependencies [f08dce7]
- Updated dependencies [b269e9b]
- Updated dependencies [c533926]
- Updated dependencies [af7a82b]
- Updated dependencies [91fe18a]
- Updated dependencies [e6c97b4]
- Updated dependencies [828593e]
- Updated dependencies [ccea432]
- Updated dependencies [d1e517a]
- Updated dependencies [4a552d4]
- Updated dependencies [f90112a]
- Updated dependencies [57a68aa]
- Updated dependencies [89c63eb]
- Updated dependencies [477f10e]
- Updated dependencies [5b3e194]
- Updated dependencies [701d651]
  - @anywalletkit/wallet-evm@0.7.0
  - @anywalletkit/protocol-swap2-core@0.10.0
  - @anywalletkit/core@0.8.0
  - @anywalletkit/keyring@0.3.9
  - @anywalletkit/swap2-assets@0.2.2

## 0.3.3

### Patch Changes

- Updated dependencies [cbd7caa]
  - @anywalletkit/networks@0.5.1
  - @anywalletkit/keyring@0.3.8
  - @anywalletkit/wallet-evm@0.6.0

## 0.3.2

### Patch Changes

- Updated dependencies [1b85326]
- Updated dependencies [4191e15]
- Updated dependencies [9e27fc6]
- Updated dependencies [6c035e4]
  - @anywalletkit/wallet-evm@0.6.0
  - @anywalletkit/networks@0.5.0
  - @anywalletkit/protocol-swap2-core@0.9.0
  - @anywalletkit/keyring@0.3.8

## 0.3.1

### Patch Changes

- Updated dependencies [834c24d]
- Updated dependencies [88a4582]
- Updated dependencies [d37a88e]
- Updated dependencies [12fc609]
  - @anywalletkit/core@0.7.0
  - @anywalletkit/wallet-evm@0.5.0
  - @anywalletkit/protocol-swap2-core@0.8.0
  - @anywalletkit/networks@0.4.0
  - @anywalletkit/keyring@0.3.8
  - @anywalletkit/swap2-assets@0.2.2

## 0.3.0

### Minor Changes

- f1a46e4: Text and calldata from a page, a client or an API are bounded before anything parses them. extension-kit: an error message is cut to its first line within 1 KB before its URLs are taken out (the URL regex has a bounded scheme), and a request's `method` must be a method name — letters, digits and `_`, at most 128 (`isRelayMethod`, `RELAY_METHOD_MAX`) — or the relay drops it and the router answers -32600 without echoing it. swap2-core: `redactUrls` is linear whatever the text (it also catches a URL right after `_` or glued to a long word now), and the server cuts a provider's refusal or error before redacting it. Balancer: `preflightDeposit` decodes and prices only the quote's own batch — a client's different `tx.data` is refused before it is decoded — with at most `BALANCER_MAX_SWAPS` (16) hops and no pool `userData`, and a longer SOR route is refused at the quote. Fynd: `preflightDeposit` simulates only the quote's own transaction (target, calldata, value), a refusal names the transaction target only when it is an address, and protocol names from the API are cut to 40 characters.
  
  **Breaking:** extension-kit drops a relay request whose `method` is not a method name (answer it with -32600 in your injected provider); Balancer `preflightDeposit` refuses calldata that is not the quote's own batch, and Fynd's a transaction whose target, calldata or value differs from the quote's. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
- c2d8c1f: `Vault.rotateVaultKey(password)` replaces the vault key after a suspected compromise: a fresh DEK, every secret re-sealed under it and the DEK wrapped under the password with a fresh salt, written as one envelope (a failure leaves the old vault as it was; `rotatedAt` records when). It returns the new DEK — hand it to `session.unlock`, which overwrites the old one in `chrome.storage.session`. Passkeys are dropped, because their boxes hold the old DEK and cannot be re-wrapped without their PRF output; register them again. `setSecret` now refuses (`locked`) a DEK that does not open the vault's secrets, so a stale session cannot seal a new secret under a retired key. `changePassword` is unchanged and documented as not enough after a compromise (it re-wraps the same DEK).
  
  **Breaking:** `setSecret` refuses (`locked`) a DEK that does not open the vault's secrets. An empty vault has nothing to check it against and accepts any DEK. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
- 5de7e66: Token symbols and ENS lookups are checked the way users meet them. tokens: a symbol and name are trimmed and cut (`tokenText`, `TOKEN_SYMBOL_MAX` = 32, `TOKEN_NAME_MAX` = 128 code points) before they are stored **or assessed** — "USDC" + 124 spaces + "X" is stored as "USDC" and flagged as impersonation; `foldSymbol` is a confusables skeleton (ASCII `l` / `1` / `|` → I, `0` → O, `rn` → m, `cl` → d, `vv` → w, accents dropped), so "DAl" reads as DAI and "USDl" as USD1; letters that pass for Latin ones (Cyrillic, Greek, Armenian, Cherokee, Canadian syllabics, small capitals, letterlike, enclosed and math letters) or characters that hide in text (zero-width, bidi) in a symbol are `odd-characters` at `danger`; emoji, CJK and accented Latin stay a `caution`. names-ens: the client built from `rpcUrl` asks CCIP-Read gateways only over https on public hosts and refuses redirects (`ensCcipRequest` / `ensCcipRead` — pass `ccipRead: ensCcipRead` when you bring your own client); `avatar` returns the avatar record itself, filtered the same way (`avatarUrl`), and no longer resolves NFT avatars, so nothing is fetched to decide. networks: `isPrivateHost` knows link-local, CGNAT, benchmark and multicast ranges, every IPv4 spelling a URL parser accepts (`127.1`, `2130706433`, `0x7f.0.0.1`), the IPv4 inside mapped and NAT64 IPv6, IPv6 zones and `*.internal` / `*.home.arpa` / `*.lan`; new `isPublicHttpsUrl`; both also in `@anywalletkit/networks/url`, which does not load the catalog. extension-kit: `wallet_addEthereumChain` keeps a site's RPC URL only when `isPublicHttpsUrl` passes it, so `https://2130706433/` or `https://100.64.0.1/` no longer points the wallet's reads at the user's network.
  
  **Breaking:** stored token symbols are cut to 32 characters (on load too); names-ens `avatar` returns only an https URL on a public host or an `ipfs://` one (NFT, `http://`, `data:`, `ipns://` and `ar://` avatars come back `null`), and a host's own ENS client should get `ccipRead: ensCcipRead`; `isPrivateHost` treats more hosts as private. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

### Patch Changes

- Updated dependencies [c59c8cc]
- Updated dependencies [f1a46e4]
- Updated dependencies [5de7e66]
- Updated dependencies [418fea1]
- Updated dependencies [28c7d3a]
- Updated dependencies [a4ceb50]
- Updated dependencies [0e43992]
  - @anywalletkit/protocol-swap2-core@0.7.0
  - @anywalletkit/networks@0.3.0
  - @anywalletkit/wallet-evm@0.4.1
  - @anywalletkit/keyring@0.3.7
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.2

### Patch Changes

- Updated dependencies [4df03a5]
- Updated dependencies [ef0aae1]
- Updated dependencies [60c1999]
- Updated dependencies [e6d0d39]
- Updated dependencies [9684dab]
  - @anywalletkit/wallet-evm@0.4.0
  - @anywalletkit/keyring@0.3.7

## 0.2.1

### Patch Changes

- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- Updated dependencies [b1350b4]
- Updated dependencies [eb14cb5]
  - @anywalletkit/protocol-swap2-core@0.6.1
  - @anywalletkit/wallet-evm@0.3.1
  - @anywalletkit/core@0.6.1
  - @anywalletkit/keyring@0.3.7
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.0

### Minor Changes

- f2de8b6: A site on the shipped phishing list is now refused, not only warned about. `PhishingDetector.refusal(origin)` gives the reason for a listed host; `ApprovalQueueOptions.refuse` and `RouterDeps.refuse` take it and answer every request from that origin with EIP-1193 4100 (`OriginRefused` at the queue) before any approval window opens — reads, `eth_accounts` and an earlier permission included. Lookalikes and punycode still only warn. Wire both hooks; without them the behaviour is unchanged.
- f2de8b6: `eth_sendTransaction` takes the nonce after the review, not before. Two requests waiting at once used to show and sign the same nonce, so the second replaced the first or was refused. The nonce is now read after the approval under a per-account lock that also covers the broadcast, and never below the wallet's own next nonce. The fee caps signed are the ones shown; when the network outgrew them while the sheet was open (EIP-1559: base fee + tip above the shown cap; legacy: a higher gas price), the user is asked again with the new numbers (`SignApproval.repriced: true`).
- f2de8b6: The swap gate checks the order itself and the account. A gasless swap's sheet said "Signed order" without the order, and its pre-approval let any EIP-712 data on the chain through once — another order or a Permit, for any account.
  
  - `SwapApproval.source` for a typed order carries `typedData` (parsed) and `text` (pretty JSON) for the sheet.
  - `GatedOp` `evm-typed-data` requires `typedDataHash` — `typedDataHash(typed)` from `@anywalletkit/wallet-evm` (now exported), the digest the account signs; `planMatchers` compares it (`typedDataMatcher`). A plan whose order cannot be hashed is refused before the sheet opens.
  - `ReviewGate.preApprove(matchers, ttlMs, account)` binds pre-approvals to an account; a bound one passes only an op whose new `account` field names it. `SwapReviewMeta.account` and `EarnReviewMeta.account` are required and `reviewSwapPlan` / `reviewEarnPlan` always bind — pass the account in the ops your reviewed account builds.
  - `@anywalletkit/wallet-evm` is now a dependency of extension-kit.

### Patch Changes

- eec3745: `wallet_addEthereumChain` drops private / local RPC hosts (localhost, *.local, 10.x, 172.16–31.x, 192.168.x, 169.254.x, IPv6 loopback / unique-local / link-local) even over https: a page could otherwise point the extension's RPC reads at the user's router or LAN services.
- f2de8b6: `Session` with `autoLockMs: 0` ("no auto-lock") stays unlocked in Chrome. The record stored `expiresAt: Infinity`; chrome.storage keeps JSON, Infinity became `null`, and the next read took the wallet for locked right after unlock. "No auto-lock" is now stored as `expiresAt: null`. A stored record that is there but unreadable (wrong types, a key that is not 32 bytes) now locks the wallet: it is removed and `onLock` listeners run.
- f2de8b6: `SwapsStore` writes one after another. `add`, `update` and `remove` read the list, changed it and wrote it back with no ordering, so an alarm tick's `update` that read the list before a just-executed swap was added wrote the old list back: the new swap vanished and was never tracked. They now run in a queue (as `PermissionStore` does), each reading the list inside its turn. `parseSwapId` also reads the id `claimSwap2` returns, whose 4th segment is the claim hash (`destTxHash`).
- f2de8b6: The vault wipes the copies it hands to WebCrypto. Every input went through a fresh `ArrayBuffer` copy (`toArrayBuffer`), and the copies of the password, the scrypt KEK, the DEK, the passkey PRF output and each sealed plaintext (the recovery phrase) stayed in memory. They now go through `withSecretBuffer`, which zero-fills the copy once the call settles (WebCrypto copies its input when called); the PBKDF2 password bytes are wiped too.
- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [f2de8b6]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
- Updated dependencies [f743c06]
- Updated dependencies [9e4bcd2]
- Updated dependencies [9e4bcd2]
- Updated dependencies [9e4bcd2]
- Updated dependencies [9e4bcd2]
- Updated dependencies [eec3745]
  - @anywalletkit/core@0.6.0
  - @anywalletkit/keyring@0.3.6
  - @anywalletkit/wallet-evm@0.3.0
  - @anywalletkit/protocol-swap2-core@0.6.0
  - @anywalletkit/swap2-assets@0.2.1

## 0.1.5

### Patch Changes

- 9dfb5bb: New `pageRequestFrom(event, window)`: a content script's message listener takes a request only when the page window itself posted it (`event.source` is the page and `event.origin` its origin). Without it an iframe on the page (an ad, an embed) could `parent.postMessage` a request that was stamped with the site's origin and shown in the approval window as the site. The example extension's content script uses it.
- a354990: TON and NEAR `sign()` refuse a 32-byte message with `MessageIsTransactionError`: both chains sign transactions over a 32-byte digest (the V5R1 signing-cell hash, sha256(borsh(tx))), so a "message" of those bytes was a valid transaction signature the policies treated as harmless. TON accounts gain `signTonProof` and `signTonConnectData`, which build the TON Connect digests from the request and their own address; the kit treats both as message signatures. extension-kit's `tonProofMessage` / `tonSignDataMessage` are documented as verification helpers.
- Updated dependencies [6dde4e4]
- Updated dependencies [b08c01a]
- Updated dependencies [e9cc028]
- Updated dependencies [a354990]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0
  - @anywalletkit/core@0.5.0
  - @anywalletkit/protocol-swap2-core@0.5.0
  - @anywalletkit/keyring@0.3.5

## 0.1.4

### Patch Changes

- 8aa911d: Audit 2026-10-25 (post-release), low findings L3–L7:
  
  - **backup-cloud (L3).** `iCloudKeychain().getOrCreate` runs one call at a time per keychain item, process-wide. Two at once (a double tap on "back up") both saw no key, both created one, and the second overwrote the key the first backup had just been sealed with, so that file no longer opened without its password. Each caller still gets its own copy of the key.
  - **keyring (L4).** `importMnemonic(phrase, { adoptId })` reads the id once and requires it to hold this phrase and passphrase (`{"type":"mnemonic",…}`). Before, the source took the id unread: the accounts' addresses came from the phrase passed in, while signatures used whatever the id held. A missing, different or unreadable secret is refused with `invalid-input`; a bad or taken id and a phrase already in the keyring are refused before that read (no prompt).
  - **extension-kit (L5).** `Vault.addPasskey` is refused (`invalid-input`) while the vault holds no secret. With nothing to prove the DEK against, any 32 bytes were sealed under the passkey, and every later passkey unlock handed out that wrong key.
  - **core (L6).** `assertNameUnchanged` compares addresses without case only on `eip155:*`. On other chains a case variant of a base58 address is another key, and it passed as "unchanged".
  - **networks (L7).** `rpcUrlsForSync` / `usesUserRpcSync` throw `NetworkError('not-loaded')` before `load()`. They answered from the builtin table, so a client built at cold start used public RPCs the user had turned off (`onlyOwnRpc`), and the review sheet called the RPC not custom. `listSync` / `getSync` still answer builtin-only before `load()`. A failed storage read no longer counts as an empty table: `load()` rejects and stays retryable, and no write runs on top of it (the next write used to replace the user's stored RPCs).
- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
  - @anywalletkit/keyring@0.3.4
  - @anywalletkit/core@0.4.1
  - @anywalletkit/protocol-swap2-core@0.4.1
  - @anywalletkit/swap2-assets@0.1.5

## 0.1.3

### Patch Changes

- 95da085: Security fixes from the 2026-10-25 audit.
  
  - **A lock is never undone.** A `touch()` that read the session record before a `lock()` removed it wrote it back afterwards, leaving the wallet unlocked. `unlock` / `lock` / `touch` / `getKey` / `isUnlocked` now run one at a time, and a touch writes only when no lock happened since its read.
  - **Parallel writes keep every change.** `setSecret`, `deleteSecret`, `addPasskey`, `removePasskey`, `changePassword`, the v1 → v2 upgrade on `unlock`, `create` and `destroy` were read-modify-write without a lock, so two imports at once lost a secret. They are serialized per `Vault` (keep one `Vault` per storage area).
  - **Internal errors stay internal.** `toRelayError` passed any error's message to the dApp page, and viem's messages carry the RPC URL (often with the provider key) and the request body. It now passes `RouterError`, `ReviewDeclined`, a core `UserRejectedError` (4001) and a node's JSON-RPC error (code, node message, revert data) with URLs removed; everything else is `-32603 Internal error`, with the error handed to the new `options.log`.
  - **Bounded KDF and envelope.** An envelope could ask for any scrypt cost or PBKDF2 iteration count, so an edited vault hung or crashed the worker on unlock. New `VAULT_LIMITS` (scrypt N ≤ 2^20, r ≤ 16, p ≤ 4; ≤ 5 000 000 iterations; ≤ 1 000 secrets of ≤ 16 KiB, ≤ 32 passkeys, ≤ 4 MiB envelope) are checked before any KDF runs (`unsupported-envelope`), by the constructor for its options, and before every write.
- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- Updated dependencies [80d6451]
- Updated dependencies [bf2c90f]
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [a9a5e0a]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [c4dc4d6]
- Updated dependencies [ed99146]
  - @anywalletkit/keyring@0.3.3
  - @anywalletkit/core@0.4.0
  - @anywalletkit/protocol-swap2-core@0.4.0
  - @anywalletkit/swap2-assets@0.1.5

## 0.1.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/keyring@0.3.2
  - @anywalletkit/protocol-swap2-core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4

## 0.1.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/keyring@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.1.0

### Minor Changes

- 48855f9: First release: the core of a Chromium (MV3) wallet extension, no UI. Vault envelope v2 (scrypt N=2^17 r=8 p=1 via `@noble/hashes`, AES-256-GCM, KDF parameters bound into the DEK box's AAD, `weak-kdf` refusal, v1 PBKDF2 envelopes re-sealed on unlock, passwords ≥ 8 characters) with passkey unlock (DEK sealed under HKDF-SHA256 of the WebAuthn PRF output); `Session` with auto-lock in `chrome.storage.session`; keyring adapters; page ⇄ content script ⇄ worker relay with sender-origin checks; `RequestRouter`, `PermissionStore`, `ApprovalQueue` (3 pending per origin, one pending `connect`, WalletConnect transport notes via `setVia`); signing classification (SIWE parsing, site EIP-7702 delegations refused), `wallet_addEthereumChain` with `eth_chainId` verification and `custom` provenance; `ReviewGate`, swap and Earn plan review, `SwapTracker`; TON Connect v2 data helpers; `PhishingDetector`, `RecipientBook` (address poisoning), WebAuthn assertion verification; structural chrome adapters with in-memory twins for tests.
- 06cecff: Swap2 status ids decode only under the current `awk1.` prefix. `getSwap2Status`, `claimSwap2` and the extension-kit swap tracker refuse any other prefix as a malformed id; an app still holding ids minted under an earlier prefix maps them to `awk1.` before calling.

### Patch Changes

- d06290f: `personal_sign` runs the EIP-4361 checks on the decoded bytes whenever they are valid UTF-8, not on the hex fallback shown for unprintable text. A sign-in message carrying hidden control characters is refused.
  
  Before, one DEL or form-feed byte turned a cross-site sign-in into an unchecked hex blob, with no cross-site, chain or expiry warning.
- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [f3b164f]
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
- Updated dependencies [0d68fda]
- Updated dependencies [6568e08]
- Updated dependencies [06cecff]
- Updated dependencies [24b888a]
- Updated dependencies [bdc77c2]
- Updated dependencies [4fcb9b6]
- Updated dependencies [d08e37e]
  - @anywalletkit/keyring@0.3.0
  - @anywalletkit/core@0.3.0
  - @anywalletkit/protocol-swap2-core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2
