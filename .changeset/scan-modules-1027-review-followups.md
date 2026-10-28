---
"@anywalletkit/tokens": patch
"@anywalletkit/networks": patch
"@anywalletkit/names-ens": patch
"@anywalletkit/protocol-approvals-evm": patch
"@anywalletkit/protocol-lending-mellow-evm": patch
"@anywalletkit/protocol-swap2-core": patch
"@anywalletkit/protocol-swap2-omniston": patch
"@anywalletkit/wallet-evm": patch
"@anywalletkit/protocol-lending-aave-evm": patch
"@anywalletkit/protocol-lending-morpho-evm": patch
"@anywalletkit/protocol-staking-lido-evm": patch
"@anywalletkit/protocol-staking-ssv-evm": patch
"@anywalletkit/protocol-staking-native-monad": patch
"@anywalletkit/protocol-swap2-cctp": patch
"@anywalletkit/protocol-swap2-usdt0": patch
---

Follow-ups from a review of the modules-scan fixes against the code (2026-10-28).
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
