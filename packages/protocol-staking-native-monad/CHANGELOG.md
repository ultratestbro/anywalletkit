# @anywalletkit/protocol-staking-native-monad

## 0.2.2

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

## 0.2.1

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.2.0

### Minor Changes

- f5315d6: Pending withdrawals are found in every slot. The default `'gap'` scan stopped 32 empty slots past the last used one, so a pending slot above a run of claimed ones (withdrawals 0–39 with 0–35 claimed) was never listed or claimed. The new default `withdrawScan: 'multicall'` reads every slot up to `maxWithdrawId` in one `eth_call` through Multicall3 (deployed on Monad; `multicallAddress` to override), falling back to one call per slot when that fails. `'gap'` stays as an explicit, documented trade-off. (Finding the slots from `Undelegate` logs was not an option: the Monad RPC caps `eth_getLogs` at 1 000 blocks, about 7 minutes.)
- f5315d6: Rewards left at a validator after a full exit stay visible. Positions came from `getDelegations` only, which drops a validator once the wallet's stake there is zero, so unclaimed rewards there vanished from `listPositions` / `getStakedBalance`. Positions now come from the delegations, the configured validators, the ones this instance unstaked from, and the new `listPositions({ validators })`; a validator with rewards > 0 is kept.

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.1.1

### Patch Changes

- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.1.0

### Minor Changes

- e009044: New module: native MON staking on Monad through the staking precompile (`0x…1000`), to the validators the app lists.
  
  - **Validators are the app's choice.** `validators` is required (ids, optionally named), or `'any'` for wallets whose users pick from the active set; there is no default list. Before every delegation and compound the validator is read live and refused when it is not listed, does not exist, is outside the consensus set or flagged (unless `allowInactive`), or charges more than `maxCommission` (10 % by default; both the current and the upcoming commission are checked). `listValidators()` / `getValidator()` return stake, commission, standing, an APR estimate (18 MON × blocks per year ÷ consensus stake × (1 − commission), block time measured on chain) and the reasons a validator is not eligible; an `enrich` hook can add an explorer's APR or names.
  - **Operations**: `stake` (`delegate` with the amount as value; active at n+1, or n+2 after the boundary block), `requestWithdrawal` (`undelegate` of active stake into the lowest free withdrawal slot), `claimWithdrawals` (one `withdraw` per ready request; ids pack `validatorId << 8 | withdrawId`), `compound`, `claimRewards`. Every write has a `quote*` twin, and every write is simulated with `eth_call` first, with the precompile's revert strings turned into plain words.
  - **Monad specifics handled**: the 10 MON reserve balance (a stake never leaves less, `getMaxStakeable()`), the 1 gwei minimum, epoch timing from `getEpoch()` (never block arithmetic), pagination that follows `nextValId` / `nextIndex` (pages are shorter than 100), withdrawals opening one epoch after the stake deactivates, the account and the read RPC both checked to be on Monad.
  - **Reads**: `listPositions` (active, activating, activating next, unclaimed rewards per validator), `getStakedBalance`, `getWithdrawalRequests({ validator?, validators? })`, `getEpoch`, `getNetworkStats`, `nextWithdrawId`. Withdrawal slots are read with a gap scan (until 32 empty slots past the last used one; `withdrawScan: 'full'` reads all 256). After a full exit the precompile drops the validator from `getDelegations`; the module still looks at listed validators, the ones it undelegated from, and those passed in `validators`, and `claimWithdrawals({ ids })` always works. Every write decision reads the validator fresh; display reads are cached a minute and never pull the ~200 network-stat reads into positions or writes.
  - **Activity**: `describeActivity` labels delegate / undelegate (with the amount) / withdraw / compound / claimRewards sent to the precompile, with the validator's configured name, and reads withdrawal and reward amounts from the receipt when the history source kept it.
  - Checked on Monad mainnet: selectors, struct layouts and revert strings against the live precompile, every write simulated as real delegators (`scripts/verify-live.mjs`). Runs under Hermes.
