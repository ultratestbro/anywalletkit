# @anywalletkit/wallet-solana

## 0.5.1

### Patch Changes

- 0ccd063: The default guard signs an SPL stake-pool delayed exit. A stake account the wallet funds counted as the wallet's only when the same transaction initialized it, or split into it, through the Stake program with this wallet as staker and withdrawer, so `protocol-staking-spl-stake-pool-solana`'s delayed exit (`CreateAccountWithSeed` of the slot, then the pool's `WithdrawStake`, which splits pool stake into it and authorizes the user by CPI) was refused with `sets-authority` unless `allowAuthorityChanges` was set. Now the destination of a `WithdrawStake` / `WithdrawStakeWithSlippage` (tag 10 / 24, exact data length) on the SPL Stake Pool program `SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy` that names this wallet as the user stake authority (account 5) counts too. Another authority, another program or another instruction is refused as before; `allowAuthorityChanges` is unchanged. `describeTransaction` names those two instructions (`instruction`) on that program. Checked by a mainnet simulation: the split leaves the account with this wallet as staker and withdrawer and no lockup.

## 0.5.0

### Minor Changes

- 834c24d: A protocol module can no longer reach the private key. On a `Wallet` without `policies`, `getProtocol` handed the module the raw account, and `account.signer.key()` — private in TypeScript only — returned the 32-byte key, a copy of which outlived `dispose()`. Three layers now close it:
  
  - `kit`: a module always gets the restricted account. Without policies it is a wrapper with no rules: no limits, but the signer, internal helpers and the account's settings stay out of reach, as they did with `policies: {}`.
  - `core`: `LocalSigner` reads its key through a function of the module, not a method: nothing outside `@anywalletkit/core` can call it.
  - every chain account keeps its signer in a private field (`#signer`). The new `signerKind` field (`'seed' | 'key' | 'external'`) says what holds the key.
  
  **Breaking:** chain accounts (`WalletAccountEvm`, `WalletAccountSolana`, `WalletAccountTon`, `WalletAccountTron`, `WalletAccountBtc`, `WalletAccountNear`, `WalletAccountZcash`) no longer have a `signer` property, the app's own accounts included. Read `account.signerKind` instead of `account.signer.kind`; keep a reference to the `Signer` you injected if you need it.
  
  **Breaking:** a protocol module registered on a wallet without policies gets the policy wrapper instead of the raw account: it is a different object from `wallet.getAccount(chain)`, and writes through it are refused when they sign on another network than the module's chain.
  
  **Breaking:** `LocalSigner` has no `key()` method at runtime any more (it was private in TypeScript).
- ef2ef84: The CPI guard watches token accounts the transaction creates. `sendTransaction` / `signTransaction` (the simulation that proves what a program the wallet signs for does by CPI) and `checkSerialized` used to read the post-state only of this wallet's token accounts that already existed, so a `CreateAssociatedTokenIdempotent` followed by a program that set a delegate, a close authority or (legacy SPL Token) a new owner on the fresh account by CPI was signed. Now every written account that does not exist yet, or is a bare System account, is asked for too; a token account of this wallet that the transaction creates counts as having had no delegate and no close authority, and this wallet's associated token account created for another owner is refused. `checkSerialized` asks the simulation only for accounts of the transaction (the node returns at most that many); an address outside it keeps its pre-state. `allowAuthorityChanges` still overrides the guard.
  
  **Breaking:** a transaction that leaves a delegate allowance (with no top-level Approve), a close authority, or another owner on a token account of this wallet that it creates is refused with `UnsafeTransactionError` (`approves-delegate` / `sets-authority`) unless `allowAuthorityChanges` is set.

### Patch Changes

- Updated dependencies [834c24d]
  - @anywalletkit/core@0.7.0

## 0.4.0

### Minor Changes

- 3dbee3f: The serialized-transaction guard checks instructions, not only programs and net balances. `SerializedTxGuard.instructions` lists the shapes an operation takes — program, data prefix, optional exact length, and the accounts at given positions, compared after lookup tables are resolved — and any other top-level instruction is refused (`unexpected-instruction`). A Kamino "deposit" of 1 unit that also withdrew the wallet's whole collateral and transferred it away passed before, because the token account's net change stayed within the deposit. Every `SerializedExpectation` bound must now be a non-negative bigint (`invalid-expectation`, refused before any RPC call; a negative minimum read as permission to lose that much), `tokenIn.maxAmount` caps what the wallet may receive (`token-in-excess`), and `getAccountInfos(addresses)` reads raw accounts for modules that check a provider against the chain.
  
  Kamino transactions are checked against the instructions each operation takes, with the wallet, its vanilla obligation, the configured market or vault, the reserve and mint the call names, the wallet's own token accounts and this vault's farm pinned. The guard's bounds come from the chain, read through the account: a vault's share price from its state and the reserves it invests in (the API's `tokensPerShare` must be within 1 %), the wallet's shares from its shares account and farm stake, a Lend `'max'` withdraw or repay from the obligation (debt with the reserve's accrued interest), and the first-deposit allowance from whether the obligation's account exists. The reserve the API names must be this market's and lend the token. A borrow pays out at most what was asked. Figures the API reports are refused when signed (`fromDecimalString` takes no sign) or when they disagree with the chain. **Writes now need an account with `getAccountInfos` — `@anywalletkit/wallet-solana` 0.4 or later.** Vault `withdraw({ amount: 'max' })` passes the exact share count: the API refuses `WITHDRAW_ALL` (now deprecated) as above u64. The live API's obligation list (`obligationAddress`, raw `state`) is read for the obligation's address; its per-token legs are empty in that shape, so `getPosition()` totals come back empty from it. Chain decoders (`decodeVault`, `decodeReserve`, `decodeObligation`, `decodeFarmUser`), `vaultTokensPerShareWad`, `debtNow`, the rule builders (`marketRules`, `vaultRules`) and `associatedTokenAddress` / `farmUserState` are exported.
  
  **Breaking:** Kamino writes and their quotes need an account with `getAccountInfos` — upgrade `wallet-solana` together with the module; an API `tokensPerShare` more than 1 % from the chain's share price is refused; `WITHDRAW_ALL` is deprecated and Kamino's API now refuses it (use the vault's `withdraw({ amount: 'max' })`); `SerializedTxGuard` bounds must be non-negative bigints (`invalid-expectation`). Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

## 0.3.2

### Patch Changes

- 4df03a5: The internal signing helpers (BTC `signPlan` / `signInputs` / `signSpend`, Zcash `signInputs` / `signSpend`, EVM `signHash` / `signPrepared` / `signAndBroadcast`, NEAR `signBytes`, Solana `signChecked` / `signPlan`, TON `signMessages`, Tron `signDigest`) are `#private` methods. They were private only in TypeScript, so code holding an account could call them at runtime and skip the checks the public methods run on what they sign.
- b8a91d6: Solana: `decodeStakeInstruction` no longer guesses an `AuthorizeChecked`, `AuthorizeCheckedWithSeed` or `InitializeChecked` layout when the account that decides it (the Clock or Rent sysvar slot) is unresolved, e.g. loaded from an address lookup table: the new authority (or staker / withdrawer) is left undefined, so the stake guard refuses (`sets-authority`) instead of reading the wallet's own slot as the new authority; the kit marks such an instruction `destinationUnknown`. Zcash: `decodeAddress` refuses an address carrying whitespace or an invisible character (U+FEFF, NBSP…) instead of trimming it, and the kit compares Zcash addresses exactly (base58 is case-sensitive) and marks a recipient that is not plain base58 `destinationUnknown`.

## 0.3.1

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- 5392d40: `@noble/curves` is a dependency. The read-only account imports `@noble/curves/ed25519.js` at runtime, but the package listed it only under `devDependencies`, so an app that did not install it itself (or get it hoisted from another package) failed with "Cannot find module '@noble/curves/ed25519.js'" on import. `pnpm pack:check` now refuses any package whose shipped JavaScript imports a package it does not declare as a dependency, peer or optional dependency.
- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.3.0

### Minor Changes

- d82e140: The policies now see who a write really pays, not only the contract it calls. Recipients and spenders inside standard token calls are destinations: ERC-20 / 721 / 1155 transfers, approve, increaseAllowance, setApprovalForAll, Permit2 approve, an on-chain EIP-2612 permit, ERC-677 transferAndCall; TRC-20 calls (by `parameters` and inside `raw_data_hex`); NEAR `ft_transfer(_call)`, `nft_transfer(_call)`, `storage_deposit` for another account and `deleteAccount` (object and base64 borsh); TON jetton / NFT transfers and burns (destination and excess receiver, from a Cell or `bodyBoc`); SPL transfers, whose recipient is the token account's owner. An allowlist must hold the contract and the recipient. The intent of a single token transfer names its token and amount. wallet-solana gains `getTokenAccountOwner(address)`, which the policies use to read SPL recipients only when a list or `confirm` applies; an owner they cannot read makes the write `destinationUnknown`.
- 86ae0ee: The simulation every send already runs now also guards against what a program the wallet signs for does by CPI, which the top-level checks cannot see. It returns the post-state of the wallet and of its token accounts the transaction writes, and the transaction is refused (`UnsafeTransactionError`) when the wallet's account would be handed to a program or given data (`wallet-owner`), a token account's owner or close authority changes (`sets-authority`), or a delegate allowance appears that no top-level Approve shows (`approves-delegate`). `allowAuthorityChanges` skips it. It costs one extra read per simulated send; a node that does not return the requested post-state is a `NetworkError`. Accounts behind lookup tables in a compiled transaction are resolved for it.
- 86ae0ee: Durable-nonce transactions (first instruction `AdvanceNonceAccount`) never expire, so whoever holds the signature can broadcast it months later. They are now refused by default on every signing path (`sendTransaction`, `signTransaction`, `quoteSendTransaction`, `sendSerialized`, message, compiled or wire form) unless `allowDurableNonce: true` is set in the config or in the call's options (new `SolanaWriteOptions`). `describeTransaction` reports `lifetime: 'blockhash' | 'durable-nonce'` and a `durable-nonce` warning.
- 86ae0ee: `transfer` (and `quoteTransfer`) refuse a recipient that is not a wallet: an account owned by Token / Token-2022 (a token account or a mint) or an executable program. An SPL transfer used to derive the recipient's associated token account from such an address and lock the tokens; SOL sent to a program or a mint is lost. An address with no account yet is still an ordinary wallet. The refusal is `UnsafeTransactionError` with code `recipient-not-wallet`.
- 86ae0ee: `signCompiled` and `signTransactionMessage` now run the same checks as every other signing path: a drainer shape (an authority handed away, the wallet reassigned…), a burn or a durable nonce is refused unless the config or the new `options` argument (`SolanaWriteOptions`) opts in. They stay primitives: no simulation and no fee quote.
- 86ae0ee: `getTokenBalances` reads both programs' associated token accounts, so Token-2022 balances are no longer 0, and only counts an account that holds that mint. `getTokenBalance` reads the mint's program directly: a network error now throws instead of falling back to the legacy program and answering 0; an address that is not a mint is still a 0 balance.

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.2.0

### Minor Changes

- b08c01a: `getTokenInfo(mint)`: decimals, symbol, name, supply and holder-relevant flags read from the chain, for tokens a user adds by address. Name and symbol come from the Token-2022 metadata extension, else the Metaplex metadata account. Flags: a live mint or freeze authority, and the Token-2022 extensions that let someone move any balance (permanent delegate), tax transfers (non-zero transfer fee), run a hook, freeze new accounts, pause transfers or make the token non-transferable. Anything that is not an initialized Token / Token-2022 mint throws `NotATokenError`. Checked against mainnet USDC, PYUSD, BONK, JUP and a fee-bearing Token-2022 mint.

### Patch Changes

- cc63ef0: The Stake guard judges every Stake instruction that names the wallet, whatever the wallet's position: the Stake program takes authorities from any signer and has a layout without sysvars (`[stake, authority]`, `[stake, recipient, authority]`), so an `Authorize` / `Withdraw` / `SetLockup` with the wallet at another index is no longer signed. The `Checked` forms read the new authority, staker and withdrawer in both layouts. A stake account the wallet only splits into is accepted with at most 0.005 SOL of the wallet's funding (its rent), since a split copies the source's authorities.
- 3f10000: wallet-solana's signing guard reads the Stake program: it refuses a Stake `Authorize*` to another key, a `Withdraw` to anyone but the wallet, a `SetLockup*` with a foreign custodian or a lockup, and funding a stake account that the same transaction does not initialize (or split into) with the wallet as staker and withdrawer (`allowAuthorityChanges` overrides). It now signs taking back a pre-funded seed slot (`AllocateWithSeed` of a 200-byte Stake account the same transaction initializes for the wallet), so dust sent to every `stake:<i>` address no longer blocks native staking. `describeTransaction` names Stake instructions and what they set (`stake`, `withSeed` on program-call items); `decodeStakeInstruction` and `STAKE_PROGRAM_ADDRESS` are exported.
- 2d9fe4b: One external ed25519 key registered for several chains can no longer be made to sign another chain's transaction as a "message": TON and NEAR `sign()` refuse bytes that carry the account's public key (a Solana transaction names its signer's key), and Solana `sign()` on an external signer refuses 32-byte messages (a TON or NEAR transaction digest). TON Connect `signData` binary payloads accept whitespace in their base64, as `atob` does, and a non-integer `workChain` is refused.
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.1.6

### Patch Changes

- 8aa911d: `policies.maxFee` reaches `approve` (EVM) and `sendSerialized` (Solana) too. It reached only `sendTransaction`, `signTransaction` and `transfer`; an approval or a provider-built Solana transaction paid whatever fee it carried. The kit now hands those two the tightest cap as `WriteOptions.maxFee` (second argument of `approve`, third of `sendSerialized`; a tighter caller cap stays), and the accounts hold it on what they sign: wallet-evm's `approve(options, writeOptions?)` passes it to each transaction it sends (the USDT reset too), wallet-solana's `sendSerialized(base64, guard, options?)` checks the proven fee against the tighter of `transactionMaxFee` and `options.maxFee`. The kit README now lists which writes the cap covers, and no longer calls raw `approve(spender, 0)` a revoke. Audit 2026-10-25 (post-release), L2.
- 8aa911d: A Solana send whose outcome is unknown throws `BroadcastUnknownError` (`maybeSent: true`, `hash` = the transaction signature, computed locally), like EVM, Tron and NEAR. A timeout, a dropped connection, an HTTP error, an internal RPC error, or a refusal after another provider went unanswered all surfaced as generic errors, so a caller that planned again signed a second transaction with a new blockhash that could also land. A refusal (a JSON-RPC answer: preflight failure, bad signature, unhealthy node; or an HTTP 4xx other than 408: rate limit, auth) stays a clean failure. A provider list now fails over a refused broadcast too, with the same signed bytes. New `timeoutMs` in `SolanaConfig` (default 15 000 ms) bounds every request to a url provider (`AbortSignal.timeout`, a timer fallback where the runtime lacks it); a read that times out is a `NetworkError`, and a hung RPC no longer hangs the wallet. The Rpc `createRpc` returns is not a thenable (`await createRpc(...)` and an async function returning it settle, for a list too) and keeps kit's pending-request surface (`reactiveStore`). swap2 reports such a send as `Swap2MaybeSentError`. Audit 2026-10-25 (post-release), M3.
- 8aa911d: `sendTransaction` / `signTransaction` / `quoteSendTransaction` refuse the drainer shapes `sendSerialized` already refused, for every input form (kit message, kit `Transaction`, base64 wire): System `Assign` / `Allocate` / `AssignWithSeed` / `AllocateWithSeed` touching this wallet's account, a `CreateAccount` / `CreateAccountAllowPrefund` whose new account is this wallet (paying for another account is fine), `AuthorizeNonceAccount` by this wallet, a Token / Token-2022 `SetAuthority` / `UpdateTokenMetadataUpdateAuthority` / `UpdateTokenGroupUpdateAuthority`, a token `Batch` (its inner instructions are not checked), lamports moved by an instruction the description does not show as a transfer (`CloseAccount`, `WithdrawExcessLamports`, `UnwrapLamports`, `WithdrawNonceAccount`, `TransferSolWithSeed`) to anyone but this wallet, and an undecodable System / Token instruction. They throw `UnsafeTransactionError` (`code`: `core-instruction`, `sets-authority`, `closes-account`, `moves-lamports`) before anything is signed. A program the wallet signs for can still do these by CPI; `sendSerialized` proves the outcome by simulation instead. An instruction whose accounts sit in a lookup table that was not resolved is judged by its name (`describeTransaction` now reports `instruction` on such `unknown` items), so a close whose destination hides in a table is refused too. Everyday shapes still sign: transfers, burns, closes to this wallet, durable nonces, `Allocate` + `Assign` of a fresh co-signer account. New `allowAuthorityChanges` in `SolanaConfig` opts the general path out (a token launch that renounces its mint authority); `sendSerialized` stays strict regardless. Audit 2026-10-25 (post-release), H1. `describeTransaction` now decodes `CreateAccountWithSeed` as a `create-account` item (payer, derived account, lamports, owner) instead of an opaque program call.
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.1.5

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: No signing account outlives `WalletManager.dispose()`. Every chain manager awaited between its cache check and storing the account, so: an account whose build was in flight during `dispose()` was created afterwards with a live key (a child derived from an injected seed signer kept signing); concurrent `getAccount` calls for one path built two accounts and leaked the first; a signer-built manager handed out new accounts after `dispose()`. New protected `cachedAccount()` / `signerAccount()` in core build each account once, refuse after dispose, dispose an account finished late and a derived child that never became an account. All seven chain managers use them. `describeChainModule` checks the contract (one account under concurrent calls, none after dispose). Audit 2026-10-25, #3.
- 80d6451: `policies.maxFee` now holds for the transaction that is signed, not only for the quote. The kit compared the cap with `quoteSendTransaction` (an EVM estimate of 21 000 gas) while the account signed its own gas limit with headroom (25 200 gas), so a 22 000 000 wei cap let a 25 200 000 wei transaction through. New `WriteOptions { maxFee }` in core is an optional second argument of `sendTransaction`, `signTransaction` and `transfer`; every chain package checks the tighter of it and its configured `transactionMaxFee` / `transferMaxFee` on what it signs (`feeLimit()` helper), and the kit passes the tightest matching policy cap through it after the quote check. A write whose quote fits but whose signed worst case does not is now refused by the account after `confirm`, with the chain package's own error (EVM: `Error('Exceeded maximum fee cost…')`), not `PolicyViolationError`. Audit 2026-10-25, #4.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0

## 0.1.4

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.1.3

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

## 0.1.2

### Patch Changes

- 5d7976e: Security audit 2026-10-13 fixes that had stayed on a side branch: Solana provider-tx guard refuses System Assign/Allocate, Token Batch and undecodable core instructions and checks ownership/authority in the post-state (F1, F2); tx-preview flags native value to unlabeled contracts and unverified token symbols (F5); approvals gets a strict `isRevokeCalldata` and a new `isRevokeTransaction` (F8); kit `applyPolicies` resolves or refuses an unknown EVM chain (F4); NEAR caps token storage deposits (F12); TON checks the jetton wallet's owner and master (F13); EVM signing detects the chain before the mismatch check and strips EIP-712 array types linearly (F16, F17); near-intents strips control characters from logs (F18).
- 4b6d97f: No secret is an object property anywhere. `Wallet` no longer keeps the seed phrase string: it turns the phrase into the 64-byte seed in the constructor, hands each chain manager a copy, and `dispose()` zeroizes it and refuses later calls; `new Wallet(seedBytes)` and managers built from seed bytes are accepted (copied). `LocalSigner` keys and seeds and `WalletManager` seeds live in module WeakMaps, so `console.log`, `JSON.stringify`, `util.inspect` and crash reporters see only public fields; `LocalSigner.toJSON()` is the public view. Accounts get leaf signers (`LocalSigner.leafFromSeed`, `deriveLeaf`) that hold only their own key, never a copy of the master seed. Before: `JSON.stringify(account)` contained the private key and the master seed, and `console.log(wallet)` printed the phrase. The conformance chain suite now walks every property reachable from a manager and an account and fails if a key, the seed or the phrase is found. Manager constructors take `string | Uint8Array | Signer`.
- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- f54f2cd: `WalletAccountSolana.sign` refuses, with `MessageIsTransactionError`, any "message" whose bytes decode exactly (every byte consumed) as a legacy / v0 / v1 compiled transaction message, or as a wire transaction, that lists this account among its required signers — such a signature would be a valid on-chain transaction approved without transaction review. Everything else is signed raw exactly as before (text, nonces, `\xffsolana offchain`-prefixed messages, transactions where this key is not a required signer). New exports: `isSolanaTransactionPayload(bytes, signer)`, `classifySolanaMessage(bytes, signer)` (`'transaction' | 'offchain' | 'text' | 'binary'`, for approval UIs), `hasSolanaOffchainHeader`, `isReadableText`, `SOLANA_OFFCHAIN_MESSAGE_PREFIX`.
- 6a78e14: New provider `@anywalletkit/protocol-swap2-jupiter`: same-chain Solana swaps through Jupiter's Swap API V2 Router path (`GET /swap/v2/build`, Metis routing, no Jupiter swap fee; keyless at 0.5 RPS or an `apiKey` sent as `x-api-key`). Nothing from the API is used unchecked: only Jupiter v6 and token / system / ATA / compute-budget instructions, the taker as the only signer, no tip, and the swap instruction's own arguments (`route_v2` / `shared_accounts_route_v2`) decoded — input amount, quoted output, slippage and a zero platform fee must equal the request. The v0 transaction is assembled locally with the response's lookup tables; the compute budget is ours (limit = 1.2× a simulation when `rpcUrls` is given, price capped by `maxComputeUnitPrice`). The account executes it through its serialized-transaction guard and its own RPC.
  
  `wallet-solana`: the serialized-transaction guard counts the wallet's own wrapped-SOL token accounts as its SOL. Aggregator routes close the wallet's wSOL account, which also unwraps wSOL the wallet already held; that used to be refused as a token drain (live 2026-10-23: every large mainnet wallet probed held some wSOL), and a SOL output could not tell the wallet's own unwrapped wSOL from swap proceeds — now both are exact.
  
  `conformance`: `createMockAccount({serialized: true})` exposes swap2's `sendSerializedTransaction` hook; the swap2 behaviour suite checks serialized legs (the fixture's `serialized` decoder must accept what would be signed, and the account must execute exactly the reviewed bytes with the engine's balance expectation).
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.1.1

### Patch Changes

- 82464d8: `WalletManager` keeps the 64-byte seed, never the mnemonic string: a phrase passed to a constructor is stretched there and dropped (strings cannot be zeroized, `Uint8Array`s can). Chain managers read it through `seedBytes()`; the base `dispose()` zeroizes it.
- 5993b62: A structured simulation error is named instead of crashing the error formatter. `@solana/kit` parses every JSON integer in an RPC response as a bigint, so `{InstructionError: [2n, {Custom: 6001n}]}` made the plain `JSON.stringify` throw "Do not know how to serialize a BigInt" — and that message replaced the real on-chain failure (Solana USDe → SOL via LI.FI in the Oct 16 funded run). Both `simulateWire` and the serialized-transaction check now format the error with a bigint-safe replacer (SDK-134).
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @anywalletkit/core@0.2.0

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
