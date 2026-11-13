---
"@anywalletkit/protocol-swap2-core": minor
---

`nativeFeeCeiling` on the engine config (`Swap2EngineConfig`, so on every swap2 protocol and the router): the app's
own cap for the native fee a route charges on top of the input (a bridge's messaging fee). The engine asks it for every
execution pass whose quote declares a native fee, before that pass's review and approvals (once, unless the quote
expires during an approval and the engine re-quotes: the fresh quote is asked again), with
`{provider, intentId, fromChain, destChain, nativeFee, defaultCap, maxCeiling}` (`Swap2NativeFeeCeilingContext`). A
non-negative `bigint` is the cap for that execution in place of the chain's own (higher or lower; `0n` refuses any
fee); `undefined` keeps the chain's cap. Anything else (a number, a string, `null`, a Promise), a throw, or a value
above `NATIVE_FEE_CEILING_MAX_MULTIPLE` (20) × the chain's cap (0.1 ETH on Ethereum and the ETH-denominated L2s,
2000 CELO on Celo) refuses the execution with a `Swap2ConfigurationError` ("swap2: nativeFeeCeiling returned … not a
non-negative bigint or undefined", "… threw for …", "… above the hard maximum …"); no answer removes the cap. A fee
above the chosen cap is refused with the existing text ("swap2: quoted native fee <fee> exceeds the cap <cap> for
<chain>"). Without the hook nothing changes: same caps, same texts.

It lets an app run USDT0 Legacy Mesh into Tron, whose LayerZero fee (0.005341 ETH / 170.5 CELO on 2026-11-12, 0.006676
ETH / 213.1 CELO with the provider's 25 % headroom) is above the default caps, without raising them for every route:
match provider `"usdt0"`, destination `"tron:728126428"` and the Tron eid 30420 in the intent id
(`usdt0-mesh:<srcEid>:30420`), and name 0.01 ETH for Ethereum and Arbitrum and 300 CELO for Celo. Only execution
applies a native-fee cap: `quoteSwap2` and the router's route list do not, as before.
