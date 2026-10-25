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
any other typed data is `kind: 'typedData'`, `confirm` only), plus chain-specific write
methods (Tron's `signRaw`, NEAR's `signBuilt` and `signNep413`, Solana's `sendSerialized`,
`signCompiled`, `signTransactionMessage`). The rule is deny-by-default: any account method
whose name starts with `sign`, `send`, `approve`, `revoke` or `transfer` is guarded unless
it is listed in `UNGUARDED_WRITES` (empty today), so a new signing method in a chain
package cannot bypass the policies. Reads (balances, quotes, receipts) are never affected.

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
   `transfer`, `sendTransaction`, `signTransaction`).
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
| `to` | Destination, when it can be read off the call |
| `token` | Token identifier for token transfers; `undefined` means the native coin |
| `amount` | Amount in base units, when it can be read off the call |
| `message` | `true` for message signatures |
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

## Policies and chain-level limits

Chain packages have their own limits on top: `transferMaxFee` / `transactionMaxFee` in
every chain config, a fee-rate ceiling on Bitcoin, refusal of burns to zero addresses,
simulation before signing. Policies are the app-wide layer above them: one place,
same shape on every chain.
