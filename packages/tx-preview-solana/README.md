# @anywalletkit/tx-preview-solana

[![npm](https://img.shields.io/npm/v/@anywalletkit/tx-preview-solana?label=npm)](https://www.npmjs.com/package/@anywalletkit/tx-preview-solana)

What a Solana transaction will do, before it is signed. Every instruction is decoded through a decoder registry: the official programs, Token-2022 with all of its extensions, and a few protocols. Address lookup tables are resolved. With an RPC, the transaction is also simulated, and the result carries the signer's SOL and token balance changes and the inner instructions the programs would run.

Beta (0.x): the API can still change between minor versions. Apache-2.0.

## Install

```sh
npm install @anywalletkit/tx-preview-solana
# or: pnpm add @anywalletkit/tx-preview-solana  ·  yarn add @anywalletkit/tx-preview-solana
```

On npm: [@anywalletkit/tx-preview-solana](https://www.npmjs.com/package/@anywalletkit/tx-preview-solana), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

The package depends on `@solana/kit` and the official program clients (`@solana-program/system`, `token`, `token-2022`, `compute-budget`, `stake`, `address-lookup-table`). It runs in Node 22+ and in React Native (Hermes).

## Preview a transaction

```ts
import { createSolanaRpc } from '@solana/kit'
import { describeTransaction } from '@anywalletkit/tx-preview-solana'

const rpc = createSolanaRpc('https://your-mainnet-rpc')
const preview = await describeTransaction(base64Tx, { rpc, signer: wallet.address })

for (const ix of preview.instructions) console.log(ix.programName ?? ix.programAddress, ix.name, ix.args)
preview.warnings          // [{ code: 'unlimited-approve', message, instruction: 2 }, …]
preview.simulation?.ok    // false when the transaction would fail on chain
preview.simulation?.balances?.signer
// { address, sol: -2095080n, tokens: [{ mint, decimals: 6, delta: -777000000n }] }
```

The input can be a base64 wire transaction (what a dApp or a swap API hands over), its bytes, a `@solana/kit` `Transaction`, or a kit transaction message. A message is simulated only when it has a fee payer and a lifetime. Before that, it is decoded and gets a `simulation-unavailable` warning.

`describeTransaction` does three things:

1. It reads the lookup tables a v0 transaction references, unless you pass them in `lookupTables`. It uses `getMultipleAccounts`.
2. It decodes every instruction offline.
3. It calls `simulateTransaction` with signature verification off, the blockhash replaced and inner instructions on. A transaction that would fail comes back as `simulation.ok === false` with a `simulation-failed` warning. Only transport errors throw.

Options: `rpc`, `signer`, `simulate` (default `true`), `commitment`, `abortSignal`, `lookupTables` and `registry`.

The `rpc` can be any `@solana/kit` RPC. The package calls only `getMultipleAccounts` and `simulateTransaction` (the `PreviewRpc` type).

## Decode offline

```ts
import { decodeTransaction, fetchLookupTables, lookupTableAddresses } from '@anywalletkit/tx-preview-solana'

const decoded = decodeTransaction(base64Tx, { signer: wallet.address })
// v0 with lookup tables: read them once, then decode fully
const lookupTables = await fetchLookupTables(rpc, lookupTableAddresses(base64Tx))
const full = decodeTransaction(base64Tx, { lookupTables, signer: wallet.address })
```

`decodeTransaction` makes no network calls. If a lookup table was not passed in, the accounts it holds keep their place, signer and writable flags, but their `address` is `null`. The table is listed with `resolved: false`, and the `unresolved-lookup-tables` warning names it. The instructions still decode: names and arguments come from the data. Accounts that sit in a missing table stay unnamed.

To decode a single instruction, use `decodeInstruction({ programAddress, accounts, data }, index, registry?)`. To compute balance changes from any pre/post balances, use `computeBalanceChanges(accountKeys, meta, signer)`. The meta can come from a simulation or from a confirmed transaction's `getTransaction`.

## The result

`describeTransaction` returns a `TransactionPreview`. `decodeTransaction` returns the same object without `simulation`. Everything in it is plain data: strings, numbers, bigints, booleans, arrays and records. Amounts are bigints in base units, addresses are base58 strings, and raw bytes are base64.

| Field | What it holds |
| --- | --- |
| `version` | `'legacy'`, `0` or `1` |
| `feePayer`, `signers` | Required signers in message order. `signed` is `true` or `false` for a compiled transaction and `null` for a message. |
| `lifetime` | `{ kind: 'blockhash' \| 'durable-nonce', value }`. A transaction whose first instruction is `AdvanceNonceAccount` never expires. |
| `accounts` | Every account the message loads: static keys, then each lookup's writable entries, then its readonly entries. |
| `lookupTables` | `[{ address, resolved }]` |
| `config` | A v1 message's compute budget: `priorityFeeLamports`, `computeUnitLimit`, `loadedAccountsDataSizeLimit`, `heapSize`. `null` for legacy and v0, which use Compute Budget instructions instead. |
| `instructions` | One `DecodedInstruction` per top-level instruction, in order |
| `warnings` | Facts worth showing (see below) |
| `simulation` | `{ ok, error, logs, unitsConsumed, fee, balances, innerInstructions }`, or `null` without an RPC |

A `DecodedInstruction` holds the following fields:

- `index` and `programAddress`;
- `programName`, which is `null` when no decoder is registered for the program;
- `name`: the instruction's name as its program defines it, such as `TransferChecked` or `HarvestWithheldTokensToMint`. It is `null` when the data was not recognised;
- `decoded`;
- `args`: the decoded arguments. Options are unwrapped, so `None` becomes `null`; enums are numbers; byte arrays are base64;
- `accounts`: `[{ address, signer, writable, name }]` in instruction order. `name` is the account's role (`source`, `mint`, `authority`…) or `null` for an unnamed slot, such as multisig signers and remaining accounts;
- `data`: the raw data, base64.

An instruction that is not decoded is never dropped. It keeps its raw accounts and data, plus `error` when a known program's data was malformed.

Inner instructions come from the simulation in the RPC's jsonParsed form. The RPC returns some of them already parsed (System and Token, for example) and drops their bytes. Those carry `parsedByRpc: true`, and their `name`/`args` are the RPC's reading: its `type` in PascalCase and its `info` as is. All other inner instructions go through the same registry as the top level.

`balances` (`BalanceChanges`) has three parts:

- `sol`: every account whose lamports change, as `{ account, pre, post, delta }`;
- `tokens`: every token account whose amount changes, plus the ones the transaction creates or closes, which count from or to zero. Each entry has `{ account, mint, owner, tokenProgram, decimals, pre, post, delta }`;
- `signer`: the signer's own view. `sol` is its lamport change, fee included. `tokens` sums the changes of the accounts the signer owns, per mint.

If the RPC returns no pre/post balances, `balances` is `null` and the `balances-unavailable` warning is added.

### Warnings

Warnings describe what the transaction does. They do not judge it (see Limits).

| Code | When |
| --- | --- |
| `unresolved-lookup-tables` | Some lookup tables were not resolved, so their accounts are unknown. |
| `foreign-fee-payer` | The fee payer is not `signer`. |
| `missing-signers` | Signatures other than the signer's are still empty. |
| `durable-nonce` | The transaction uses a durable nonce and does not expire. |
| `unknown-program` | No decoder is registered for the program. |
| `undecoded-instruction` | A known program, but data its decoder does not recognise. |
| `sets-authority` | Token/Token-2022 `SetAuthority` or a metadata/group update-authority change, System `Assign`/`AssignWithSeed`/`AuthorizeNonceAccount`, Stake `Authorize*` and lockup custodian. |
| `closes-account` | Token `CloseAccount`, `CloseLookupTable` |
| `approves-delegate` | `Approve` or `ApproveChecked` |
| `unlimited-approve` | An approval of `u64::MAX` (`MAX_U64`) |
| `burn-address` | A SOL or token transfer to the all-zero address |
| `simulation-failed`, `simulation-unavailable`, `balances-unavailable` | See above |

Token-2022 `Batch` instructions are opened up, and every instruction inside a batch is checked the same way.

## Decoders

### Built in

The official programs are decoded through their Codama clients. `@solana-program/*`'s own `identify…Instruction` names the instruction, its data decoder reads the arguments, and its parser names the accounts. Every instruction those clients know is covered:

| Program | Coverage |
| --- | --- |
| System | All 14 instructions: transfers (with seed), create/allocate/assign (with seed), the 5 nonce instructions, `CreateAccountAllowPrefund` |
| SPL Token | All 28, including `Batch` (opened up), `UnwrapLamports`, `WithdrawExcessLamports` |
| Token-2022 | All 100 instructions the client knows. That covers every extension: transfer fees (`TransferCheckedWithFee`, harvest/withdraw withheld), confidential transfer, confidential transfer fee and mint/burn, default account state, memo transfer, CPI guard, interest-bearing and scaled UI amount, metadata/group/member pointers, token metadata and token group interfaces, transfer hook, permanent delegate, pausable, permissioned burn, and `Batch` (opened up) |
| Associated Token Account | `Create`, `CreateIdempotent` and `RecoverNested`, plus the original data-less `Create` |
| Compute Budget | `SetComputeUnitLimit`, `SetComputeUnitPrice`, `SetLoadedAccountsDataSizeLimit`, `RequestHeapFrame` and the deprecated `RequestUnits` |
| Address Lookup Table | `Create`, `Extend`, `Freeze`, `Deactivate`, `Close` |
| Memo v1, v2 | The memo text (UTF-8) and the signers that vouch for it |
| Stake | All 17 instructions plus the deprecated `Redelegate` (tag 15). Arguments get real names (`newAuthority`, `stakeAuthorize`, `lamports`, `lockup`…); accounts are named in both layouts the program accepts (with and without the Clock / Rent sysvar), and left `null` when the account that decides the layout sits in an unresolved lookup table |
| SPL Stake Pool (Jito and every pool on the program) | All 27 instructions (tags 0–26), arguments and accounts per the program source; exact-length borsh, as the program reads it |
| Jupiter Aggregator v6 | All 21 instructions of the on-chain IDL, every route variant (`Route`, `SharedAccountsRoute`, `ExactOutRoute`, token-ledger, `*V2`, attestation) with the full route plan (211 `Swap` variants), plus the self-CPI events (`SwapEvent`, `FeeEvent`…) seen in inner instructions |
| Kamino Lend | All 66 instructions of the on-chain IDL (1.27.0), arguments and accounts, plus the borrow-order events |

The Jupiter and Kamino tables are generated from the programs' on-chain Anchor IDL (`scripts/anchor-tables.mjs`). A layout newer than the tables (a new `Swap` variant) decodes the instruction name and the arguments before it, sets `partial` with the reason and leaves the rest `null`; the preview adds a `partially-decoded-instruction` warning. Nothing is guessed.

Mayan's CPI proxy (`MAYAN_CPI_PROXY_PROGRAM`) passes its first account and its data through. An instruction sent to the proxy is decoded as the instruction it runs, with `via` set to the proxy's address.

### Your own

A decoder reads one program and must not touch the network. It returns `null` for data it does not recognise and may throw for malformed data. Both cases are shown as undecoded instructions, never dropped.

```ts
import { defaultRegistry, describeTransaction, type InstructionDecoder } from '@anywalletkit/tx-preview-solana'

const counterDecoder: InstructionDecoder = {
  programAddress: 'Count3rProgram1111111111111111111111111111',
  programName: 'Counter',
  decode(ix) {
    if (ix.data[0] !== 1 || ix.data.length !== 9) return null
    const by = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true)
    return { name: 'Increment', args: { by }, accountNames: ['counter', 'authority'] }
  },
}

const registry = defaultRegistry.with([counterDecoder])   // a copy; the defaults stay as they are
const preview = await describeTransaction(base64Tx, { rpc, signer, registry })
```

`DecoderRegistry` holds one decoder per program. Registering a second decoder for the same program throws unless `{ replace: true }` is passed, so a plugin never silently overrides a built-in decoder.

A program with a Codama client can reuse the adapter the built-in decoders use:

```ts
import * as myProgram from 'my-codama-client'
import { codamaDecoder } from '@anywalletkit/tx-preview-solana'

const decoder = codamaDecoder({
  programAddress: myProgram.MY_PROGRAM_ADDRESS,
  programName: 'My Program',
  module: myProgram,
  instructions: { 0: 'Initialize', 1: 'Deposit' },   // the client's instruction enum, value → name
  identify: (data) => myProgram.identifyMyProgramInstruction(data),
})
```

## React Native

The package uses none of these: `Buffer`, `crypto.subtle`, `AbortSignal.timeout`, or `Number()` on amounts. Amounts stay bigints from the wire to the result, including values above 2^64. Memo text is read without `TextDecoder`. Other strings inside instruction arguments, such as token metadata names and seeds, are decoded by `@solana/kit`'s codecs, which read `TextDecoder`. React Native's Hermes has none, so install the polyfill kit asks for (`fastestsmallesttextencoderdecoder`). The repository's Hermes smoke (`examples/hermes-smoke`) decodes saved transactions (legacy, v0 with tables, v1, Token-2022 `TransferCheckedWithFee`) and computes their balance changes inside the Hermes VM. It requires the results to match Node's, string for string.

## Limits

- **C1 is decode and simulate.** Warnings are facts about the transaction, not a verdict. A risk verdict (allow, warn or block, with reasons) is the next layer and is not part of this package yet.
- The simulation runs against the RPC's current state. Balances at execution can differ: prices move, other transactions land first, and a durable-nonce transaction can be sent much later.
- Balance changes need an RPC that returns pre/post balances from `simulateTransaction`. Without them, `balances` is `null` and the warning says so.
- Lookup tables are read when the preview is made, at `confirmed` commitment by default. Entries are only ever appended, so while a table exists, the indices a transaction uses keep pointing at the same addresses.
- Inner instructions the RPC returns already parsed are shown in the RPC's reading (`parsedByRpc`), not this package's. Their names can differ from the top-level names. For example, the RPC calls `CreateAssociatedTokenIdempotent` `CreateIdempotent`.
- Programs without a decoder are shown as raw accounts and data, with the `unknown-program` warning.

## Testing

- `pnpm test` runs these suites:
  - [mainnet fixtures](https://github.com/ultratestbro/anywalletkit/tree/main/packages/tx-preview-solana/tests/fixtures) for every official program and every message form. Each fixture is checked against the RPC's own jsonParsed reading of the same transaction: names, arguments, named accounts, the resolved account list with its roles, and the fee the network charged;
  - every Token-2022 instruction built with the client's builder and decoded back;
  - balance changes compared with an independent reading of each fixture's meta, with several worked by hand;
  - the simulation path against a mock RPC;
  - one test per warning.
- `LIVE=1 SOLANA_RPC_URL=… npx vitest run tests/live.test.ts` simulates a freshly built, unsigned transaction against mainnet: a memo, a 0-lamport self-transfer and a 0-amount USDC self-transfer from a large wallet. It checks that the fee, logs, compute units and balances come back and agree with the decode.
- `node scripts/fetch-fixture.mjs <signature> tests/fixtures/<group>/<name>.json "<note>"` saves a confirmed transaction as a fixture: its wire bytes, the lookup table entries it used, the RPC's account list and parsed instructions, and the meta.
- `UPDATE_HERMES=1 npx vitest run tests/hermes-snapshot.test.ts` re-pins the Node results that the Hermes smoke compares against.

Apache-2.0
