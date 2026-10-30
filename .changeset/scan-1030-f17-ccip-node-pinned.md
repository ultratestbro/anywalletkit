---
"@anywalletkit/names-ens": minor
---

On Node, CCIP-Read gateways are asked through the pinned transport (scan 2026-10-30, F17). `ensCcipRequest` checked only the URL text, so a public-looking gateway host that resolves to 127.0.0.1 or a LAN address was connected to.

- Node without `ccip.fetch`: each gateway call runs through `createEnsCcipHandler`'s transport, in process — every DNS answer checked (a host with any private, loopback, link-local, CGNAT or IPv4-carrying IPv6 record is refused), the connection pinned to the checked address, no redirects, the 1 MiB cap and the deadline. It is loaded with a dynamic import from a separate file that package.json's `browser` / `react-native` fields swap for a stub, so browser and React Native bundles contain neither `node:` modules nor `import()`.
- Browsers and other runtimes keep the global fetch; the docs now say there is no DNS-level isolation there and recommend `ensCcipViaProxy`. React Native is unchanged.

**Breaking (Node):** a gateway host whose records mix public and private addresses is refused, and gateways are no longer reached through a global fetch dispatcher (an outbound proxy) or a split-horizon DNS that answers private addresses — pass `ccip: { fetch }` there. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
