# Contributing

Thanks for your interest in Any Wallet Kit.

## Pull requests: not accepted yet

The SDK is pre-1.0 and its module contribution process is not open yet. Pull requests from outside the core team are closed automatically, with a pointer back here. Please don't take it personally: when contributions open, this file will describe how a module gets in (conformance suites, a registry entry and a named maintainer).

## Issues: welcome

- **Bug reports.** Include the package and version, where it runs (Node version, React Native / Hermes, browser), the chain, and a minimal reproduction. Never paste a seed phrase or a private key, not even a "test" one that holds funds.
- **Requests.** A chain, a protocol module or an API you are missing. Say what you would build with it.
- **Questions.** Check [docs.anywallet.tech](https://docs.anywallet.tech) first.

## Security

Vulnerabilities go through private reporting, never a public issue: see [SECURITY.md](SECURITY.md).

## Working on a fork

```sh
pnpm install && pnpm build
pnpm test            # Node: every suite
pnpm test:hermes     # the Hermes VM React Native ships
pnpm pack:check      # every package packs as it will publish
pnpm changeset       # one per user-visible change
```

A change is not green until Node and Hermes both are.
