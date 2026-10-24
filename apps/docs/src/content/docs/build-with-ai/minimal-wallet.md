---
title: "Minimal wallet (Expo)"
description: "One prompt that builds an Expo wallet: recovery phrase in Face ID-protected storage, addresses and balances on six chains, send with a fee quote and confirmation."
sidebar:
  order: 2
---

## What you get

An Expo (React Native, expo-router) app. It creates or imports a 12-word phrase and keeps it in `@anywalletkit/secure-storage-react-native` through `@anywalletkit/keyring`. The home screen shows account 0's addresses and native balances on Ethereum, Base, Solana, TON, Tron and Bitcoin. A send screen quotes the fee, asks for confirmation through the kit's policies, signs and shows the hash.

## Before you start

- Node 20+, and a Mac with Xcode (or an Android SDK / EAS) for the phone build.
- An empty folder. The agent runs `create-expo-app` itself.
- No keys: the public RPCs in the reference are enough to start. Put your own endpoints in the config file before you ship.

## The prompt

Paste it into your agent as is, in the project folder. The raw file is [`prompts/01-minimal-wallet.md`](https://github.com/ultratestbro/anywalletkit/blob/main/prompts/01-minimal-wallet.md).

```text
Build a minimal self-custodial multichain wallet app with Expo (React Native, TypeScript, expo-router) on Any Wallet Kit, the `@anywalletkit/*` packages.

Before writing code, read the SDK reference for agents: AGENTS.md in github.com/ultratestbro/anywalletkit, then the guides at https://docs.anywallet.tech/llms-small.txt (the API reference is in llms-full.txt). Use only APIs that appear there.

What the app does:
- Onboarding: create a new 12-word recovery phrase (show it once, then ask for 3 of the words back) or import an existing phrase (validate it).
- Keys: `@anywalletkit/keyring` with `@anywalletkit/secure-storage-react-native` as its secret storage (Face ID / Touch ID with passcode fallback); account names and addresses in AsyncStorage. The phrase never leaves secure storage after onboarding.
- Home: account 0's addresses and native balances on Ethereum, Base, Solana, TON, Tron and Bitcoin, with pull to refresh. A failed read shows an error, never 0.
- Send: pick a chain, enter recipient and amount, show the network fee quote, confirm, send, show the transaction hash.
- Install the React Native / Hermes polyfills exactly as the reference says.

Rules: amounts are bigint base units (format for display without Number); all RPC URLs in one config file (public endpoints are fine); never log or store the phrase or keys anywhere else; wrap every write in the kit's policies with a confirm step.

Done when `npx tsc --noEmit` passes and `npx expo export --platform ios` bundles. Then tell me how to run it on a phone (a development or Release build; Expo Go cannot load the secure-storage native module).
```

## What the result looks like

Roughly this. Agents name files differently, and that is fine:

```text
index.js              # imports ./polyfills first, then expo-router/entry
polyfills.js          # getRandomValues, Buffer, TextDecoder, URL, installHermesRuntime()
metro.config.js       # react-native-fast-pbkdf2 → @anywalletkit/runtime-hermes/fast-pbkdf2
src/config.ts         # every RPC URL
src/wallet/           # keyring + secure storage, balances, send, bigint formatting
src/app/onboarding/   # create (show once, confirm 3 words) / import (validate)
src/app/(home)        # addresses + balances, pull to refresh
src/app/send          # chain, recipient, amount → fee → confirm → hash
```

## Check it works

```sh
npx tsc --noEmit
npx expo export --platform ios     # bundles for Hermes: catches polyfill and Metro problems without a device
npx expo prebuild --platform ios && npx expo run:ios --device --configuration Release
```

On the phone: create a wallet, kill the app, reopen it, and Face ID should unlock the same addresses. Then send a tiny amount on a cheap chain.

## Common failures

| Symptom | Fix |
|---|---|
| Metro: `Unable to resolve module react-native-fast-pbkdf2` | Resolve it to `@anywalletkit/runtime-hermes/fast-pbkdf2` in `metro.config.js` and install `expo-crypto` ([Installation](/getting-started/installation/#ton-on-metro)) |
| `crypto.getRandomValues must be defined`, `Buffer is not defined`, `TextDecoder is not defined` | The polyfills are not first: keep them in their own module and import it first from `index.js`; `package.json` `"main"` must point at `index.js` |
| Secure storage throws `not-available` in Expo Go | It is a native module: use a development or Release build |
| `no-passcode` | The device has no passcode; the module refuses to store a secret it cannot protect |
| TON balance needs an unlock | A TON read-only account needs the public key; store it once (see [AGENTS.md](https://github.com/ultratestbro/anywalletkit/blob/main/AGENTS.md)) |
| Signing on Base goes to Ethereum | One EVM network per keyring / registration; open a second keyring for Base ([Keyring: more than one EVM network](/guides/keyring/#more-than-one-evm-network)) |

:::caution[Security]
Never paste a real recovery phrase into an agent chat, a prompt or a test. Use the public test phrase (`abandon abandon … about`) while building, then small amounts on a phone build. Read the diff the agent wrote around keys and signing: nothing should log, store or send the phrase, and every write should pass through a review step. Block screenshots on the phrase screen.
:::

## Eval

Passed on the first run: 13 min, 68 agent turns, $3.63, Claude Code (Opus 5.5) starting from an empty folder. The app typechecked and bundled.

The run found three gaps, now fixed in the SDK and the reference:

- **TON on Metro.** `wallet-ton` needs `react-native-fast-pbkdf2` on Metro. The agent wrote a throwing stub; `runtime-hermes` now ships a working drop-in.
- **Base on the keyring.** Signing on a second EVM network with the keyring needed a pattern; it is now in the Keyring guide and AGENTS.md.
- **TON balances.** A TON balance needs the account's public key; that pattern is in AGENTS.md too.
