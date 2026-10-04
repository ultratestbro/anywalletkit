// The point of the router: one registered protocol, every venue behind
// it. Quotes are asked in parallel, validated identically, and scored on price,
// speed and reliability — quoting still needs no account and no key.
//
//   RECIPIENT=<0x…> node examples/auction-across-venues.mjs
//
// Optional: NEAR_INTENTS_JWT, THORCHAIN_AFFILIATE + THORCHAIN_AFFILIATE_BPS.
//
// RECIPIENT must be a real, well-formed address on the DESTINATION chain: the
// venue validates it, and a placeholder comes back as "no route available"
// rather than as a validation error.

import RouterSwidgeProtocol, {
  CrossChainRouter,
  nearIntentsProvider,
  thorchainProvider,
} from "@forgewallet/protocol-swidge-router";

const recipient = process.env.RECIPIENT;
if (!recipient) throw new Error("set RECIPIENT to the destination-chain address");

const affiliate = process.env.THORCHAIN_AFFILIATE;
const affiliateBps = process.env.THORCHAIN_AFFILIATE_BPS;

// `router` is required — there is no implicit singleton, so a browser bundle
// only ever pulls in the venues it actually names here.
const protocol = new RouterSwidgeProtocol(undefined, {
  fromChain: "eip155:1",
  router: new CrossChainRouter([
    nearIntentsProvider({
      enabled: true,
      ...(process.env.NEAR_INTENTS_JWT ? {jwt: process.env.NEAR_INTENTS_JWT} : {}),
    }),
    thorchainProvider({
      enabled: true,
      ...(affiliate && affiliateBps ? {affiliate, affiliateBps} : {}),
    }),
  ]),
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

const quote = await protocol.quoteSwidge(options);

console.log("winning route");
console.log("  in           ", quote.fromTokenAmount);
console.log("  out (quoted) ", quote.toTokenAmount);
console.log("  out (minimum)", quote.toTokenAmountMin);
if (quote.estimatedDuration) console.log("  eta          ", quote.estimatedDuration, "s");
for (const fee of quote.fees) console.log(`  fee ${fee.type} ${fee.amount} ${fee.token}`);

// Executing would be `protocol.swidge({...options, minAmountOut: quote.toTokenAmountMin})`
// with a real account bound in place of `undefined`. Passing the floor from
// the quote you showed the user is the whole safety story: a re-quote below it
// is refused instead of filled at a worse rate.
