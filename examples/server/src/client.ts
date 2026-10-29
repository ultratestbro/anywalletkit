// The "Ship a wallet" docs page renders the #region blocks of this file.
// The app side: everything goes through YOUR server, so no key is in the app bundle.
import type { IWalletAccount, NameResolver } from '@anywalletkit/core'
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import { remoteProvider } from '@anywalletkit/protocol-swap2-core/remote'
import type { RemotePins } from '@anywalletkit/protocol-swap2-core/types'
import { RouterSwap2Protocol } from '@anywalletkit/protocol-swap2-router'
import { lifiPins } from '@anywalletkit/protocol-swap2-lifi/provider'
import { thorchainPins } from '@anywalletkit/protocol-swap2-thorchain/provider'
import { chainflipPins } from '@anywalletkit/protocol-swap2-chainflip/config'
import { ensCcipViaProxy, ensResolver } from '@anywalletkit/names-ens'

// #region client-rpc
/** An EIP-1193 provider over the server's RPC proxy (it adds the upstream key). */
export function serverRpc(api: string, chain: string, token: string, fetchImpl: typeof fetch = fetch) {
  let id = 0
  return {
    async request({ method, params }: { method: string; params?: unknown }) {
      const res = await fetchImpl(`${api}/rpc/${chain}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }),
      })
      const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } }
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code })
      return body.result
    },
  }
}

export function walletOverServer(phrase: string, api: string, token: string, fetchImpl?: typeof fetch): Wallet {
  const wallet = new Wallet(phrase)
  wallet.registerWallet('eip155:1', WalletManagerEvm, { provider: serverRpc(api, 'eip155:1', token, fetchImpl) as never, chainId: 1 })
  wallet.registerWallet('eip155:8453', WalletManagerEvm, { provider: serverRpc(api, 'eip155:8453', token, fetchImpl) as never, chainId: 8453 })
  return wallet
}
// #endregion client-rpc

// #region client-swaps
/**
 * What the app trusts for each provider on the server: the contracts its calldata may call and approve,
 * and THORChain's check of each build against two THORNodes. A remote provider without pins gets no
 * calldata route at all; NEAR Intents pays a deposit address and needs none.
 */
const PINS: Readonly<Record<string, RemotePins>> = { lifi: lifiPins, thorchain: thorchainPins(), chainflip: chainflipPins }

/** The same router the app would build locally, but every provider runs on the server. */
export function swapsOverServer(account: IWalletAccount, api: string, token: string, names = ['lifi', 'near_intents', 'thorchain', 'chainflip'], fetchImpl?: typeof fetch) {
  const remote = (name: string) => remoteProvider({
    name, baseUrl: `${api}/swap2`, headers: { authorization: `Bearer ${token}` }, ...PINS[name],
    // https in production; plain http only for a server on this machine (the tests).
    ...(/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(api) ? { allowInsecureBaseUrl: true } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  })
  return new RouterSwap2Protocol(account, {
    fromChain: account.chain,
    providers: names.map(remote), // the names the server's providers carry
    prefer: 'best',
  })
}
// #endregion client-swaps

// #region client-names
/**
 * ENS names on React Native: offchain names (cb.id, Basenames, uni.eth) ask their CCIP-Read gateways through
 * the server's `/ccip` route, because the device's fetch cannot refuse a gateway's redirect.
 */
export function namesOverServer(api: string, token: string, ethereumRpc: string): NameResolver {
  return ensResolver({
    rpcUrl: ethereumRpc,
    ccip: {
      fetch: ensCcipViaProxy(`${api}/ccip`, {
        headers: { authorization: `Bearer ${token}` },
        // https in production; plain http only for a server on this machine (the tests).
        allowInsecureProxyUrl: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(api),
      }),
    },
  })
}
// #endregion client-names
