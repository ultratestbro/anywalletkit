# @forgewallet/extension-kit

The security-relevant core of a non-custodial Chromium (MV3) wallet extension,
built on the forgewallet chain and protocol packages: an encrypted vault, the
unlocked-key session with auto-lock, the dApp request router with per-origin
permissions and an approval queue, signing-request classification, and the
review helpers for swaps and Earn plans. No UI, no `@types/chrome`, no network
code of its own: the chrome adapters take structural objects
(`StorageAreaLike`, `AlarmsLike`), so everything runs under Vitest with
in-memory adapters.

This package is for wallet developers who build their own extension. It is a
library, not an extension: the popup, approval windows, injected providers,
service-worker wiring, build and release pipeline are the wallet's. The Vaulty
browser extension is one product built on it.

```sh
pnpm add @forgewallet/extension-kit @forgewallet/core @forgewallet/keyring
```

## What it provides

| Area | Exports | What |
| --- | --- | --- |
| Vault | `Vault`, `chromeLocalVaultStorage`, `memoryVaultStorage`, `VAULT_SCRYPT`, `VAULT_MIN_PASSWORD_LENGTH` | every secret at rest in `chrome.storage.local`, two key layers (a KEK wraps a DEK, the DEK seals each secret); passkey (WebAuthn PRF) unlock as a second wrap of the same DEK |
| Session | `Session`, `chromeSessionStorage`, `chromeAlarms`, `SESSION_DEFAULT_AUTOLOCK_MS` | the DEK in `chrome.storage.session` with an expiry and an alarm; `getKey()` re-checks the expiry itself |
| Keyring adapters | `chromeKeyringStorage`, `vaultSecretStorage` | `@forgewallet/keyring` metadata as plain JSON, secrets through the vault, one DEK use per call |
| Relay | `PageRequest` / `RelayRequest` shapes and guards, `stampOrigin`, `checkSenderOrigin`, `RELAY_ERRORS` | page ⇄ content script ⇄ service worker messages; the origin is the browser's (`port.sender`), never the page's |
| Router | `RequestRouter`, `READ_METHODS`, `SIGNING_METHODS` | what a dApp may call: accounts only for connected origins, chain add / switch through the approval window, reads from the wallet's own RPCs, `eth_sign` never offered, everything else 4200 |
| Permissions | `PermissionStore`, `CHAIN_ACCOUNT_KEYS` | per-origin accounts (EVM, Solana, TON, Tron, Bitcoin, NEAR) and chain |
| Approvals | `ApprovalQueue`, `ReviewDeclined`, `QueueLimitError`, `APPROVALS_MAX_PENDING_PER_ORIGIN` | one approval window at a time, at most 3 pending requests per origin and one pending `connect`; transport notes (`setVia`) for WalletConnect peers |
| Signing | `classifySignRequest`, `prepareTransaction`, `createSignHandler`, `messageText` | connected-address and chain checks, EIP-7702 delegations from sites refused, nonce / gas / fees from the wallet's RPC |
| Networks | `NetworksTable`, `DEFAULT_NETWORKS`, `parseAddChainParams`, Solana / TON / Tron endpoints | EVM networks with public RPC failover lists; `wallet_addEthereumChain` only for catalog chains, https only, `eth_chainId` verified, site-supplied RPCs stamped `custom` |
| Review gate | `ReviewGate`, `evmCallMatcher`, `chainTxMatcher` | after one sheet reviewed a whole plan, exactly those operations pass once within a TTL |
| Swaps | `quoteRoutes`, `reviewSwapPlan`, `executionFloor`, `SwapsStore`, `SwapTracker`, `parseSwapId` | progressive quotes over swap2 providers, one review sheet per plan, pending swaps resumed across worker restarts |
| Earn | `reviewEarnPlan`, `earnPlanMatchers` | one sheet for an Earn module's plan (approvals + call) |
| TON Connect | `parseConnectRequest`, `parseSendTransaction`, `parseSignData`, `tonProofMessage`, `tonSignDataMessage` | the pure-data half of TON Connect v2 (the bytes `ton_proof` and `signData` sign) |
| Phishing | `PhishingDetector` | MetaMask `eth-phishing-detect` list format, shipped with the build (never fetched at runtime), fuzzy lookalikes, brand-in-label, punycode |
| SIWE | `parseSiwe`, `siweProblems`, `describeSiwe` | EIP-4361 sign-in messages: domain vs. the asking site, address, chain, expiry, nonce (warnings) |
| Address poisoning | `lookalikeOf`, `RecipientBook` | warns when a new recipient imitates one the user confirmed |
| WebAuthn | `verifyAssertion`, `approvalChallenge`, `derToRaw`, `rawToDer` | ES256 assertion check for "passkey on every signature"; the worker never trusts the page's word |

## Security model (summary)

- **Keys at rest.** Envelope v2: scrypt N=2^17 r=8 p=1 (`@noble/hashes`) →
  AES-256-GCM wraps a random 32-byte DEK; the DEK seals each secret under AAD
  `forgewallet-vault/secret/<id>` (boxes cannot be swapped). The DEK box's AAD
  binds the exact KDF parameters, so an envelope whose salt or cost was edited
  on disk fails to open; `unlock` refuses sub-floor costs (`weak-kdf`). v1
  envelopes (PBKDF2-SHA256, ≥ 600 000 iterations) still open and are re-sealed
  as v2. Passwords shorter than 8 characters are refused by the vault itself.
  Wrong password and tampering are the same failure (`wrong-password`).
  `create` never overwrites; reset is an explicit `destroy()`.
- **Passkeys.** A passkey wraps the same DEK under HKDF-SHA256(PRF output,
  salt = credential id); the password stays the recovery path.
- **Unlocked state.** Only the DEK is kept, in `chrome.storage.session`
  (memory-only, trusted contexts), with an expiry enforced on every read and an
  alarm that locks; key buffers this package owns are zeroized after use.
- **Origins.** The service worker answers a relay message only when the
  content script's stamped origin equals `port.sender.origin`. Permissions are
  keyed by that origin, never by a URL a page or a WalletConnect peer claims.
- **Requests.** Everything that reveals accounts or moves funds goes through
  the approval queue; blind signing (`eth_sign`) is not offered; typed data for
  another chain, deployments and site-originated EIP-7702 delegations are
  refused; read-only RPC goes to the wallet's own endpoints.
- **Network.** The kit makes no requests of its own beyond the RPC / provider
  calls the wallet wires in; the phishing list is data the wallet ships.

What stays the wallet's job: the extension-page CSP (`script-src 'self'`, no
remote images), a host allowlist for the worker's `fetch`, isolating third-party
network SDKs (WalletConnect, Omniston) in a sandbox page, the reproducible
release build and the store account.

## Using the chrome adapters

```ts
import {
  Vault, Session, PermissionStore, NetworksTable, ApprovalQueue, RequestRouter,
  chromeLocalVaultStorage, chromeSessionStorage, chromeAlarms, chromeJsonStorage,
  chromeKeyringStorage, vaultSecretStorage, checkSenderOrigin, isRelayRequest, PORT_NAME,
} from '@forgewallet/extension-kit'

// service worker
const vault = new Vault({ storage: chromeLocalVaultStorage(chrome.storage.local) })
const session = new Session({ storage: chromeSessionStorage(chrome.storage.session), alarms: chromeAlarms(chrome.alarms) })

// onboarding
const dek = await vault.create(password)          // refuses if a vault exists or the password is too short
await vault.setSecret(dek, 'main', utf8(seedPhrase))
await session.unlock(dek)                         // dek is zeroized here

// @forgewallet/keyring on top of the vault
const keyringStorage = chromeKeyringStorage(chrome.storage.local)
const secrets = vaultSecretStorage(vault, session) // VaultError('locked') once the session expired

// the dApp side
const permissions = new PermissionStore(chromeJsonStorage(chrome.storage.local, 'my-wallet.permissions'))
const networks = new NetworksTable(chromeJsonStorage(chrome.storage.local, 'my-wallet.networks'))
const approvals = new ApprovalQueue(myApprovalWindow) // chrome.windows.create({ type: 'popup' }) behind ApprovalWindow
const router = new RequestRouter({ permissions, networks, approvals, accounts, rpc, emit, sign })

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return
  port.onMessage.addListener(async (msg) => {
    if (!isRelayRequest(msg)) return
    const origin = checkSenderOrigin(port.sender, msg.origin)
    if (!origin) return // forged origin: dropped, not answered
    const result = await router.handle(origin, msg.chain, msg.method, msg.params)
    // post a RelayResponse { kind: 'response', id: msg.id, … } back on the port
  })
})
```

`memoryVaultStorage`, `memorySessionStorage`, `memoryAlarms`,
`memoryJsonStorage` and `memoryApprovalWindow` are the in-memory twins for tests.
