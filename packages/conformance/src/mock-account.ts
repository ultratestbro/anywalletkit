import type { IWalletAccount, IWalletAccountReadOnly, Receipt, TransferOptions, TransferResult } from '@anywalletkit/core'

export interface MockCall { method: string; args: unknown[] }

export interface MockAccountOptions {
  chain?: string
  address?: string
  balance?: bigint
  tokenBalances?: Record<string, bigint>
  fee?: bigint
  /** Receipt returned for any hash; default a successful one. */
  receipt?: Receipt | undefined
  /** Also expose swap2's `sendSerializedTransaction` hook (Solana aggregator legs), recorded in `sent` with its expectation. */
  serialized?: boolean
}

/**
 * An account that records every call. Protocol module unit tests use it to
 * prove that `quote*` never sends and that writes go through `sendTransaction`.
 */
export function createMockAccount(opts: MockAccountOptions = {}): IWalletAccount & { calls: MockCall[]; sent: unknown[] } {
  const calls: MockCall[] = []
  const sent: unknown[] = []
  const rec = <T>(method: string, args: unknown[], value: T): T => { calls.push({ method, args }); return value }
  const address = opts.address ?? '0x000000000000000000000000000000000000dEaD'
  const fee = opts.fee ?? 21_000n
  let n = 0
  const nextHash = () => `0x${(++n).toString(16).padStart(64, '0')}`

  const readOnly: IWalletAccountReadOnly = {
    chain: opts.chain ?? 'eip155:1',
    getAddress: async () => rec('getAddress', [], address),
    getBalance: async () => rec('getBalance', [], opts.balance ?? 0n),
    getTokenBalance: async (token) => rec('getTokenBalance', [token], opts.tokenBalances?.[token] ?? 0n),
    quoteSendTransaction: async (tx) => rec('quoteSendTransaction', [tx], { fee }),
    quoteTransfer: async (o: TransferOptions) => rec('quoteTransfer', [o], { fee }),
    getTransactionReceipt: async (hash) => rec('getTransactionReceipt', [hash], 'receipt' in opts ? opts.receipt : { hash, status: 1 as const }),
    verify: async (m, s) => rec('verify', [m, s], true),
  }
  const account: IWalletAccount & { calls: MockCall[]; sent: unknown[] } = {
    ...readOnly,
    calls, sent,
    needsNetwork: false,
    sign: async (m) => rec('sign', [m], '0xsig'),
    signTransaction: async (tx) => rec('signTransaction', [tx], '0xsigned'),
    sendTransaction: async (tx): Promise<TransferResult> => { sent.push(tx); return rec('sendTransaction', [tx], { hash: nextHash(), fee }) },
    transfer: async (o): Promise<TransferResult> => { sent.push(o); return rec('transfer', [o], { hash: nextHash(), fee }) },
    toReadOnlyAccount: () => readOnly,
    dispose: () => { rec('dispose', [], undefined) },
  }
  if (opts.serialized) {
    Object.assign(account, {
      sendSerializedTransaction: async (serializedTx: string, expect: unknown): Promise<TransferResult> => { sent.push({ serializedTx, expect }); return rec('sendSerializedTransaction', [serializedTx, expect], { hash: nextHash(), fee }) },
    })
  }
  return account
}
