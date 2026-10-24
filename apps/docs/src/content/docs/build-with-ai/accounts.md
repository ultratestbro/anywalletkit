---
title: "Accounts and imports"
description: "Multiple accounts from one phrase, imported phrases, private keys and Tonkeeper wallets, and gated export."
sidebar:
  order: 6
---

## What you get

An account switcher on `@anywalletkit/keyring`.

- **Accounts:** add the next account of a phrase; rename, hide or switch accounts.
- **Imports:** another phrase, with discovery of the accounts it has used; a private key, after previewing its address; a Tonkeeper 24-word phrase.
- **Gated screens:** "Show recovery phrase" and "Export private key" need a fresh biometric check every time.

## Before you start

The wallet from [Minimal wallet](/build-with-ai/minimal-wallet/). Tonkeeper imports need the `fast-pbkdf2` Metro resolution from [Installation](/getting-started/installation/#ton-on-metro).

## The prompt

Paste it into your agent as is, in the project folder of the app the earlier prompts built. The raw file is [`prompts/05-accounts.md`](https://github.com/ultratestbro/anywalletkit/blob/main/prompts/05-accounts.md).

```text
Add multiple accounts and imports to this Any Wallet Kit wallet with `@anywalletkit/keyring`.

Read the "Keyring" part of https://docs.anywallet.tech/llms-small.txt (or AGENTS.md in github.com/ultratestbro/anywalletkit) first, and use only APIs that appear there.

- Account switcher: list every account with its name and short addresses. Add account (the next index of the same phrase), rename, hide or unhide, set active. Every screen follows the active account.
- Import another recovery phrase, with discovery of the accounts it has used (any balance counts as used).
- Import a private key for one chain: show the address it gives before saving.
- Import a Tonkeeper-style 24-word TON phrase.
- "Show recovery phrase" and "Export private key" sit behind a fresh biometric / passcode check every time. Block screenshots while either is shown.
- Remove a wallet, together with its accounts and its secret.
- All secrets go through `@anywalletkit/secure-storage-react-native`. Listing accounts never prompts for biometrics. Signing uses one short-lived account per action.

Done when `npx tsc --noEmit` passes and `npx expo export --platform ios` bundles.
```

## What the result looks like

```text
src/wallet/keyring.ts       # Keyring.load, create / import / addAccount / rename / hide / setActive / remove
src/app/accounts/           # switcher, add, rename, hide
src/app/import/             # phrase (discover), private key (preview → confirm), Tonkeeper
src/app/backup/             # re-authenticate → exportSecret / exportPrivateKey, screenshots blocked
```

## Check it works

Check that it builds with `npx tsc --noEmit` and `npx expo export --platform ios`. On a phone build:

1. Add an account and confirm its addresses differ from account 1.
2. Import the same phrase into another wallet app and compare the addresses.
3. Open "Show recovery phrase": it must ask for Face ID every time.

## Common failures

| Symptom | Fix |
|---|---|
| Tonkeeper import throws on the phone | Metro resolves `react-native-fast-pbkdf2` to a throwing stub; use `@anywalletkit/runtime-hermes/fast-pbkdf2` |
| The account list asks for Face ID | Read `listAccounts()` / `AccountMeta.addresses`; only signing and export touch secrets |
| Imported key shows an unexpected address | Always `previewPrivateKey` and ask the user to confirm before `importPrivateKey` |

:::caution[Security]
Never paste a real recovery phrase into an agent chat, a prompt or a test. Use the public test phrase (`abandon abandon … about`) while building, then small amounts on a phone build. Read the diff the agent wrote around keys and signing: nothing should log, store or send the phrase, and every write should pass through a review step. Export screens re-authenticate every time and block screenshots.
:::

## Eval

Passed on the first run: 9 min, 46 turns, $2.83, on top of the Minimal wallet result. Account listing never prompts. Each reveal relies on secure storage's own Face ID / passcode prompt (one prompt, not two), with screenshots blocked.
