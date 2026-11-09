import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { PERMIT2_ADDRESS, UNISWAP_UNIVERSAL_ROUTERS, UNISWAP_UNIVERSAL_ROUTER_LABEL, describeTypedData, permit2KnownSpender } from '../src/index.js'

// Extension audit 2026-11-09 E3, round two: `spender-unknown` fired for every Permit2 grant, Uniswap's own
// router included, so the one warning that matters on a drainer's grant was also on every ordinary swap.
// The Universal Router deployments are pinned per chain and a Permit2 grant to one of them, signed for that
// chain, carries a label instead of the warning. Nothing else is on the list.
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ATTACKER = '0x000000000000000000000000000000000000bEEF'
const future = BigInt(Math.floor(Date.now() / 1000) + 3600)
const codes = (d: { warnings: Array<{ code: string }> }) => d.warnings.map((w) => w.code)

const ENTRIES = Object.entries(UNISWAP_UNIVERSAL_ROUTERS).flatMap(([chain, list]) => list.map((e) => ({ chainId: Number(chain), ...e })))
const MAINNET_V2 = '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af'
// World Chain's 1.2 router sits at the address that is Uniswap's V2 Router02 on Ethereum.
const WORLD_CHAIN_V1_2 = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'

type Domain = { name?: string; chainId?: number; verifyingContract?: string }
const DOMAIN = (chainId: number): Domain => ({ name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS })
const transferFrom = (spender: string, domain: Domain, amount = 5_000_000n) => ({
  domain,
  primaryType: 'PermitTransferFrom',
  types: {
    PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
    TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  },
  message: { permitted: { token: USDC, amount }, spender, nonce: 7n, deadline: future },
})
const DETAILS = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }]
const permitSingle = (spender: string, domain: Domain, amount = 5_000_000n) => ({
  domain,
  primaryType: 'PermitSingle',
  types: { PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], PermitDetails: DETAILS },
  message: { details: { token: USDC, amount, expiration: 1900000000, nonce: 0 }, spender, sigDeadline: future },
})
const permitBatch = (spender: string, domain: Domain) => ({
  domain,
  primaryType: 'PermitBatch',
  types: { PermitBatch: [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], PermitDetails: DETAILS },
  message: { details: [{ token: USDC, amount: 10n, expiration: 1900000000, nonce: 0 }], spender, sigDeadline: future },
})

describe('E3 round two: the pinned Universal Router table', () => {
  it('Permit2 is the canonical address, checksummed', () => {
    expect(PERMIT2_ADDRESS).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3')
    expect(getAddress(PERMIT2_ADDRESS)).toBe(PERMIT2_ADDRESS)
  })

  it('19 chains, 65 deployments — a change to the table is a change to this number', () => {
    expect(Object.keys(UNISWAP_UNIVERSAL_ROUTERS)).toHaveLength(19)
    expect(ENTRIES).toHaveLength(65)
  })

  it.each(ENTRIES)('chain $chainId $address ($version): a checksummed 20-byte address with its version and source', ({ chainId, address, version, source }) => {
    expect(Number.isSafeInteger(chainId) && chainId > 0).toBe(true)
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(getAddress(address)).toBe(address)
    expect(BigInt(address)).not.toBe(0n)
    expect(address).not.toBe(PERMIT2_ADDRESS)
    expect(['1.2', '2.0', '2.1.1', '2.1.2', '2.2.0', 'unversioned']).toContain(version)
    const sources = source.split('+')
    expect(sources.length).toBeGreaterThan(0)
    for (const s of sources) expect(['repo', 'sdk', 'docs-v4', 'docs-v3']).toContain(s)
    expect(new Set(sources).size).toBe(sources.length)
  })

  it.each(Object.entries(UNISWAP_UNIVERSAL_ROUTERS))('chain %s lists no address twice', (_chain, list) => {
    expect(list.length).toBeGreaterThan(0)
    expect(new Set(list.map((e) => e.address.toLowerCase())).size).toBe(list.length)
  })

  it('the table cannot be changed at run time', () => {
    expect(Object.isFrozen(UNISWAP_UNIVERSAL_ROUTERS)).toBe(true)
    for (const list of Object.values(UNISWAP_UNIVERSAL_ROUTERS)) {
      expect(Object.isFrozen(list)).toBe(true)
      for (const e of list) expect(Object.isFrozen(e)).toBe(true)
    }
    // A caller that did add an entry gets no label for it: the lookup does not read the exported object.
    try { (UNISWAP_UNIVERSAL_ROUTERS as Record<number, unknown>)[100] = [{ address: ATTACKER, version: '2.0', source: 'repo' }] } catch { /* frozen */ }
    expect(permit2KnownSpender(100, ATTACKER)).toBeUndefined()
  })

  it.each(ENTRIES)('permit2KnownSpender($chainId, $address) is the Universal Router, in any letter case', ({ chainId, address }) => {
    expect(permit2KnownSpender(chainId, address)).toBe(UNISWAP_UNIVERSAL_ROUTER_LABEL)
    expect(permit2KnownSpender(chainId, address.toLowerCase())).toBe(UNISWAP_UNIVERSAL_ROUTER_LABEL)
  })

  it('permit2KnownSpender: the same address on a chain where it is not listed, any other address, a chain with no entry', () => {
    expect(permit2KnownSpender(1, MAINNET_V2)).toBe('Uniswap Universal Router')
    expect(permit2KnownSpender(8453, MAINNET_V2)).toBeUndefined()
    expect(permit2KnownSpender(100, MAINNET_V2)).toBeUndefined()
    expect(permit2KnownSpender(480, WORLD_CHAIN_V1_2)).toBe('Uniswap Universal Router')
    expect(permit2KnownSpender(1, WORLD_CHAIN_V1_2)).toBeUndefined()
    expect(permit2KnownSpender(1, ATTACKER)).toBeUndefined()
    expect(permit2KnownSpender(1, PERMIT2_ADDRESS)).toBeUndefined()
    expect(permit2KnownSpender(1, '')).toBeUndefined()
    expect(permit2KnownSpender(undefined, MAINNET_V2)).toBeUndefined()
    expect(permit2KnownSpender(Number.NaN, MAINNET_V2)).toBeUndefined()
  })
})

describe('E3 round two: a Permit2 grant to the Universal Router of its chain', () => {
  it.each(ENTRIES)('chain $chainId $address: labelled, no spender-unknown', ({ chainId, address }) => {
    const d = describeTypedData(transferFrom(address, DOMAIN(chainId)), { chainId, account: ME })
    expect(d.kind).toBe('permit2')
    expect(d.permit2).toMatchObject({ spender: address, spenderLabel: 'Uniswap Universal Router' })
    expect(codes(d)).toEqual([])
  })

  it('every Permit2 form: PermitTransferFrom, PermitSingle, PermitBatch', () => {
    for (const typed of [transferFrom(MAINNET_V2, DOMAIN(1)), permitSingle(MAINNET_V2, DOMAIN(1)), permitBatch(MAINNET_V2, DOMAIN(1))]) {
      const d = describeTypedData(typed, { chainId: 1, account: ME })
      expect(d.permit2?.spenderLabel).toBe('Uniswap Universal Router')
      expect(codes(d)).not.toContain('spender-unknown')
    }
  })

  it('the spender as a dapp sends it (lower case) is matched too', () => {
    const d = describeTypedData(permitSingle(MAINNET_V2.toLowerCase(), DOMAIN(1)), { chainId: 1, account: ME })
    expect(d.permit2).toMatchObject({ spender: MAINNET_V2.toLowerCase(), spenderLabel: 'Uniswap Universal Router' })
    expect(codes(d)).toEqual([])
  })

  it('the other warnings stay: an unlimited allowance to the router is still flagged as unlimited', () => {
    const d = describeTypedData(permitSingle(MAINNET_V2, DOMAIN(1), (1n << 160n) - 1n), { chainId: 1, account: ME })
    expect(d.permit2?.spenderLabel).toBe('Uniswap Universal Router')
    expect(codes(d)).toEqual(['approve-unlimited'])
  })

  it('no context at all: the signed domain alone decides', () => {
    const d = describeTypedData(permitSingle(MAINNET_V2, DOMAIN(1)))
    expect(d.permit2?.spenderLabel).toBe('Uniswap Universal Router')
    expect(codes(d)).toEqual([])
  })
})

describe('E3 round two: spender-unknown still fires', () => {
  it('the same address on a chain where it is not listed', () => {
    // Ethereum's router address, signed for Base and for Gnosis (no Uniswap deployment in the table).
    for (const chainId of [8453, 100]) {
      const d = describeTypedData(permitSingle(MAINNET_V2, DOMAIN(chainId)), { chainId, account: ME })
      expect(d.permit2?.spenderLabel).toBeUndefined()
      expect(codes(d)).toContain('spender-unknown')
      expect(d.warnings.find((w) => w.code === 'spender-unknown')!.message).toContain(MAINNET_V2)
    }
    // World Chain's 1.2 router address is another contract on Ethereum.
    expect(codes(describeTypedData(permitSingle(WORLD_CHAIN_V1_2, DOMAIN(480)), { chainId: 480, account: ME }))).toEqual([])
    expect(codes(describeTypedData(permitSingle(WORLD_CHAIN_V1_2, DOMAIN(1)), { chainId: 1, account: ME }))).toContain('spender-unknown')
  })

  it('any other spender, on every chain of the table', () => {
    for (const chain of Object.keys(UNISWAP_UNIVERSAL_ROUTERS)) {
      const chainId = Number(chain)
      const d = describeTypedData(transferFrom(ATTACKER, DOMAIN(chainId)), { chainId, account: ME })
      expect(d.permit2?.spenderLabel).toBeUndefined()
      expect(codes(d)).toContain('spender-unknown')
    }
  })

  it('the signed chain decides, not the account chain: a grant signed for Base naming the Ethereum router', () => {
    const d = describeTypedData(permitSingle(MAINNET_V2, DOMAIN(8453)), { chainId: 1, account: ME })
    expect(codes(d)).toEqual(expect.arrayContaining(['chain-mismatch', 'spender-unknown']))
  })

  it('a domain with no chain id', () => {
    const d = describeTypedData(permitSingle(MAINNET_V2, { name: 'Permit2', verifyingContract: PERMIT2_ADDRESS }), { chainId: 1, account: ME })
    expect(d.permit2?.spenderLabel).toBeUndefined()
    expect(codes(d)).toContain('spender-unknown')
  })

  it('a verifying contract that is not Permit2 (or none): the list is for Permit2 grants only', () => {
    for (const domain of [{ name: 'Permit2', chainId: 1, verifyingContract: ATTACKER }, { name: 'Permit2', chainId: 1 }]) {
      const d = describeTypedData(permitSingle(MAINNET_V2, domain), { chainId: 1, account: ME })
      expect(d.permit2?.spenderLabel).toBeUndefined()
      expect(codes(d)).toContain('spender-unknown')
    }
  })

  it('an EIP-2612 token permit to the router: the list does not cover token permits', () => {
    const d = describeTypedData({
      domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
      primaryType: 'Permit',
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      message: { owner: ME, spender: MAINNET_V2, value: 5n, nonce: 0n, deadline: future },
    }, { chainId: 1, account: ME })
    expect(d.kind).toBe('permit')
    expect(d.permit?.spenderLabel).toBeUndefined()
    expect(codes(d)).toContain('spender-unknown')
  })

  it('a spender that is not declared as an address is unreadable, whatever the message says', () => {
    const t = permitSingle(MAINNET_V2, DOMAIN(1))
    const d = describeTypedData({ ...t, types: { ...t.types, PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'sigDeadline', type: 'uint256' }] } }, { chainId: 1, account: ME })
    expect(d.permit2).toMatchObject({ spender: '' })
    expect(d.permit2?.spenderLabel).toBeUndefined()
    expect(codes(d)).toContain('spender-unknown')
  })
})

describe('E3 round two: the caller hook is kept', () => {
  it('knownSpenders still labels any spender, and wins over the built-in label', () => {
    const own = describeTypedData(permitSingle(ATTACKER, DOMAIN(1)), { chainId: 1, account: ME, knownSpenders: { [ATTACKER]: 'My router' } })
    expect(own.permit2?.spenderLabel).toBe('My router')
    expect(codes(own)).toEqual([])
    const both = describeTypedData(permitSingle(MAINNET_V2, DOMAIN(1)), { chainId: 1, account: ME, knownSpenders: { [MAINNET_V2]: 'Uniswap (app label)' } })
    expect(both.permit2?.spenderLabel).toBe('Uniswap (app label)')
  })

  it('knownSpenders for another address does not switch the built-in list off', () => {
    const d = describeTypedData(permitSingle(MAINNET_V2, DOMAIN(1)), { chainId: 1, account: ME, knownSpenders: { [ATTACKER]: 'My router' } })
    expect(d.permit2?.spenderLabel).toBe('Uniswap Universal Router')
    expect(codes(d)).toEqual([])
  })
})
