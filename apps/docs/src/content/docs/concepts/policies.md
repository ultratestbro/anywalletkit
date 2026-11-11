---
title: Policies
description: Fee caps, allow and block lists, and a confirmation hook that run before every signature and broadcast.
sidebar:
  order: 3
---

Policies are rules that run **before** anything is signed or broadcast. You pass them when
you create the `Wallet`. Every account it hands out is wrapped in them, including the
accounts protocol modules use for swaps, staking or lending, so a module cannot skip them.

```ts
const wallet = new Wallet(seedPhrase, {
  policies: {
    maxFee: { 'eip155:1': 5_000_000_000_000_000n },          // 0.005 ETH
    allowlist: { 'tron:0x2b6653dc': [TREASURY_ADDRESS] },
    blocklist: { 'eip155:1': [KNOWN_SCAM_ADDRESS] },
    confirm: async (intent) => showConfirmationSheet(intent), // true = go, false = cancel
  },
})
```

## Rules

| Rule | Keyed by | Throws |
|---|---|---|
| `maxFee` | chain id or namespace → cap in native base units | `PolicyViolationError` (`policy: 'maxFee'`) |
| `allowlist` | chain id or namespace → destinations; anything else is refused | `PolicyViolationError` (`policy: 'allowlist'`) |
| `blocklist` | chain id or namespace → destinations that are refused | `PolicyViolationError` (`policy: 'blocklist'`) |
| `confirm` | one function for every write | `UserRejectedError` when it returns `false` |

Address comparison ignores letter case.

## What is guarded

Every method that produces a signature or a broadcast: `transfer`, `sendTransaction`,
`signTransaction`, `sign`, the approval surfaces `approve`, `signPermit` and
`signTypedData` (an EIP-2612 `Permit` or a Permit2 message is an approval: the lists check
the **spender**, and `confirm` receives `kind: 'approval'` with `unlimited` and `deadline`;
typed data that moves value by itself is a send judged by whom it pays: EIP-3009
`TransferWithAuthorization` / `ReceiveWithAuthorization` (`to`, with the verifying contract as
the token), an ERC-2771 `ForwardRequest` and a `MetaTransaction` (the call they make, read like
a transaction), a 1inch LOP `Order` (the settlement contract, and a `receiver` other than the
maker). Any other typed data is `kind: 'typedData'` with `destinationUnknown: true`, because the
policies cannot tell whether it moves value: an allowlist refuses it, and so does a blocklist
without a `confirm` hook. A blocklisted `verifyingContract` is refused for all typed data), plus chain-specific write
methods (Tron's `signRaw`, NEAR's `signBuilt` and `signNep413`, Solana's `sendSerialized`,
`signCompiled`, `signTransactionMessage`, swap2's `sendSerializedTransaction`). The rule is deny-by-default: any other account
method whose name starts with `sign`, `send`, `approve`, `revoke` or `transfer` is refused
behind the wrapper (`PolicyViolationError`, `policy: 'method'`) unless it is listed in
`UNGUARDED_WRITES` (only NEAR's `transferActions`, which signs nothing), so a new signing
method in a chain package cannot bypass the policies. Reads (balances, quotes, receipts)
are never affected.

### Destinations

The lists check every destination a write names, not only the contract it calls:

- **EVM**: the contract, plus the recipient or spender inside a standard token call: ERC-20,
  ERC-721 and ERC-1155 transfers, `approve`, `increaseAllowance`, `setApprovalForAll`,
  Permit2 `approve`, an on-chain EIP-2612 `permit`, ERC-677 `transferAndCall`. Any other
  call is judged by the contract it calls.
- **Tron**: the same for TRC-20 calls, whether built from `parameters` or prebuilt
  (`raw_data_hex`).
- **NEAR**: the receiver, plus who `ft_transfer(_call)`, `nft_transfer(_call)` and
  `storage_deposit` pay and the beneficiary of `deleteAccount`.
- **TON**: each message's target, plus a jetton or NFT transfer's destination and excess
  receiver.
- **Solana**: the recipient of a SOL transfer; for an SPL transfer, the **owner** of the token
  account it pays (read through the account when a list or `confirm` applies); for a Stake
  instruction, whom it pays or empowers (a `Withdraw` recipient, a new authority, the staker
  and withdrawer, the vote account, the destination stake account), never the Stake program.

An allowlist must hold **all** of them. When part of a write cannot be read, the intent has
`destinationUnknown: true`: an allowlist refuses it, and so does a blocklist without a
`confirm` hook. `transfer` is judged by `recipient`, the field every chain pays. A TON jetton
`transfer` also spends TON, so it is judged on the jetton master (it names the contract that
receives `attachedValue`) and on a `responseDestination` other than the wallet itself (it gets
the excess); a forward or custom payload cell makes it `destinationUnknown`, and `confirm`
receives `attachedValue` and `forwardTonAmount`. wallet-ton itself refuses a foreign
`responseDestination` unless `allowForeignResponseDestination` is set, and more than
`maxJettonAttachedValue` (1 TON by default) attached.

The checks and the signature work from one copy of the arguments, taken before the first check,
and `confirm` gets a copy of its own: nothing can change what is signed after it was judged.

### Blind hash signatures

32 bytes signed behind the EIP-191 prefix may be an order or a transfer: CoW Protocol's `ethsign`
orders and Safe owner signatures (v > 30) accept a digest signed that way. So an EVM `sign` that
may be one is not a plain message but `kind: 'typedData'` with `blindHash: true` and
`destinationUnknown: true`. `confirm` should make it a danger screen with **Reject** and
**Sign anyway**. `blindHashForm` (type `EvmSignBlindHashForm`) says how it came:

| `blindHashForm` | Argument |
|---|---|
| `'bytes'` | a 32-byte `Uint8Array` |
| `'hex'` | a `0x` + 64-hex string, flagged by its shape: it is how a dApp sends a digest. The account is handed the string; wallet-evm signs its UTF-8, the 66 bytes of those characters, not the 32 bytes they spell. Another signer may decode it to the 32 bytes |
| `'text'` | any other string whose UTF-8 encoding is 32 bytes: 16 accented letters, 8 emoji, 32 ASCII characters. A site can grind an order until its digest is valid UTF-8 and send it as text: "This looks like a hidden hash. Signing it may authorize a transfer or an order." |

What the lists do with it:

| | no `confirm` | with `confirm` |
|---|---|---|
| no lists | signed | `confirm` decides |
| allowlist | refused (`allowlist`) | `'text'`: `confirm` decides; `'hex'`, `'bytes'`: refused (`allowlist`), `confirm` never sees it |
| blocklist | refused (`blocklist`) | `confirm` decides |

Like typed data it needs the account's chain when an exact-id rule of the family could be the
account's own: an account that reports `eip155:unknown` learns its chain id from its RPC first,
and an offline one is refused (`chain`) — see [Which chain's rules apply](#which-chains-rules-apply).
The account's namespace decides that a `sign` is an EVM one, and that the `eip155` rules judge it,
not the spelling of the chain it was asked for (`eip155`, `eip155:1`, a registration key).

The length is counted in UTF-8 bytes, not characters: 32 characters with one `é` are 33 bytes
and stay a message. The account is handed the string as it came, so an external signer shows it
as text, and a `Uint8Array` as a plain `Uint8Array` copy of the bytes that were counted (a Node
`Buffer` arrives as a `Uint8Array`). The kit counts a string's UTF-8 with its own reading of it,
the signer encodes it with the runtime's `TextEncoder`. The two agree on every well-formed string,
so a string with a lone surrogate (a UTF-16 unit U+D800–U+DFFF that is not half of a pair) is
refused with `PolicyViolationError('method')` before any rule: the `TextEncoder` polyfill of the
Hermes setup reads some of them as other bytes than the spec, and can turn 33 counted bytes into
32 signed ones. An EVM `sign` takes a string or a `Uint8Array` (from any realm, a subclass, a Node
`Buffer` too); anything else is refused with `PolicyViolationError('method')`. Both refusals hold
for every EVM account behind the policies, with no rule set too: every account of a `Wallet`
created with `policies`, and every account a protocol module is given.

### Revokes

Taking an approval back moves nothing, so a revoke is its own kind: `kind: 'revoke'`. This
covers an `approve`, `signPermit` or EIP-2612 `Permit` of 0, the revoke calls sent as raw
calldata (`approve(spender, 0)`, `approve(0x0, tokenId)`, `setApprovalForAll(operator, false)`,
Permit2 `lockdown`, or a batch made only of these), and `revokeDelegation()`.

A revoke skips the allowlist and the spender's blocklist entry, so the user can always take an
allowance back from a known drainer. The blocklist still applies to the contract the revoke
calls (the token, the NFT collection, Permit2). The fee cap and `confirm` apply as usual.
`confirm` gets `revokes: [{ token, spender }]` to show what is being revoked.

For each write the checks run in this order:

1. **Fee cap.** The account quotes the fee, and anything above the cap is refused (for
   `transfer`, `sendTransaction`, `signTransaction`). The cap is then handed to the account,
   which holds it on what it signs; `approve`, `sendSerialized`, `signRaw`,
   `revokeDelegation` and `sendSerializedTransaction` get it the same way. A write that pays a
   fee but cannot take a cap (`signBuilt`, `signCompiled`, `signTransactionMessage`) is refused
   under one.
2. **Allow and block lists.** These check the destination. They are skipped for message
   signatures, where nothing moves.
3. **`confirm`.** It receives a `WriteIntent` and has the last word.
4. Only then is the original call made.

## `WriteIntent`

What `confirm` receives:

| Field | Meaning |
|---|---|
| `chain` | CAIP-2 id |
| `from` | The account's address |
| `method` | `transfer`, `sendTransaction`, `sign`… |
| `kind` | `send`, `approval`, `revoke`, `typedData` or `message` |
| `to` | Destination, when it can be read off the call (a `transfer`'s recipient, the contract called, an approval's spender) |
| `destinations` | Every destination the lists check (see above) |
| `destinationUnknown` | Part of the write could not be read: `destinations` may be incomplete |
| `token` | Token identifier for token transfers and approvals (a calldata transfer's token too); `undefined` means the native coin |
| `amount` | Amount in base units, when it can be read off the call |
| `unlimited` | Approvals: type(uint128).max or above, a DAI-style `allowed`, or an amount that cannot be read |
| `approvals` | Approvals: every token a signature grants (a Permit2 batch has several) |
| `message` | `true` for message signatures |
| `blindHash` | EVM `sign` that may be a blind hash (32 bytes, or the `0x` + 64-hex form): show a danger screen (see above) |
| `blindHashForm` | With `blindHash`: `'bytes'`, `'hex'` or `'text'` |
| `raw` | The original argument, for anything else you need |

## Which chain's rules apply

The rules of the chain id you asked for (`wallet.getAccount('eip155:1')`) **and** of the
chain the account reports both apply. An EVM account that has not talked to its RPC yet
reports `eip155:unknown`, and your `eip155:1` rules still cover it.

A key can also be a namespace: `eip155` covers every EVM chain, `solana` every Solana
cluster. Namespace rules and exact-id rules add up:

- `maxFee`: every matching cap is checked, so the tightest one wins;
- `allowlist`: a destination must be on **every** matching list;
- `blocklist`: a destination on **any** matching list is refused.

```ts
policies: {
  blocklist: { eip155: [KNOWN_SCAM_ADDRESS] },              // on every EVM chain
  maxFee: { eip155: 10n ** 16n, 'eip155:1': 5n * 10n ** 15n }, // tighter on mainnet
}
```

When the account cannot learn its chain id, its namespace rules still apply; an exact-id rule
of that family refuses the write (`policy: 'chain'`) instead of guessing.

The account's own namespace rules apply however you asked for it. A registration key of your own
(`registerWallet('evm', …)` then `getAccount('evm')`) or another family's id is no chain: under it,
an EVM account is judged by the `eip155` rules and by the exact-id rules of the chain it reports,
which it learns from its RPC first when an exact-id rule of the family is set.

## Policies and chain-level limits

Chain packages have their own limits on top: `transferMaxFee` / `transactionMaxFee` in
every chain config, a fee-rate ceiling on Bitcoin, refusal of burns to zero addresses,
simulation before signing. Policies are the app-wide layer above them: one place,
same shape on every chain.
