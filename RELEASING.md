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
   - **mode `dry-run`** runs the full gate, packs every package that is not on npm yet and `npm publish --dry-run`s the packed tarballs. The gate is build, typecheck, tests, registry, examples, Hermes and `pack:check`.
   - **mode `publish`** runs the same gate and packs. The `publish` job then waits for approval in the `npm` environment and publishes the packed tarballs (dependencies first); the `tag` job pushes one tag per published package, `@anywalletkit/<name>@<version>`.
   - Privileges are split: install, build and pack run in the `pack` job with a read-only token; the `publish` job holds the publish credential (the `NPM_TOKEN` secret today, the OIDC token once trusted publishing is on, see below) and runs no install and no build — only `npm publish <tarball> --provenance --ignore-scripts` over the `pack` job's artifact; only the `tag` job can push. No checkout keeps its credentials.
3. Versions already on npm are skipped, so re-running after a partial failure is safe. A package npm refuses does not stop the run: it and the packages that depend on it are held back, everything else is published and tagged, and the run ends red with the list.

Locally, `pnpm release:dry` does the same dry run (without provenance, which only exists in CI). The two halves the workflow runs are `node scripts/publish.mjs --pack-only --out <dir>` and `node scripts/publish.mjs --from <dir> [--dry-run]`.

## One-time setup

**npm**
- Create the `anywalletkit` organization, with 2FA required for every member.
- **Publish credential today: a token.** A granular access token with read and write on `@anywalletkit/*`, "bypass 2FA" on, no IP allowlist, **expiring after 30 days**, stored as the `NPM_TOKEN` secret of the `npm` environment. Trusted publishing is postponed (decided 2026-10-27): once it is configured, npm answers publishes with HTTP 429, a known npm problem that npm says it will fix by the end of 2026.
- **Rotate the token before it expires.** On npmjs.com create a new granular token with the same settings, copy it, then
  ```sh
  pbpaste | gh secret set NPM_TOKEN --env npm -R ultratestbro/anywalletkit
  gh api repos/ultratestbro/anywalletkit/environments/npm/secrets   # updated_at is now
  ```
  so the token never lands in a file, a chat or the shell history, and revoke the old token. An expired token fails the `publish` job.
- npm has announced that 2FA-bypass tokens lose direct publishing around January 2027. If that comes before the 429 fix, publishing stops on both paths; check the npm changelog at every rotation.
- **Later: trusted publishing** for each package: provider GitHub Actions, repository `ultratestbro/anywalletkit`, workflow `release.yml`, environment `npm`. Some packages already have a connection with the repository misspelled `anywalletkey` (aave, kamino, approvals, names-ens, kit); fix those. Then delete the `NPM_TOKEN` secret and the token and set every package to "disallow tokens", so no token is stored anywhere.

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
