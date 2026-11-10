import { describe, expect, it, vi } from 'vitest'
import { hashTypedData } from 'viem'
import { ApprovalQueue, DEFAULT_NETWORKS, classifySignRequest, createSignHandler, memoryApprovalWindow, type EvmNetwork, type SignApproval } from '../src/index.js'

// Extension audit E55 (2026-11-10): CoW Protocol's `ethsign` scheme accepts personal_sign over the 32-byte EIP-712
// order digest (GPv2Signing.recoverEthsignSigner: "\x19Ethereum Signed Message:\n32" || orderDigest). A phishing site
// sending personal_sign with 32 hex bytes got a valid order with its own receiver and buyAmount = 1; the sheet showed
// a hex blob. Such a request is now refused unless the wallet opts in (`allowBlindHash`), and then marked `blindHash`.
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const ETH = DEFAULT_NETWORKS[0]!
const GPV2_DOMAIN = { name: 'Gnosis Protocol', version: 'v2', chainId: 1, verifyingContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' } as const
const GPV2_ORDER_TYPE = { Order: [
  { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'receiver', type: 'address' }, { name: 'sellAmount', type: 'uint256' },
  { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' }, { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' },
  { name: 'kind', type: 'string' }, { name: 'partiallyFillable', type: 'bool' }, { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' },
] } as const
// Sell 1000 USDC for 1 wei of WETH, paid to the attacker.
const ORDER = {
  sellToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', buyToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', receiver: '0x000000000000000000000000000000000000bEEF',
  sellAmount: 1_000_000_000n, buyAmount: 1n, validTo: 1_900_000_000, appData: `0x${'00'.repeat(32)}`, feeAmount: 0n, kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
} as const
const COW_DIGEST = '0x52eae78642b0ca3226e8a77062bebe97d7e69c10b2c882118503357d84e4e66f'
const classify = (params: unknown[], allowBlindHash?: boolean) => classifySignRequest({ network: ETH, method: 'personal_sign', params, accounts: [ME], origin: 'https://swap.example', ...(allowBlindHash !== undefined ? { allowBlindHash } : {}) })

describe('E55: personal_sign of a 32-byte hash (blind signing)', () => {
  it('the vector: the GPv2 order digest on mainnet', () => {
    expect(hashTypedData({ domain: GPV2_DOMAIN, types: GPV2_ORDER_TYPE, primaryType: 'Order', message: ORDER as never })).toBe(COW_DIGEST)
  })

  it('is refused by default, before any sheet', () => {
    expect(classify([COW_DIGEST, ME])).toMatchObject({ code: 4200, message: expect.stringMatching(/32-byte hash/) })
    expect(classify([ME, COW_DIGEST.toUpperCase().replace('0X', '0x')])).toMatchObject({ code: 4200 })
  })

  it('with the wallet opt-in it reaches the sheet marked `blindHash`; text and other lengths are unaffected', () => {
    expect(classify([COW_DIGEST, ME], true)).toMatchObject({ kind: 'sign-message', blindHash: true, text: COW_DIGEST, raw: COW_DIGEST })
    expect(classify(['0x68656c6c6f', ME])).toMatchObject({ kind: 'sign-message', text: 'hello' })
    expect(classify(['0x68656c6c6f', ME])).not.toHaveProperty('blindHash')
    expect(classify([`${COW_DIGEST}00`, ME])).toMatchObject({ kind: 'sign-message' })
  })

  it('createSignHandler reads the opt-in per request; the 32 raw bytes are what gets signed', async () => {
    const window = memoryApprovalWindow()
    const approvals = new ApprovalQueue(window)
    let allow = false
    const signMessage = vi.fn(async (m: string | Uint8Array) => (typeof m === 'string' ? 'text' : `bytes:${m.length}`))
    const sign = createSignHandler({
      approvals, rpc: async () => { throw new Error('no rpc') },
      signerFor: async () => ({ signer: { signMessage, signTypedData: async () => '0x', signTransaction: async () => '0x' }, dispose: () => undefined }),
      allowBlindHash: () => allow,
    })
    const call = () => sign({ origin: 'https://swap.example', network: ETH as EvmNetwork, method: 'personal_sign', params: [COW_DIGEST, ME], accounts: [ME] })
    await expect(call()).rejects.toMatchObject({ code: 4200 })
    expect(window.opened).toHaveLength(0)
    allow = true
    const p = call()
    for (let i = 0; i < 10 && window.opened.length === 0; i++) await new Promise((r) => setTimeout(r, 0))
    expect((window.opened[0]!.payload as SignApproval).request).toMatchObject({ blindHash: true })
    approvals.resolve(window.opened[0]!.id, null)
    expect(await p).toBe('bytes:32') // the 32 raw bytes are signed (EIP-191 "\n32" prefix): exactly what GPv2 ethsign verifies
  })
})
