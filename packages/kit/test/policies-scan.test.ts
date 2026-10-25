import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { PolicyViolationError, applyPolicies, resolvePrimaryType, type WriteIntent } from '../src/index.js'

/** viem is not a kit dependency; borrow the copy tx-preview-evm (a dependency of conformance) resolves, for hashTypedData only. */
async function viem(): Promise<{ hashTypedData(typed: never): string }> {
  const fromKit = createRequire(import.meta.url)
  const fromConformance = createRequire(fromKit.resolve('@anywalletkit/conformance'))
  const fromPreview = createRequire(fromConformance.resolve('@anywalletkit/tx-preview-evm/package.json'))
  return import(pathToFileURL(fromPreview.resolve('viem')).href) as Promise<{ hashTypedData(typed: never): string }>
}

const ME = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'
const DRAINER = '0x00000000000000000000000000000000DeaDBeef'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const MAX = (1n << 256n) - 1n
const PERMIT_TYPES = [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }]

function evmAccount() {
  const signed: unknown[] = []
  const acc = Object.assign(createMockAccount({ chain: 'eip155:1', address: ME }), {
    signTypedData: async (typed: unknown) => { signed.push(typed); return '0xsig' },
  })
  return { acc, signed }
}

describe('kit policies — EIP-712 (scan F5/F13)', () => {
  it('F5: an undeclared `allowed: false` does not turn an unlimited EIP-2612 permit into a revoke', async () => {
    const { acc, signed } = evmAccount()
    const exploit = { domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC }, types: { Permit: PERMIT_TYPES }, primaryType: 'Permit', message: { owner: ME, spender: DRAINER, value: MAX.toString(), nonce: 0, deadline: '1800000000', allowed: false } }
    await expect(applyPolicies(acc, { blocklist: { 'eip155:1': [DRAINER] } }).signTypedData(exploit)).rejects.toThrow(/Spender .* blocklist/)
    await expect(applyPolicies(acc, { allowlist: { 'eip155:1': [USDC] } }).signTypedData(exploit)).rejects.toBeInstanceOf(PolicyViolationError)
    const seen: WriteIntent[] = []
    await applyPolicies(acc, { confirm: async (i) => { seen.push(i); return true } }).signTypedData(exploit)
    expect(seen[0]).toMatchObject({ kind: 'approval', to: DRAINER, token: USDC, amount: MAX, unlimited: true })
    expect(signed[0]).toBe(exploit) // forwarded untouched (primaryType was explicit)
  })

  it('F5: revoke only from declared fields of the declared type — value uint256 0, or DAI allowed bool false', async () => {
    const { acc } = evmAccount()
    const seen: WriteIntent[] = []
    const strict = applyPolicies(acc, { blocklist: { 'eip155:1': [DRAINER] }, confirm: async (i) => { seen.push(i); return true } })
    await strict.signTypedData({ domain: { verifyingContract: USDC }, types: { Permit: PERMIT_TYPES }, primaryType: 'Permit', message: { owner: ME, spender: DRAINER, value: '0', nonce: 0, deadline: '1' } })
    expect(seen.at(-1)).toMatchObject({ kind: 'revoke', to: DRAINER, token: USDC })
    const daiTypes = [{ name: 'holder', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'allowed', type: 'bool' }]
    await strict.signTypedData({ domain: { verifyingContract: USDC }, types: { Permit: daiTypes }, primaryType: 'Permit', message: { holder: ME, spender: DRAINER, nonce: 0, expiry: 1, allowed: false } })
    expect(seen.at(-1)).toMatchObject({ kind: 'revoke', to: DRAINER })
    // `value` declared with another type is not the EIP-2612 amount
    const oddTypes = PERMIT_TYPES.map((f) => (f.name === 'value' ? { name: 'value', type: 'string' } : f))
    await expect(strict.signTypedData({ domain: { verifyingContract: USDC }, types: { Permit: oddTypes }, primaryType: 'Permit', message: { owner: ME, spender: DRAINER, value: '0', nonce: 0, deadline: '1' } })).rejects.toThrow(/blocklist/)
  })

  it('F13: without primaryType the policy judges the type the signer infers (unique root), not the first key', async () => {
    const { acc, signed } = evmAccount()
    // Permit2 transfer authorisation with the referenced type listed first.
    const exploit = {
      domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
      types: {
        TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
        PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
      },
      message: { permitted: { token: USDC, amount: MAX.toString() }, spender: DRAINER, nonce: '1', deadline: '1800000000' },
    }
    expect(resolvePrimaryType(exploit)).toBe('PermitTransferFrom')
    await expect(applyPolicies(acc, { blocklist: { 'eip155:1': [DRAINER] } }).signTypedData(exploit)).rejects.toThrow(/Spender .* blocklist/)
    const seen: WriteIntent[] = []
    await applyPolicies(acc, { confirm: async (i) => { seen.push(i); return true } }).signTypedData(exploit)
    expect(seen[0]).toMatchObject({ kind: 'approval', to: DRAINER, token: USDC })
    // The signer gets the same struct with the inferred primaryType made explicit — the EIP-712 hash is unchanged.
    const forwarded = signed[0] as typeof exploit & { primaryType: string }
    expect(forwarded.primaryType).toBe('PermitTransferFrom')
    expect({ ...forwarded, primaryType: undefined }).toEqual({ ...exploit, primaryType: undefined })
    const { hashTypedData } = await viem()
    const asViem = (t: object, primaryType: string) => ({ ...(t as Record<string, unknown>), primaryType }) as never
    expect(hashTypedData(asViem(forwarded, forwarded.primaryType))).toBe(hashTypedData(asViem(exploit, 'PermitTransferFrom')))
  })

  it('F13: ambiguous typed data without primaryType is refused like the signer refuses it; explicit primaryType is never second-guessed', async () => {
    const { acc, signed } = evmAccount()
    const ambiguous = { domain: {}, types: { A: [{ name: 'x', type: 'uint256' }], B: [{ name: 'y', type: 'uint256' }] }, message: { x: 1 } }
    const confirm = vi.fn(async () => true)
    await expect(applyPolicies(acc, { confirm }).signTypedData(ambiguous)).rejects.toThrow(/Ambiguous EIP-712 primary type/)
    expect(confirm).not.toHaveBeenCalled()
    expect(signed).toHaveLength(0)
    const explicit = { ...ambiguous, primaryType: 'B' }
    expect(await applyPolicies(acc, { confirm }).signTypedData(explicit)).toBe('0xsig')
    expect(signed[0]).toBe(explicit)
  })
})

describe('kit policies — EVM revoke shape on other chains (scan 2026-10-23 F1)', () => {
  const ZERO_APPROVE = `0x095ea7b3${'0'.repeat(24)}${DRAINER.slice(2).toLowerCase()}${'0'.repeat(64)}`
  const TREASURY = { tron: 'TTreasuryAddressxxxxxxxxxxxxxxxxxx', near: 'treasury.near', solana: 'Treasury1111111111111111111111111111111111' }
  function account(chain: string) {
    const sent: unknown[] = []
    const acc = Object.assign(createMockAccount({ chain, address: 'me' }), {
      sendTransaction: async (tx: unknown) => { sent.push(tx); return { hash: 'h' } },
      signTransaction: async (tx: unknown) => { sent.push(tx); return 'signed' },
    })
    return { acc, sent }
  }
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['tron:728126428', TREASURY.tron, { txID: 'ab', raw_data_hex: '0a02', raw_data: { contract: [{ parameter: { value: { to_address: 'TAttacker', amount: 10n ** 12n } } }] } }],
    ['near:mainnet', TREASURY.near, { receiverId: 'attacker.near', actions: [{ transfer: { deposit: '1000' } }] }],
    ['solana:mainnet', TREASURY.solana, { instructions: [{ programId: '11111111111111111111111111111111', keys: [] }] }],
  ]
  for (const [chain, allowed, payload] of cases) {
    it(`${chain}: a foreign payload with EVM revoke-looking to/data is a send, so the allowlist still applies`, async () => {
      const seen: WriteIntent[] = []
      for (const method of ['sendTransaction', 'signTransaction'] as const) {
        const { acc, sent } = account(chain)
        const guarded = applyPolicies(acc, { allowlist: { [chain]: [allowed] }, confirm: async (i) => { seen.push(i); return true } })
        await expect(guarded[method]({ ...payload, to: 'x', data: ZERO_APPROVE } as never)).rejects.toBeInstanceOf(PolicyViolationError)
        expect(sent).toHaveLength(0)
      }
      expect(seen.every((i) => i.kind !== 'revoke')).toBe(true)
    })
  }

  it('EVM: a plain approve(0x0, id) is a revoke, a zero-approve of a spender is an approval (audit #5); a foreign field makes either a send', async () => {
    const NFT_CLEAR = `0x095ea7b3${'0'.repeat(64)}${'7'.padStart(64, '0')}`
    const seen: WriteIntent[] = []
    const { acc } = account('eip155:1')
    const guarded = applyPolicies(acc, { allowlist: { 'eip155:1': [USDC] }, confirm: async (i) => { seen.push(i); return true } })
    await guarded.sendTransaction({ to: USDC, data: NFT_CLEAR } as never)
    expect(seen.at(-1)).toMatchObject({ kind: 'revoke', token: USDC })
    await expect(guarded.sendTransaction({ to: USDC, data: ZERO_APPROVE } as never)).rejects.toBeInstanceOf(PolicyViolationError)
    await expect(guarded.sendTransaction({ to: USDC, data: NFT_CLEAR, txID: 'ab' } as never)).resolves.toBeDefined()
    expect(seen.at(-1)?.kind).toBe('send')
  })
})

describe('kit policies — hostile input stays linear (scan 2026-10-23 F10/F11)', () => {
  it('F10: an EIP-712 field type of 200 000 "[" resolves in milliseconds, same answer as the signer', () => {
    const types = { Mail: [{ name: 'x', type: '['.repeat(200_000) }, { name: 'p', type: 'Person[2][]' }], Person: [{ name: 'n', type: 'string' }] }
    const t0 = performance.now()
    expect(resolvePrimaryType({ types, domain: {}, message: {} })).toBe('Mail')
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('F11: a serialized Solana transaction of 500 000 "=" plus one char is handled in milliseconds', async () => {
    const { sendDestinations } = await import('../src/destinations.js')
    const hostile = `${'='.repeat(500_000)}A`
    const t0 = performance.now()
    const d = sendDestinations('solana:mainnet', hostile)
    expect(performance.now() - t0).toBeLessThan(200)
    expect(d.unknown).toBe(true)
  })
})
