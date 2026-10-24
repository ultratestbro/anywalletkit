# @anywalletkit/wallet-solana

Solana accounts at `m/44'/501'/i'/0'` (SLIP-10 ed25519 — the Phantom / Solflare
default), pinned by golden vectors in `@anywalletkit/conformance`.

Signing uses noble ed25519 over the compiled message bytes, so there is no
WebCrypto dependency: the same code runs in Node and in React Native Hermes
without the Ed25519 subtle polyfill.

```ts
import WalletManagerSolana from '@anywalletkit/wallet-solana'

const wallet = new WalletManagerSolana(seedPhrase, { provider: ['https://rpc-a', 'https://rpc-b'] })
const account = await wallet.getAccount(0)
await account.transfer({ recipient: 'So1…', amount: 10_000_000n })                 // SOL (lamports)
await account.transfer({ token: USDC_MINT, recipient: 'So1…', amount: 1_000_000n }) // SPL, creates the ATA if missing
await account.sendTransaction(transactionMessage)                                  // any @solana/kit message
wallet.dispose()
```

## What you sign, what it costs, and when the wallet refuses

Every `transfer` / `sendTransaction` / `signTransaction` goes through one plan,
so the network is consulted once per fact and a failing step throws before the
key is used:

1. **Describe** — `account.describeTransaction(tx)` (or `describeTransaction(tx, {account})`,
   pure/offline) decodes System, Token, Token-2022, Associated-Token and
   Compute-Budget instructions and reports `kind` (`sol-transfer`,
   `spl-transfer`, `token2022-transfer`, `ata-create`, `program-call`, `mixed`)
   plus warnings: `unknown-program`, `sets-authority`, `closes-account`,
   `approves-delegate`, `unlimited-approve`, `foreign-fee-payer`,
   `missing-signers`, `unresolved-lookup-tables`, `burn-address`.
2. **Hard checks** — fee payer must be this wallet (`allowForeignFeePayer` to
   override), a provider transaction must not need other signatures
   (`MissingSignersError`), transfers to the System-program address are refused
   (`UnsafeTransactionError`, `allowBurn` to override).
3. **Compute budget** — by default the price is the 75th percentile of
   `getRecentPrioritizationFees` over the writable accounts (clamped by
   `minPriorityMicroLamports` / `maxPriorityMicroLamports`) and the unit limit is
   the simulated usage × 1.1. Set `priorityFee: {microLamports, computeUnitLimit}`
   for explicit values or `priorityFee: false` to add nothing; a budget the
   caller already put in the message is kept.
4. **Simulation** — `simulateTransaction` (`sigVerify: false`) runs before signing;
   a failure throws `SimulationError` with the program logs. `simulate: false` disables the gate.
5. **Fee quote** — `quoteSendTransaction` / `quoteTransfer` return
   `{fee, baseFee, priorityFee, microLamports, computeUnitLimit, tokenFee?}`;
   `transferMaxFee` / `transactionMaxFee` compare against `fee`.

```ts
const q = await account.quoteTransfer({ token: MINT, recipient, amount: 10_000n })
q.priorityFee  // lamports added by the compute budget
q.tokenFee     // Token-2022 transfer fee withheld by the mint (0 for plain SPL)
```

### Token-2022

`transfer` reads the mint once: owner program, decimals and (for Token-2022) the
`TransferFee` extension in force this epoch. Transfers use `transferChecked`
(mint and decimals verified on chain); fee-bearing mints use
`transferCheckedWithFee` so a changed fee makes the transaction fail instead of
silently taking more. The recipient's ATA is derived for the right program.

### Versioned transactions and provider wires

* `transfer({..., lookupTables: [table]})` / `sendTransaction({to, value, lookupTables})`
  fetch the tables and compress the v0 message.
* A swap or DeFi provider's base64 wire transaction is accepted directly:
  `signTransaction(base64)` / `sendTransaction(base64)` decode it, run the hard
  checks, simulate, add this wallet's signature (others are preserved) and
  return / broadcast the wire. The message bytes are never altered.

## Activity history

`createSolanaHistory` is the chain's `HistorySource` (`@anywalletkit/core`): newest-first `ChainTx` pages for an address over plain JSON-RPC, no indexer.

```ts
import { createSolanaHistory } from '@anywalletkit/wallet-solana/history'

const history = createSolanaHistory({ rpcUrls: ['https://api.mainnet-beta.solana.com'] })
const page = await history.listActivity('2tKRnQTAXmryVYxDNSajdZg1DfX2FbHKNboWr5EBiKhW', { limit: 25 })
const older = await history.listActivity(address, { cursor: page.cursor })
const one = await history.getTransaction(page.items[0].hash, address)
history.explorerTxUrl(one.hash) // https://solscan.io/tx/…
```

| option | default | notes |
|---|---|---|
| `rpcUrl` / `rpcUrls` | — | One or several JSON-RPC endpoints, tried in order per request (HTTP 429 / 5xx / network → next). |
| `network` | `mainnet` | `devnet` / `testnet` switch the CAIP-2 id and add `?cluster=` to Solscan links. |
| `rateLimit` | 5 rps | Requests per second (a JSON-RPC batch counts as one). |
| `batchSize` | 10 | `getTransaction` calls per JSON-RPC batch (1–10). |
| `maxTokenAccounts` | 50 | Token accounts merged into the address's history. |
| `fetch`, `timeoutMs` | global, 15 000 | `AbortSignal.timeout` when the runtime has it. |

**Endpoints.** `getTokenAccountsByOwner` (Token + Token-2022, `jsonParsed`, cached per address) → `getSignaturesForAddress` for the wallet **and each token account** → `getTransaction` (`jsonParsed`, `maxSupportedTransactionVersion: 0`, `confirmed`) in batches of ≤ 10. A transaction the node pruned still yields a row (status from the signature list, no transfers, `raw.tx === null`).

**Pages and cursor.** Signatures of every list are merged by slot (newest first), deduplicated, and the page takes the top `limit` plus ties at the boundary slot, so each list's consumed rows form a prefix of what the node returned. The cursor is base64 JSON `{ v: 1, l: { <list address>: <before signature> | '' | null } }`: one `before` signature per list, `''` = not started, `null` = exhausted. The list set is frozen in the cursor; a token account created mid-pagination joins on the next fresh listing. Pagination is exact even when one transaction touches several lists.

**Mapping.** Native transfers come from `preBalances`/`postBalances` with the fee added back to the payer, token transfers from `pre`/`postTokenBalances` per mint attributed to the token accounts' **owners** (`standard` = `spl` / `token2022` from `programId`, `decimals` from the balance), senders paired with receivers largest-first; a receiver without a sender is a mint (`from` = mint), a sender without a receiver a burn (`to` = mint). `fee` = `meta.fee`, `status` from `meta.err`, `block` = slot. `call.programs` lists every top-level instruction program id, then inner ones; `call.to` is the first program that is not plumbing (System, ComputeBudget, Memo, Token, Token-2022, Associated Token) and `call.data` that instruction's base58 data — what `@anywalletkit/protocol-staking-spl-stake-pool-solana` reads. A transaction made only of plumbing (a SOL or SPL transfer) has no `call`; `to` is then the recipient owner. `nativeValue` is the SOL the payer sent in a plain transfer, 0 for program calls. Symbols are not resolved here (no catalog dependency); the kit fills them.

Fixtures in `test/fixtures/history/` were captured on 2026-10-14 from `api.mainnet-beta.solana.com` for the test wallet: signature pages for the wallet, its JitoSOL and USDC accounts, both token-account lists, the Jito `DepositSol` (`3SmwE6qf…`, the same transaction as the stake-pool module's activity fixture), a SOL send and receive, a USDC send and a Token-2022 → USDC aggregator swap. `test/history.test.ts` checks that the row this source builds for the Jito deposit is described as `stake` by the stake-pool module.
