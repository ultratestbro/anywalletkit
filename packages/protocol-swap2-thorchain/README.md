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
answer within `confirmTimeoutMs` (default 2500 ms; all nodes share the quote's 8 s), redirects, or answers in
another shape. When every node trails, the refusal says so ("no confirming node is within 50 blocks …"); when none
answers, it is "no second node answered to confirm the inbound vault".

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
`affiliate_bps`; then `/thorchain/inbound_addresses` and `/thorchain/lastblock`; `trackIntent` reads
`/thorchain/tx/status/<HASH>` and `/thorchain/tx/<HASH>`. The quote's `inbound_addresses` read and the quote itself
ask for `cache: "no-store"`, which React Native's fetch sends as an extra `?_=<time>` query; confirming reads set no
cache option.

Behind `remoteProvider`, the app checks the backend's build itself: `remoteProvider({name: "thorchain", baseUrl,
...thorchainPins()})` pins the routers and runs `verifyBuild` on the client — the vault in the router call confirmed
by two nodes, the source asset and exact input, and the memo's destination, refund and limit against the app's own
request (pass the backend's `affiliate` / `affiliateBps`). The pins open the stub to the Tron deposit route
(`depositAddressRoutes`): its vault is the one `verifyBuild` confirms. `verifyBuild` still asks each of its two nodes
for its current inbound address only (`/thorchain/inbound_addresses`), not for the active vault list above.

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
