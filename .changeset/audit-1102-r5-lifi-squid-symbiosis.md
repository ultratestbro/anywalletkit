---
"@anywalletkit/protocol-swap2-lifi": patch
---

LI.FI routes through Squid and Symbiosis are no longer accepted, and cross-chain requests now ask LI.FI to route around them (`denyBridges=squid,symbiosis`, also in the route-options request), the way Relay and Garden already were. Neither ties where the funds go to the recipient the app reviews: Squid's route that bridges to it first runs arbitrary calls with the funds (LI.FI's Squid quotes were already refused, as they hand the funds to a destination call), and Symbiosis's main path names the final recipient and its revert address in calldata the Diamond forwards unchecked. Pairs they would have served get another bridge from LI.FI, or another provider. An app's route policy (`chooseRoute` → `allowBridges`) cannot re-enable them. Nothing to change in apps.
