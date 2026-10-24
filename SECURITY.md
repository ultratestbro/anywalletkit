# Security policy

Any Wallet Kit handles keys and signs transactions, so we treat security reports as the top priority.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting**: the "Report a vulnerability" button on the repository's Security tab ([direct link](https://github.com/ultratestbro/anywalletkit/security/advisories/new)). Please do not open a public issue or pull request for a security problem.

Include:
- the affected package(s) and version or commit;
- what an attacker gains (funds, keys, a wrong signature, a misleading review screen…) and the preconditions;
- a proof of concept or the steps to reproduce.

We confirm receipt, keep you updated while we fix it, and credit you in the advisory unless you prefer otherwise. Please give us a reasonable time to ship a fix before you disclose publicly.

## Scope

In scope: every package under `packages/`. That covers key derivation and storage, signing, transaction building and review, policies, swap / bridge / earn modules, and the checks they run before a user signs.

Out of scope:
- third-party services the modules call (provider APIs, RPC nodes, indexers) — report those to their owners;
- apps built on the SDK — report those to the app's developers;
- issues that need a compromised device, a malicious dependency you installed yourself, or an already-leaked seed.

## Supported versions

Before 1.0, only the latest published `0.x` release of each package gets security fixes.
