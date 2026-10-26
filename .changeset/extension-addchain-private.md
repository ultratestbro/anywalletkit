---
"@anywalletkit/extension-kit": patch
---

`wallet_addEthereumChain` drops private / local RPC hosts (localhost, *.local, 10.x, 172.16–31.x, 192.168.x, 169.254.x, IPv6 loopback / unique-local / link-local) even over https: a page could otherwise point the extension's RPC reads at the user's router or LAN services.
