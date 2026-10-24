# @anywalletkit/protocol-swap2-jupiter

[Jupiter](https://developers.jup.ag/docs/swap) same-chain Solana swaps as a
swap2 provider. It uses Swap API V2's **Router** path (`GET /swap/v2/build`):
Metis on-chain routing, raw instructions, and no Jupiter swap fee. Quotes work
without an API key at 0.5 requests per second. Pass `apiKey` for your plan's
limit; the key is per organisation, so ship it on a server, not inside an app.

```ts
import {jupiterProvider} from "@anywalletkit/protocol-swap2-jupiter/provider";
import {RouterSwap2Protocol} from "@anywalletkit/protocol-swap2-router/swap2/router";

const swap2 = new RouterSwap2Protocol(solanaAccount, {
  fromChain: "solana:mainnet",
  providers: [jupiterProvider({rpcUrls: ["https://your-solana-rpc"]})],
});
const res = await swap2.swap2({fromToken: "SOL", toToken: "USDC", toChain: "solana:mainnet", fromTokenAmount: 100_000_000n, slippageBps: 50});
```

The account must expose swap2's `sendSerializedTransaction` hook
(`@anywalletkit/wallet-solana`'s `sendSerialized` behind it): it simulates the
transaction, proves the balance changes against the quote, signs, and
broadcasts through its own RPC. Jupiter never lands the transaction.

## What is checked before the quote is handed out

`/build` returns instructions; the transaction is assembled here, and only
after all of the following hold:

- the instructions call only Jupiter v6 (`JUP6Lkb…`) and the plumbing a swap
  needs: compute budget, System, SPL Token / Token-2022, Associated Token;
- the taker is the only signer, and there is no tip instruction;
- the swap instruction is `route_v2` or `shared_accounts_route_v2` (ExactIn),
  and its own arguments — the ones the program enforces on-chain — say exactly
  our input amount, the quoted output in the answer, our slippage, and 0 bps
  platform fee and positive-slippage share;
- the answer names the mints and the amount we asked for, as a v0 transaction.

The minimum output (`minDestAmount`) is computed from the instruction:
`quoted × (10 000 − slippage) / 10 000`, rounded down. A `minAmountOut` above
it refuses the quote.

## Compute budget

Jupiter's compute-budget instructions are replaced by ours:

- **price**: Jupiter's suggestion, capped by `maxComputeUnitPrice`
  (default 2 000 000 µlamports/CU);
- **limit**: 1.2× the units a simulation used when `rpcUrls` is set, otherwise
  1 400 000. A failing simulation refuses the quote with the program's error.

The quoted network fee is 5 000 lamports plus `price × limit`.

## Limits

- Solana → Solana only, and the recipient must be the signing wallet: Jupiter
  pays the taker's own token account.
- If the wallet already holds wrapped SOL, the route unwraps all of it into
  SOL. wallet-solana's guard counts the wallet's own wSOL as its SOL, so this
  is neutral and never counted as swap output.
- Quotes live 30 seconds: the blockhash in a `/build` answer expires in about a
  minute.
- Status comes from `getSignatureStatuses` on `rpcUrls`; without them it stays
  `pending`, and the wallet's own receipt is the source of truth.

## Config

```ts
jupiterProvider({
  enabled: true,                        // default
  apiUrl: "https://api.jup.ag/swap/v2", // default
  apiKey: undefined,                    // Developer Platform key → x-api-key
  rpcUrls: [],                          // compute-unit simulation + status
  maxComputeUnitPrice: 2_000_000n,      // µlamports per CU
  computeUnitPricePercentile: undefined,// "medium" | "high" | "veryHigh" | bps
  defaultSlippageBps: 50,               // when the caller names none
});
```

## Activity

`describeActivity` recognizes a Solana transaction whose first non-plumbing
program is Jupiter v6 and where the wallet both gave and received an asset:
"Swapped A → B", counterparty Jupiter. A route that only reaches Jupiter
through another program, or a leg that only sends (a bridge's pre-swap), is
left to other modules. The fixtures are real mainnet swaps.

## Tests

- `tests/codec.test.ts` and `tests/provider.test.ts` replay recorded `/build`
  answers (`fixtures/build-2026-10-23.json`), including tampered ones.
- `tests/conformance.test.ts` runs the SDK's module, activity and behaviour
  suites.
- `JUPITER_LIVE=1 pnpm test`: a live `/build` answer through wallet-solana's
  guard on mainnet for a funded public wallet (simulation only, nothing signed).
