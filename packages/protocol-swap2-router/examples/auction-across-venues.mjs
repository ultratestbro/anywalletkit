// The optional aggregator: install the provider modules you want, pass them in,
// get one protocol that auctions a route across all of them. Quotes are asked in
// parallel, validated identically, and scored on price, speed and reliability —
// quoting still needs no account and no key.
//
//   npm i @forgewallet/protocol-swap2-router \
//         @forgewallet/protocol-swap2-near-intents @forgewallet/protocol-swap2-thorchain
//
//   RECIPIENT=<0x…> node examples/auction-across-venues.mjs
//
// Optional: NEAR_INTENTS_JWT, THORCHAIN_AFFILIATE + THORCHAIN_AFFILIATE_BPS.
//
// RECIPIENT must be a real, well-formed address on the DESTINATION chain: the
// venue validates it, and a placeholder comes back as "no route available"
// rather than as a validation error.

import RouterSwap2Protocol from "@forgewallet/protocol-swap2-router";
import {nearIntentsProvider} from "@forgewallet/protocol-swap2-near-intents/provider";
import {thorchainProvider} from "@forgewallet/protocol-swap2-thorchain/provider";

const recipient = process.env.RECIPIENT;
if (!recipient) throw new Error("set RECIPIENT to the destination-chain address");

const affiliate = process.env.THORCHAIN_AFFILIATE;
const affiliateBps = process.env.THORCHAIN_AFFILIATE_BPS;

// Only the providers named here are installed and bundled.
const protocol = new RouterSwap2Protocol(undefined, {
  fromChain: "eip155:1",
  providers: [
    nearIntentsProvider({
      enabled: true,
      ...(process.env.NEAR_INTENTS_JWT ? {jwt: process.env.NEAR_INTENTS_JWT} : {}),
    }),
    thorchainProvider({
      enabled: true,
      ...(affiliate && affiliateBps ? {affiliate, affiliateBps} : {}),
    }),
  ],
});

const options = {
  // Source tokens are catalog symbols; destination tokens are the chain's own
  // identifier — a contract address here, a mint on Solana, a jetton on TON.
  // Passing a symbol as `toToken` is the most common way to get "no route".
  fromToken: "USDT",
  toToken: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT0 on Arbitrum
  toChain: "eip155:42161",
  fromTokenAmount: 25_000_000n, // 25 USDT, 6 decimals
  recipient,
};

const quote = await protocol.quoteSwap2(options);

console.log("winning route");
console.log("  in           ", quote.fromTokenAmount);
console.log("  out (quoted) ", quote.toTokenAmount);
console.log("  out (minimum)", quote.toTokenAmountMin);
if (quote.estimatedDuration) console.log("  eta          ", quote.estimatedDuration, "s");
for (const fee of quote.fees) console.log(`  fee ${fee.type} ${fee.amount} ${fee.token}`);

// Executing would be `protocol.swap2({...options, minAmountOut: quote.toTokenAmountMin})`
// with a real wallet account bound in place of `undefined`. Passing the floor from
// the quote you showed the user is the whole safety story: a re-quote below it
// is refused instead of filled at a worse rate.
