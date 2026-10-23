---
title: Send and receive
description: The send flow on every chain, what differs per chain, receiving with a QR code, and names instead of addresses.
sidebar:
  order: 6
---

## Send

**The job:** recipient, amount, fee, confirm, broadcast, wait.

**In the kit:** every account has the same three calls.

```ts
const { fee } = await account.quoteTransfer({ token, recipient, amount }) // nothing signed
const { hash } = await account.transfer({ token, recipient, amount })    // signs and broadcasts
const receipt = await account.getTransactionReceipt(hash)                // undefined until it lands
```

`token` is omitted for the native coin. Amounts are base units (`bigint`). With
[policies](/concepts/policies/) registered, the transfer passes the fee cap, the lists and
your `confirm` step before anything is signed.

**What differs per chain, and what your UI must show:**

| Chain | What the package does | What can go wrong |
|---|---|---|
| EVM | EIP-1559 fees; `autoResetAllowance` sends USDT's `approve(0)` when needed | The user has no gas coin on that network |
| Solana | Creates the recipient's token account (ATA) when missing; sets the priority fee automatically | Creating an ATA costs rent, so a token send can cost more SOL than expected |
| TON | Deploys the wallet contract on the first send; supports a text comment | Jetton sends need TON for the fee; exchanges require a comment (memo) |
| Tron | `estimateFee` returns bandwidth, energy and the TRX that will be burned | Without staked energy, a USDT transfer burns several TRX |
| Bitcoin | SegWit (`bc1q…`) or Taproot (`bc1p…`) accounts, fee rate in sat/vB | Dust outputs, a fee rate that is too low in a busy mempool |
| NEAR | Adds `storage_deposit` before a token send to a new holder | Named vs implicit accounts in the recipient field |
| Zcash | Transparent (`t1…`) addresses | Shielded addresses are not supported yet |

**Rules for the send screen:**

- **Validate the address before the amount screen.** Check the format for that chain. On EVM,
  warn when the address is a token contract: tokens sent to a token contract are usually lost.
- **Warn on a first send** to an address the user has never sent to.
- **Show the fee in the gas coin and in fiat**, and what the recipient will receive.
- **Keep the user from sending the whole balance of the gas coin** without leaving the fee.
- **After broadcast, show a pending row** right away and update it from the receipt.

## Receive

**The job:** show the address and a QR code.

**In the kit:** `account.getAddress()`.

**You bring:** a QR library.

- **EVM:** the same address works on every EVM network. Say which network the sender should
  use, or tokens arrive on a network the user doesn't watch.
- **Bitcoin:** decide which address type to show (SegWit is the most widely accepted).
- **TON and exchanges:** some exchanges need a comment to credit a deposit. The receive screen
  can't help with that; the send screen of the exchange must.

## Names

**The job:** let users type `name.eth` instead of `0x…`.

**In the kit:** `names-ens` resolves ENS names to the address for the chain you ask for,
including L2 names and CCIP-Read (offchain) names. `.sol`, `.ton` and `.near` are planned.
See the [Names guide](/guides/names/).

**You bring:** an Ethereum mainnet RPC: resolution always starts on mainnet, whatever chain
the user sends on.

**Rule:** show the resolved address on the review screen, not only the name. A name can
change owner; the address is what gets the funds.
