Create a Node.js (TypeScript, Node 22, ESM) payout bot on Any Wallet Kit, the `@anywalletkit/*` packages.

Read https://docs.anywallet.tech/llms-small.txt (or AGENTS.md in github.com/ultratestbro/anywalletkit) first, and use only APIs that appear there.

- Input: a CSV of `address,amount` rows, with amounts in USDC (6 decimals). Payouts go out in USDC on Base from account 0 of the seed phrase in the `WALLET_SEED_PHRASE` env var.
- Safety:
  - kit policies with an allowlist of exactly the CSV's recipients and a max-fee cap;
  - checksum-validate every address;
  - refuse duplicates and amounts above a configurable per-row limit;
  - check the USDC and ETH balances before starting.
- Dry run by default: quote each transfer's fee and print the plan and the total; nothing is signed. `--send` actually sends.
- Idempotent: a JSON journal records each row as pending, sent (with its hash) or failed, written before and after every send. A restart never pays a row twice, and a row whose outcome is unknown stays pending for a human. No automatic retries.
- Never print or write the seed phrase or keys. Log addresses, amounts and hashes only. Dispose the wallet on exit, including Ctrl-C.
- Add a README that covers setup, the env vars, a dry run, and the key-handling rules.

Done when `npx tsc --noEmit` passes, a unit test covers the CSV and journal logic, and the dry run works against a sample CSV. Use the public test phrase `test test test test test test test test test test test junk`, which has no funds, so the run shows the plan with zero balances.
