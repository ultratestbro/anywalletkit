// Discovery needs no account and no keys: build the protocol with `undefined`
// and you get a quote-only instance that can still answer what it routes.
//
//   node examples/discover-chains-and-tokens.mjs
//
// Optional: NEAR_INTENTS_JWT for the rate tier tied to your 1Click key.

import NearIntentsSwap2Protocol from "@anywalletkit/protocol-swap2-near-intents";

const protocol = new NearIntentsSwap2Protocol(undefined, {
  fromChain: "eip155:1",
  enabled: true,
  ...(process.env.NEAR_INTENTS_JWT ? {jwt: process.env.NEAR_INTENTS_JWT} : {}),
});

const chains = await protocol.getSupportedChains();
console.log(`chains: ${chains.length}`);
for (const chain of chains) console.log(`  ${chain.id.padEnd(24)} ${chain.name} (native ${chain.nativeToken})`);

// Tokens can be scoped to one leg of a route; unscoped returns the whole catalog.
const tokens = await protocol.getSupportedTokens({toChain: "ton:-239"});
console.log(`\ntokens on ton:-239: ${tokens.length}`);
for (const token of tokens) console.log(`  ${token.symbol.padEnd(8)} ${token.token ?? "(native)"}`);
