---
"@anywalletkit/networks": minor
---

`parseUrl` refuses a URL with a backslash, a tab, CR/LF or another control character anywhere in it, and treats `\` as the end of the authority. A WHATWG parser (browsers, Node, the extension's service worker) and OkHttp end the host at a backslash, so `https://192.168.1.1\admin` was checked as the public host `192.168.1.1\admin` and fetched from 192.168.1.1. This closes the gap for every caller of the shared policy: `checkRpcUrl`, `parseAddChainParams`, `isPublicHttpsUrl`, extension-kit's `wallet_addEthereumChain` RPC filter and names-ens gateway and avatar checks.

**Breaking:** URLs containing `\`, a tab, CR, LF or another control character are refused (`checkRpcUrl` answers `not-a-url`, `isPublicHttpsUrl` answers false, a site's `rpcUrls` entry is dropped).
