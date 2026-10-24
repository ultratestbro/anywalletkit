---
title: dApp connection
description: Letting websites talk to the wallet — a browser extension, WalletConnect on mobile, and an in-app browser.
sidebar:
  order: 10
---

**The job:** "Connect wallet" on a website ends in your wallet, and every request the site
makes passes your review.

## Browser extension

**In the kit:** `extension-kit` is the core of a Chromium (MV3) extension, without UI:

- an encrypted vault (password, or a passkey through WebAuthn PRF), and a session that locks
  itself when idle;
- the dApp request router, per-site permissions and the approval queue;
- signing checks, including Sign-In with Ethereum (EIP-4361) messages checked against the
  asking site.

The reference extension in the repository injects providers for EVM (EIP-1193 and EIP-6963
discovery), Solana, TON Connect, Tron, Bitcoin and NEAR.

**You bring:** the UI (popup, approval window), the store listing and its account.

The code, and how to publish to the Chrome Web Store, are in the
[Browser extension guide](/guides/extension-kit/).

**Rules:**

- **Show the requesting site's origin** on every approval, from the browser, never from the
  page's own words.
- **Connect is not approve.** A connected site can ask; every signature still needs the user.
- **Store listing hygiene:** the Chrome Web Store account that publishes your extension can
  push an update to every user. Protect it with a hardware key and publish manually.

## Mobile: WalletConnect

On mobile, dApps reach a wallet through WalletConnect (now run by Reown). It is not in the
SDK yet.

**You bring:** [Reown WalletKit](https://docs.reown.com) and a project id from
[reown.com](https://reown.com). Route its session requests (`eth_sendTransaction`,
`personal_sign`, `eth_signTypedData_v4`, `solana_signTransaction`…) to `kit` accounts, so
policies and [review](/build-a-wallet/review-and-safety/) apply to them like to any other
write.

## Mobile: in-app browser

A WebView that injects an EIP-1193 provider into the pages it opens. Requests go to the same
handlers as WalletConnect. Show the page's origin in the address bar and on every approval,
and don't inject into pages served over plain HTTP.

:::caution[Check before you rely on a provider]
WalletConnect / Reown changes its SDKs and project requirements over time. We checked these
links on 2026-10-23. Follow their current docs. A listing here is not an endorsement.
:::
