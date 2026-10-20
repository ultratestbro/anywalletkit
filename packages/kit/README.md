# @forgewallet/kit

The orchestrator. Chain packages and protocol modules are registered; the kit
hands out accounts by CAIP-2 chain id and protocols by name, all fed by one
seed phrase or one external `Signer`, all wrapped by the same policies.

```ts
import { Wallet } from '@forgewallet/kit'
import WalletManagerEvm from '@forgewallet/wallet-evm'
import WalletManagerSolana from '@forgewallet/wallet-solana'

const wallet = new Wallet(seedPhrase, {
  policies: {
    maxFee: { 'eip155:1': 10n ** 16n },                 // 0.01 ETH
    allowlist: { 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': [TREASURY] },
    confirm: async (intent) => ui.confirm(intent),      // last word before broadcast
  },
})
wallet.registerWallet('eip155', WalletManagerEvm, { provider: ['https://rpc-a', 'https://rpc-b'] })
wallet.registerWallet('solana', WalletManagerSolana, { provider: SOL_RPC })
wallet.registerProtocol('lido', LidoProtocolEvm, { chain: 'eip155:1' })

const eth = await wallet.getAccount('eip155:1')          // policies applied
await eth.transfer({ recipient: '0x…', amount: 10n ** 15n })
const lido = await wallet.getProtocol<LidoProtocolEvm>('lido')
wallet.dispose()                                          // zeroizes every chain's keys
```

Policies run before anything is signed or broadcast, in this order: fee cap
(quotes first, where the account can quote), allowlist, blocklist, `confirm`.
Every write surface of an account is covered — `sendTransaction`, `transfer`,
`signTransaction` (a module that signs and broadcasts on its own cannot skip
them), `sign` and NEAR's `signNep413` (message signatures: `confirm` only,
nothing moves), the approval surfaces `approve`, `signPermit` and EIP-2612 /
Permit2 `signTypedData` (checked against the **spender**; `confirm` sees
`kind: 'approval'` with `unlimited`), other `signTypedData` (`confirm` only),
and chain-specific ones such as Tron's `signRaw`, NEAR's `signBuilt`, Solana's
`sendSerialized`. The rule is deny-by-default: any account method named
`sign*` / `send*` / `approve*` / `revoke*` / `transfer*` is guarded unless it
is listed in `UNGUARDED_WRITES`, so a new signing method in a chain package
cannot bypass the policies by not being named. Reads are never intercepted.

A revoke is `kind: 'revoke'`: an `approve` / `signPermit` / EIP-2612 Permit of 0,
raw revoke calldata (`approve(spender, 0)`, `approve(0x0, tokenId)`,
`setApprovalForAll(…, false)`, Permit2 `lockdown`, or a batch of only these) and
`revokeDelegation()`. It skips the allowlist and the spender's blocklist entry
(taking an allowance back from a blocklisted drainer must stay possible); the
blocklist still applies to the contract called, the fee cap and `confirm` apply,
and `confirm` sees `revokes: [{ token, spender }]`.

## Activity history

`history()` is the wallet's activity feed: one page across every chain that has a
history source, newest first, every row described by the first registered protocol
module whose `describeActivity` recognizes it (registration order), else by the
generic fallback. Rows the source flagged as spam are hidden unless asked for.

```ts
import { createEvmHistory } from '@forgewallet/history-evm'

const wallet = new Wallet(seedPhrase, {
  activity: {
    known: { 'eip155:8453': { '0x3fC9…7FAD': 'Uniswap Universal Router' } }, // subtitle for otherwise-anonymous contract calls
    natives: { 'eip155:999999': { symbol: 'XYZ', decimals: 18 } },            // overrides the built-in table / swap2-assets catalog
    onError: (e) => log.warn('activity', e),                                 // a source down, a recognizer that threw, a journal write that failed
    pendingTtl: 24 * 3600,                                                   // seconds a pending intent waits for its row (default)
  },
})
wallet.registerWallet('eip155', WalletManagerEvm, { provider })
wallet.registerProtocol('aave', AaveProtocolEvm, { chain: 'eip155:8453' })   // every registered protocol is a recognizer
wallet.registerHistorySource(createEvmHistory({ chainId: 8453, etherscanApiKey }))
wallet.registerHistorySource(createEvmHistory({ chainId: 1, etherscanApiKey }))

const page = await wallet.history({ limit: 20 })        // account 0 on every chain with a source
const older = await wallet.history({ limit: 20, cursor: page.cursor })
// or explicit addresses / chains:
await wallet.history({ addresses: [{ chain: 'eip155:1', address }], includeSpam: true, since: lastRefresh })

const item = await wallet.describeTransaction(tx)       // one ChainTx through the same pipeline, for a detail screen
```

`history(query)` → `{ items: FeedItem[], cursor?, errors? }`

* `query.addresses` (`{chain, address}[]`) or `query.index` (account index on every chain with a source, default 0); `chains` restricts; `limit` (default 20); `includeSpam`; `since` (unix seconds, for refresh); `cursor` from the previous page.
* `items` are `ActivityItem`s (`id = chain:hash`, `kind`, `title`, `subtitle`, `assetsOut` / `assetsIn` in base units with symbol and decimals, `counterparty`, `related`, `spam`, `fee`, `explorerUrl`) plus `intentId` when the row belongs to a journal intent and `approval` (`token`, `spender`, `amount`, `null` = unlimited) for `approve` / `revoke`.
* `cursor` packs every source's own cursor into one opaque string; absent when every source is exhausted. Ordering is time desc, then chain, then hash. A source that returned a short page is never overtaken: older rows of other chains wait for its next page, so a row can never appear on a later page than a newer one. Sources with block-window pagination that answer empty pages are followed up to `maxEmptyHops` (default 3) per call.
* `errors` lists what failed this call (`stage: 'source' | 'recognizer' | 'journal'`, with `chain` / `module`). A failed source keeps its position in the cursor and is retried on the next call; a recognizer that throws is skipped for that row and the next recognizer / the fallback still runs. Nothing is silently dropped.

### Generic fallback

`describeGeneric(tx, ctx, opts)` is exported and pure. From the owner's point of view:

| kind | when | title / subtitle |
|---|---|---|
| `send` | only own → others | "Sent USDC", recipient label |
| `receive` | only others → own (also airdrops through someone else's contract call) | "Received ETH", sender label |
| `self` | own → own (two accounts of the wallet) | "Self-transfer", moved amount in `assetsOut` |
| `approve` / `revoke` | owner called ERC-20 `approve` (0x095ea7b3); amount 0 = revoke, ≥ 2^255 = unlimited | "Approved USDC for Permit2", `approval` filled |
| `contract` | any other call the owner made (amounts attached when something moved) | "Contract call", `opts.known[chain][to]` label or `0x1234…abcd` |
| `unknown` | nothing moved, no call | "Transaction" |

Failed sends keep the intended amount (native value, or ERC-20 `transfer` calldata). Symbols and decimals come from the transfer rows, then the swap2-assets catalog, then the native table (`natives` option → built-in: GRAM on TON, SOL, TRX, BTC, NEAR → catalog natives for EVM chains → namespace default). `spam` is read from `raw.spam` / `tx.spam` (history-evm's rules).

### Intent journal — the app-side contract

On-chain rows cannot say "swapped USDC → ETH via 1Click" (the chain shows a USDC send to a deposit address), cannot pair a bridge's two legs, and are not there until the explorer indexes them. The app records what it *meant* and the kit folds it in:

```ts
const journal = createMemoryIntentJournal()        // or your own { list, put, remove } over SQLite / AsyncStorage
wallet.setIntentJournal(journal)
```

Write one `Intent` per user action, right after broadcast:

```ts
await journal.put({
  id: crypto.randomUUID(),                 // or the provider's id (1Click deposit address, LI.FI route id)
  kind: 'swap',                            // swap | bridge | stake | unstake | claim | supply | withdraw | borrow | repay | send | wrap | unwrap
  createdAt: Math.floor(Date.now() / 1000),
  chain: 'eip155:1', address: from,        // where it started, who signed
  hashes: [{ chain: 'eip155:1', hash: depositHash }],          // source leg first; push the destination leg when the provider reports it
  expect: { assetsOut: [{ token: USDC, amount, symbol: 'USDC', decimals: 6 }], assetsIn: [{ token: null, amount: quoteOut, symbol: 'ETH', decimals: 18 }] },
  protocol: '@forgewallet/protocol-swap2-near-intents',
  subtitle: 'NEAR Intents',
  status: 'pending',
})
```

What the app writes, per flow:

* **Swap / bridge (swap2)**: `kind` `swap` (same chain) or `bridge`, `hashes[0]` = the source transaction (deposit / router call), `expect` from the quote. When the provider's status endpoint returns the destination hash, `put` the intent again with it appended to `hashes` (a relayer fill that is not the wallet's own tx goes in `related`). For 1Click, where the user sends to a deposit address and the provider fills later, the deposit tx is `hashes[0]` and the fill hash is appended once `GET /status` returns it.
* **Earn (Aave / Morpho / Lido / Tonstakers / Jito …)**: `kind` `supply` / `withdraw` / `stake` / `unstake` / `claim`, `hashes[0]` the transaction, `protocol` the module name, `subtitle` the market label. Modules recognize these rows on their own; the intent matters only before the explorer indexes the row.
* **Send**: optional (`kind: 'send'`); useful for the pending row and for a contact label in `subtitle`.
* **Approvals**: not needed (the fallback and approvals module recognize them).

What `history()` does with the journal:

1. A row whose hash is in an intent inherits `kind`, `protocol`, `subtitle` and the expected assets **when the recognizer returned a generic item**; a recognizer's verdict is kept. Every matched item carries `intentId` and `related` (the other legs).
2. A pending intent with no row on the first page is looked up with each leg's `getTransaction` (explorer lag); found → emitted confirmed; not found → emitted at the top as `status: 'pending'`, `id: intent:<id>`, titled from `expect`.
3. Two legs of one intent on the same page collapse into one item (the source leg), `assetsIn` from the destination row, `related` pointing at it; the destination row is dropped. Legs that fall on different pages each carry `intentId`; collapse by it in the app if you keep pages in memory.
4. Pending longer than `pendingTtl` (default 24 h) with no row → `status: 'failed'`, persisted. Failed intents keep showing at the top of the first page until the app `remove`s them (dismiss action).
5. Matched intents are written back as `confirmed` / `failed`. The kit never removes intents; prune confirmed ones older than your retention window.

Timestamps are unix seconds like `ChainTx.time`; amounts are base-unit bigints.
