# @anywalletkit/protocol-swap2-thorchain

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-thorchain?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-thorchain)

THORChain native cross-chain swaps as a swap2 module: EVM sources (Ethereum,
Base, BSC, Avalanche) deposit into the THORChain router with
`depositWithExpiry(vault, asset, amount, memo, expiry)`; Tron executes as a
native send to the inbound vault with a memo. Standalone through
`ThorchainSwap2Protocol`, or as one provider of the router.

## Install

```sh
npm install @anywalletkit/protocol-swap2-thorchain @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-thorchain @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-thorchain @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-thorchain](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-thorchain), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## Where the funds go

The router an EVM-source swap calls and approves must be one of `THORCHAIN_ROUTERS` (Ethereum, BSC, Avalanche,
Base; `trustedRouters` adds one, e.g. during a router migration), and the inbound vault the router pays must be
reported by a second THORNode (any node other than the one that quoted) both when the quote is taken and right
before broadcast. A disagreeing node, or no second node answering, refuses the swap. The defaults are two public
nodes of different operators (Liquify's gateway and the IBS team's node, both checked on 2026-10-28); with one
`nodeUrl` of your own, the defaults confirm it unless `confirmNodeUrl` names another node (pick one of another
operator; a local mock needs a second mock there). Node URLs must be `https:` (`allowInsecureNodeUrl` for local
development).

### How a second node confirms the vault

THORChain keeps several asgard vaults active and its inbound address moves among them every few minutes, so a node a
few blocks behind the quoting node often still names the previous one. A confirming node agrees when the quoted
vault is:

- its current inbound address for the source chain (`/thorchain/inbound_addresses`), or
- that chain's address of a vault it lists with status `ActiveVault` (`/thorchain/vaults/asgard`, chain matched
  exactly; EVM addresses compare case-insensitively, others exactly) that its mimir (`/thorchain/mimir`) does not
  flag `CompromisedVault-<pubkey>` or `SolvencyHaltVault-<pubkey>-<chain>`. THORNode leaves such vaults out of inbound
  election and does not credit an inbound to a compromised vault.

A `RetiringVault` (or any other status) never confirms. The rest stays as strict: on EVM the router in the node's
`inbound_addresses` must be the quote's; a halt or trading pause on the source or the destination chain refuses; the
calldata must still pay exactly the quoted vault.

A confirming node is skipped for the next one when it trails the quoting node's THORChain height
(`/thorchain/lastblock`, the `thorchain` field) by more than `confirmMaxLagBlocks` (default 50 ≈ 5 minutes), does not
answer within `confirmTimeoutMs` (default 2500 ms), redirects (also when the runtime followed the redirect itself, as
React Native's fetch does: `res.url` must be the URL asked), or answers in another shape. When every node trails, the
refusal says so ("no confirming node is within 50 blocks …"); when none answers, it is "no second node answered to
confirm the inbound vault".

**Another shape** includes a field of another type. The type of every field read is checked (THORNode's own types):
in `inbound_addresses` each entry is an object with a string `chain`, `address`, `router` and `dust_threshold` are
strings and `halted`, `global_trading_paused` and `chain_trading_paused` booleans when present; in `vaults/asgard`
`status` is a string, `pub_key` a `thorpub1…` string, `addresses` a list of objects with string `chain` and `address`;
every `mimir` value is a number or a string (int64), and a vault flag an int64; `lastblock`'s `thorchain` is a
non-negative int64. One such field anywhere in an answer (another chain's entry or another vault included) skips
the confirming node, and `verifyBuild` skips it the same way. The quoting node's `inbound_addresses` and `lastblock`
are read the same way: another shape makes that node unavailable and the next `nodeUrl` host is asked, with the
existing refusals when none is left ("inbound addresses unavailable from every node", "THORChain height
(/thorchain/lastblock) unavailable from every node that answered the inbound addresses"; before broadcast "cannot
refresh inbound addresses before broadcast").

**Time.** The vault check has its own 8 s budget. It starts when the quoting node's quote is in hand (before
broadcast: when a node is asked to refresh the inbound snapshot) and covers that node's `inbound_addresses` and
`lastblock` reads and every confirming node, each getting `confirmTimeoutMs` or what is left; time a failed host took
before does not count, and no confirming node is asked with less than 100 ms left. When the budget runs out before
any confirming node was asked, the refusal is "the 8 s confirmation budget ran out before a second node could be asked to confirm the
inbound vault — retry". `confirmTimeoutMs` bounds confirming nodes only: each read of the quoting node (the quote,
`inbound_addresses`, `lastblock`) gets 8 s whatever it is. When a node answers `inbound_addresses` but not
`lastblock`, the refusal names it: "THORChain height (/thorchain/lastblock) unavailable from every node that answered
the inbound addresses" (before broadcast: "cannot read THORChain height (/thorchain/lastblock) before broadcast from
any node that answered the inbound addresses"). Worst case without a caller signal: each `nodeUrl` host takes at most
8 s for the quote (16 s when a quote without a slippage is retried with a wider tolerance) plus 8 s for its snapshot,
and the host that quotes is confirmed within the 8 s that started when its quote was in hand: hosts × 16 s, or hosts ×
24 s with the retry (32 s / 48 s with the two default hosts); `preflightDeposit` hosts × 8 s. A caller's AbortSignal
(the router passes one: 8 s per provider, 25 s when it is the only one) replaces the 8 s bound of the quote request;
when it aborts, the quote request, the quoting node's `lastblock` read and the confirming reads stop at once, and its
`inbound_addresses` read keeps its own 8 s.

**Requests a confirming node gets** (`THORNODE_CONFIRM_PATHS`), all `GET`, no query string, no body, headers
`accept` and `x-client-id` only. A proxy in front of a confirming node can pass exactly these four and refuse
anything else:

| Path | When |
| --- | --- |
| `/thorchain/lastblock` | every confirmation |
| `/thorchain/inbound_addresses` | every confirmation |
| `/thorchain/vaults/asgard` | when the node's current inbound is not the quoted vault |
| `/thorchain/mimir` | when the node's current inbound is not the quoted vault |

The quoting node (`nodeUrl`) gets `/thorchain/quote/swap?from_asset=…&to_asset=…&amount=…&destination=…` with
`tolerance_bps` or `liquidity_tolerance_bps`, `streaming_quantity=1` and, when set, `refund_address`, `affiliate`,
`affiliate_bps`; then `/thorchain/inbound_addresses` and `GET /thorchain/lastblock` (no query string, so a proxy in
front of a `nodeUrl` must pass it too); `trackIntent` reads `/thorchain/tx/status/<HASH>` and `/thorchain/tx/<HASH>`.
The quote's `inbound_addresses` read and the quote itself ask for `cache: "no-store"`, which React Native's fetch
sends as an extra `?_=<time>` query; `lastblock` and the confirming reads set no cache option.

Behind `remoteProvider`, the app checks the backend's build itself: `remoteProvider({name: "thorchain", baseUrl,
...thorchainPins()})` pins the routers and runs `verifyBuild` on the client — the vault in the router call confirmed
by two nodes, the source asset and exact input, and the memo's destination, refund and limit against the app's own
request (pass the backend's `affiliate` / `affiliateBps`). The pins open the stub to the Tron deposit route
(`depositAddressRoutes`): its vault is the one `verifyBuild` confirms.

`verifyBuild` confirms the vault by the same rule as the provider's confirming nodes, so an inbound rotation between
the backend's quote and the device's check does not refuse: current inbound or a non-flagged `ActiveVault` (never
`RetiringVault` or another status), both chains open, on EVM the node's router equal to the call's. It asks every
`nodeUrl` node (default: the two public nodes) in parallel on the four `THORNODE_CONFIRM_PATHS` (the same GETs, so the
same proxy rules), each within `confirmTimeoutMs` (default 2500 ms, so the check takes at most that); a node that
fails, redirects, answers another shape (a field of another type included, as above), is slower, or trails the
highest THORChain height the nodes report by more than `confirmMaxLagBlocks` (default 50) is skipped. In `nodeUrl`
order a node's refusal refuses and two confirming nodes pass. Refusals: "a THORNode reports another inbound vault
than `<vault>`", "a THORNode reports another router",
"`<CHAIN>` is halted / paused" (now also the destination chain), "a THORNode lists the inbound vault as `<Status>`, not
ActiveVault", "a THORNode's mimir flags the inbound vault as compromised" (or `insolvent`), "two THORNodes within 50
blocks of the highest THORChain height they report could not confirm the inbound vault (behind or unreachable)", "two
THORNodes could not confirm the inbound vault".

## Activity

Routers and Asgard vaults rotate, so `describeActivity(tx, ctx)` matches no
address — only the router's unique ABI, on the EVM chains this module serves:

| Selector | Meaning | Kind | Title |
| --- | --- | --- | --- |
| `depositWithExpiry(address,address,uint256,string,uint256)` `0x44bc937b`, sent by the owner | our source leg | `bridge` (`swap` when the output also landed here) | "Bridged USDC" |
| `transferOut(address,address,uint256,string)` `0x574da717` / `transferOutAndCall` `0xec341444`, with something arriving at the owner | THORChain paying a destination leg | `bridge` | "Received USDC via THORChain" |

Subtitle "THORChain", counterparty = the router called. Not recognizable
offline: the Tron / BTC vault deposits (plain sends with a memo, vault
addresses rotate) and the destination leg on non-EVM chains.

Fixtures (`fixtures/activity/`, test wallet on Ethereum, 2026-10-10): two
`depositWithExpiry` USDC deposits and one router `transferOut` that paid the
wallet; negatives: a LI.FI swap, a Uniswap `multicall`.
