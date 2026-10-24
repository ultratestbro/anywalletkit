# Releasing

Packages reach npm only through the `release` workflow. Every package is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so anyone can check which commit and workflow built it.

## Every release

1. Changes carry changesets (`pnpm changeset`). To cut a release:
   ```sh
   pnpm changeset version     # bumps package.json versions, writes CHANGELOG.md files
   pnpm install               # refreshes the lockfile for the new versions
   git commit -am "chore: release" && git push
   ```
2. Actions → **release** → Run workflow:
   - **mode `dry-run`** runs the full gate and then packs and `npm publish --dry-run`s every package that is not on npm yet. The gate is build, typecheck, tests, registry, examples, Hermes and `pack:check`.
   - **mode `publish`** runs the same gate. The `publish` job then waits for approval in the `npm` environment, publishes the new versions (dependencies first) and pushes one tag per package, `@anywalletkit/<name>@<version>`.
3. Versions already on npm are skipped, so re-running after a partial failure is safe.

Locally, `pnpm release:dry` does the same dry run (without provenance, which only exists in CI).

## One-time setup

**npm**
- Create the `anywalletkit` organization, with 2FA required for every member.
- Configure **trusted publishing** for each package: provider GitHub Actions, repository `ultratestbro/anywalletkit`, workflow `release.yml`, environment `npm`. Then no token is stored anywhere.
- If npm only allows trusted publishers on packages that already exist, the very first release uses a short-lived granular token with publish rights on `@anywalletkit/*`. Store it as the `NPM_TOKEN` secret of the `npm` environment. Delete the secret and the token right after the first publish, then switch every package to trusted publishing and "disallow tokens".

**GitHub** (after the repo becomes public)
- Actions enabled.
- Environment `npm`: the owner is a required reviewer; deployments only from `main`.
- Security → private vulnerability reporting: on.
- A ruleset on `main`: no force-push or deletion; the `ci` checks are required.

## Launch checklist

- [ ] License confirmed (Apache-2.0).
- [ ] `pnpm changeset version` committed: the first public versions and CHANGELOGs.
- [ ] Repository public, and the GitHub settings above done.
- [ ] `release` in dry-run mode is green, then `release` in publish mode.
- [ ] Docs: drop the `robots: noindex` meta and the "not on npm yet" line in `apps/docs/astro.config.mjs`, then `pnpm run deploy` in `apps/docs`.
- [ ] README: drop "Not on npm yet."
- [ ] Landing: the docs link goes live.
