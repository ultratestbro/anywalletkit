---
title: Fiat and notifications
description: Buying and selling crypto with a card, and telling the user about incoming funds while the app is closed.
sidebar:
  order: 11
---

## Buy and sell

**The job:** a "Buy" button that ends with crypto in the user's address, and a "Sell" button
that ends with money in their bank.

**In the kit:** `FiatProtocol` in `core` defines the shape: `quoteBuy`, `buy`, `quoteSell`,
`sell`, `getTransactionDetail`, `getSupportedCryptoAssets`. No provider module ships yet;
write one against that interface, or call the provider's widget directly.

**You bring:** an on-ramp provider. It runs KYC and payments; you pass the address and the
asset, and receive webhooks about the order.

| Provider | Docs |
|---|---|
| MoonPay | [dev.moonpay.com](https://dev.moonpay.com) |
| Transak | [transak.com](https://transak.com) |
| Ramp Network | [docs.ramp.network](https://docs.ramp.network) |
| Banxa | [banxa.com](https://banxa.com) |

**Things to settle with the provider:**

- **Countries and assets.** Coverage differs per country, payment method and network.
- **Who you are to them.** Most providers need a signed agreement and a business review
  before production keys.
- **Fees.** The user sees the provider's fee plus the network fee; some let you add your own.

## Notifications

**The job:** "You received 50 USDT" while the app is closed.

**In the kit:** nothing yet.

**You bring:**

1. **An address-watching service** that calls your server when something happens to an
   address:

   | Chain | Examples |
   |---|---|
   | EVM, Solana and other chains QuickNode serves | [QuickNode Streams](https://www.quicknode.com/docs/streams) |
   | EVM | [Alchemy Notify (webhooks)](https://docs.alchemy.com/reference/notify-api-quickstart) |
   | Solana | [Helius webhooks](https://www.helius.dev/docs/webhooks) |
   | Any | Your own indexer polling the history sources |

2. **A server** that receives those events, decides what is worth a notification, and maps
   the address to a device token.
3. **Push delivery:** [Expo push](https://docs.expo.dev/push-notifications/overview/), or
   [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging) and APNs
   directly.

**Rules:**

- **Only addresses leave the device**, never keys. Tell users their addresses are linked to
  a device on your server, and let them turn it off.
- **Filter spam before you push.** A notification about a scam airdrop is phishing you
  delivered yourself.

:::caution[Check before you rely on a provider]
On-ramps and webhook services change coverage, pricing and requirements. We checked these
links on 2026-10-23. Read each provider's current terms. A listing here is not an
endorsement.
:::
