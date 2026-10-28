// Scan 2026-10-27 (modules), G2: the Kamino API was the authority over what the wallet signed. The
// guard bounded only the programs called and the net balances (F1), and its bounds came from the
// API's own figures — tokensPerShare, positions, debts (F2, F6, F10, F11, F12). Now every instruction
// must be one the operation takes, on the wallet's own obligation, vault and accounts; the bounds come
// from the chain, and an API figure that disagrees with the chain is refused.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getBase64EncodedWireTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { getTransferInstruction } from '@solana-program/token'
import { WalletManagerSolana, decodeWireTransaction, resolveCompiledAccounts, unexpectedInstruction, type SolanaRpc } from '@anywalletkit/wallet-solana'
import { KaminoApi, KaminoError, KaminoMarketProtocolSolana, KaminoVaultProtocolSolana, fromDecimalString, toDecimalString } from '../src/index.js'
import { divWadUp, toWad } from '../src/amounts.js'
import { SF, type ChainAccount } from '../src/chain.js'
import { IX, marketRules, vaultRules, type InstructionRule } from '../src/policy.js'
import { associatedTokenAddress, farmUserState, vanillaObligation } from '../src/pda.js'
import { FARMS_PROGRAM, KAMINO_PROGRAM_ALLOWLIST, KLEND_PROGRAM, KVAULT_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../src/programs.js'
import { MARKET, SHARES, TX, USDC, USDC_RESERVE, USER, VAULT, account as bare, api, obligation, vaultMetrics } from './fixture.js'
import { CHAIN_TPS, OBLIGATION, SHARES_ATA, USER_STATE, defaultChain, obligationAccount, reserveAccount, tokenAccount } from './chain-fixture.js'

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/live-ktx-2026-10-28.json', import.meta.url), 'utf8')) as { wallet: string; transactions: Record<string, string>; lookupTables: Record<string, string[]> }
const ME = LIVE.wallet
const WSOL = 'So11111111111111111111111111111111111111112'
const ATTACKER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'
/** Vault HDsayq…'s farm on chain (2026-10-28); the live farm deposit stakes into it. */
const VAULT_FARM = '9FVjHqduhDPMVqvu3cXiEBjU6nvxvGdCCLRwd9WpVRZj'
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const account = (opts: Parameters<typeof bare>[0] = {}) => bare({ accounts: defaultChain(), ...opts })
const ktxCalls = (f: ReturnType<typeof api>) => f.requests.filter((r) => r.url.startsWith('/ktx/'))

/** The first instruction of a transaction that the rules refuse (lookup tables from the live fixture). */
function oddOf(base64: string, rules: readonly InstructionRule[], tables: Record<string, string[]> = {}) {
  const layout = resolveCompiledAccounts(decodeWireTransaction(base64), { addressesByLookupTableAddress: tables as never })
  expect(layout.unresolved).toBe(false)
  return unexpectedInstruction(layout.compiled, layout.accounts, rules)
}

function wire(payer: string, instructions: Instruction[]): string {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (x) => setTransactionMessageFeePayer(payer as Address, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, x),
    (x) => appendTransactionMessageInstructions(instructions, x),
  ) as TransactionMessage
  return getBase64EncodedWireTransaction(compileTransaction(msg as never) as Transaction)
}
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b }
/** An Anchor call: discriminator + u64 argument, accounts as [address, writable] in IDL order (the first one signs). */
function anchor(program: string, disc: string, arg: bigint, accounts: Array<[string, boolean]>): Instruction {
  return {
    programAddress: program as Address,
    accounts: accounts.map(([address, w], i) => ({ address: address as Address, role: i === 0 ? AccountRole.WRITABLE_SIGNER : w ? AccountRole.WRITABLE : AccountRole.READONLY })),
    data: Uint8Array.from([...Buffer.from(disc, 'hex'), ...u64(arg)]),
  }
}
/** klend's V2 deposit / withdraw (same account order up to the destination), with the live transaction's reserve accounts. */
const klendLeg = (disc: string, amount: bigint, owner: string, obligation: string, ata: string) => anchor(KLEND_PROGRAM, disc, amount, [
  [owner, true], [obligation, true], [MARKET, false], ['9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo', false], [USDC_RESERVE, true], [USDC, false],
  ['Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6', true], ['B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D', true], ['3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL', true], [ata, true],
  [KLEND_PROGRAM, false], [TOKEN_PROGRAM, false], [TOKEN_PROGRAM, false], ['Sysvar1nstructions1111111111111111111111111', false],
  ['DTgnAC2DnS49zU6Bjoj59BLgSxH2HoGZgtzC1suExbkp', true], ['JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh', true], [FARMS_PROGRAM, false],
])

describe('Kamino instruction rules: the live /ktx transactions pass (2026-10-28, golden)', () => {
  const ata = (mint: string, program = TOKEN_PROGRAM) => associatedTokenAddress(ME, mint, program)
  const vaultAccounts = { me: ME, vault: VAULT, mint: USDC, sharesMint: SHARES, tokenAta: ata(USDC), sharesAtas: [ata(SHARES), ata(SHARES, TOKEN_2022_PROGRAM)], farm: { farm: VAULT_FARM, userState: farmUserState(VAULT_FARM, ME) }, wsolAta: ata(WSOL) }

  it('a first Lend deposit: metadata, obligation, lookup table, farms, refreshes and the deposit on our obligation', () => {
    const obligation = vanillaObligation(ME, MARKET)
    expect(obligation).toBe('EnxJnydiZPsyQx2ZmXdg7vfggsRLQWpogz19cP6R9SPb') // the live transaction's
    const rules = marketRules('deposit', { me: ME, market: MARKET, obligation, reserve: USDC_RESERVE, mint: USDC, ata: ata(USDC), wsolAta: ata(WSOL) })
    expect(oddOf(LIVE.transactions['lend-deposit']!, rules, LIVE.lookupTables)).toBeUndefined()
    // …and it is a deposit, nothing else: a withdrawal's rules refuse it.
    const asWithdraw = marketRules('withdraw', { me: ME, market: MARKET, obligation, reserve: USDC_RESERVE, mint: USDC, ata: ata(USDC), wsolAta: ata(WSOL) })
    expect(oddOf(LIVE.transactions['lend-deposit']!, asWithdraw, LIVE.lookupTables)).toMatchObject({ program: 'AddressLookupTab1e1111111111111111111111111' })
  })

  it('Earn vault deposit (shares kept), deposit staked in the farm, and withdrawal', () => {
    expect(farmUserState(VAULT_FARM, ME)).toBe('3QZ4o2qDKytc2uq1Gs3wV5xD2241MWNC7t7SUSKfUu36') // the live transaction's
    expect(oddOf(LIVE.transactions['vault-deposit']!, vaultRules('deposit', vaultAccounts, { stake: false }), LIVE.lookupTables)).toBeUndefined()
    expect(oddOf(LIVE.transactions['vault-deposit-farm']!, vaultRules('deposit', vaultAccounts, { stake: true }), LIVE.lookupTables)).toBeUndefined()
    expect(oddOf(LIVE.transactions['vault-withdraw']!, vaultRules('withdraw', vaultAccounts, { stake: false }), LIVE.lookupTables)).toBeUndefined()
    // Shares kept in the wallet (skipFarm): the farm's initializeUser / stake are not part of the operation.
    expect(oddOf(LIVE.transactions['vault-deposit-farm']!, vaultRules('deposit', vaultAccounts, { stake: false }), LIVE.lookupTables)).toMatchObject({ index: 2, program: FARMS_PROGRAM })
    // Staking into another farm is not this vault's farm.
    const elsewhere = { ...vaultAccounts, farm: { farm: '2PaPj3BH82ASuFyQsUaUCA62DcmWSjow9xhbg6bamwJM', userState: farmUserState('2PaPj3BH82ASuFyQsUaUCA62DcmWSjow9xhbg6bamwJM', ME) } }
    expect(oddOf(LIVE.transactions['vault-deposit-farm']!, vaultRules('deposit', elsewhere, { stake: true }), LIVE.lookupTables)).toMatchObject({ index: 2 })
  })
})

// The fake RPC behind a real wallet-solana account: base64 reads from `pre`, the simulation returns `post`.
function fakeRpc(pre: Map<string, ChainAccount>, post: Map<string, ChainAccount>) {
  const sent: string[] = []
  const toRpc = (s: ChainAccount | undefined) => (s ? { lamports: s.lamports, owner: s.owner, data: [Buffer.from(s.data).toString('base64'), 'base64'], executable: false, rentEpoch: 0n, space: BigInt(s.data.length) } : null)
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getMultipleAccounts: (addrs) => ({ value: (addrs as string[]).map((a) => toRpc(pre.get(a))) }),
    simulateTransaction: (_w, cfg) => ({ value: { err: null, unitsConsumed: 300_000n, logs: [], accounts: (cfg as { accounts: { addresses: string[] } }).accounts.addresses.map((a) => toRpc(post.get(a) ?? pre.get(a))) } }),
    getFeeForMessage: () => ({ value: 5_000n }),
    getAccountInfo: (a) => {
      if (a !== USDC) return { value: null }
      const data = new Uint8Array(82); data[44] = 6; data[45] = 1
      return { value: { lamports: 1n, owner: TOKEN_PROGRAM, data: [Buffer.from(data).toString('base64'), 'base64'], executable: false, rentEpoch: 0n, space: 82n } }
    },
    sendTransaction: (w) => { sent.push(w as string); return 'S'.repeat(87) },
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, sent }
}
const sys = (lamports: bigint): ChainAccount => ({ lamports, owner: '11111111111111111111111111111111', data: new Uint8Array() })

describe('F1: a Kamino transaction may only carry the instructions its operation takes', () => {
  it('a 1-unit supply that also withdraws the whole collateral and transfers it away is refused before signing (real guard)', async () => {
    const usdcAta = associatedTokenAddress(ME, USDC, TOKEN_PROGRAM)
    const attackerAta = associatedTokenAddress(ATTACKER, USDC, TOKEN_PROGRAM)
    const meObligation = vanillaObligation(ME, MARKET)
    const chain = defaultChain()
    chain.set(meObligation, obligationAccount({ owner: ME, deposits: [{ reserve: USDC_RESERVE, ctokens: 50_000_000_000n }] }))
    const pre = new Map([...chain, [ME, sys(10n ** 9n)], [usdcAta, tokenAccount(USDC, ME, 1_000_000n)]])
    // Net: −1 USDC deposited, +50 000 withdrawn, −50 000 to the attacker → the ATA ends at 0, within the 1 USDC the supply may spend.
    const post = new Map([[ME, sys(10n ** 9n - 5_000n)], [usdcAta, tokenAccount(USDC, ME, 0n)]])
    const evil = wire(ME, [
      klendLeg(IX.depositV2, 1_000_000n, ME, meObligation, usdcAta),
      klendLeg(IX.withdrawV2, 50_000_000_000n, ME, meObligation, usdcAta),
      getTransferInstruction({ source: usdcAta as Address, destination: attackerAta as Address, authority: createNoopSigner(ME as Address), amount: 50_000_000_000n }),
    ])
    const rpc = fakeRpc(pre, post)
    const wallet = await new WalletManagerSolana(SEED, { provider: rpc.rpc }).getAccount(0)
    expect(await wallet.getAddress()).toBe(ME)
    // Against programs and net balances only, the transaction passes: that was the finding.
    await expect(wallet.checkSerialized(evil, { programAllowlist: KAMINO_PROGRAM_ALLOWLIST, expect: { maxLamportsOut: 10_000_000n, maxTokenOut: { mint: USDC, amount: 1_000_000n } } })).resolves.toBeDefined()

    const kamino = api()
    kamino.routes.set('/ktx/klend/deposit', { status: 200, body: { transaction: evil } })
    const p = new KaminoMarketProtocolSolana(wallet, { fetch: kamino.fetch })
    await expect(p.supply({ token: USDC, amount: 1_000_000n })).rejects.toMatchObject({ code: 'unexpected-instruction', message: expect.stringMatching(/Instruction 1 \(KLend2g3/) })
    await expect(p.quoteSupply({ token: USDC, amount: 1_000_000n })).rejects.toMatchObject({ code: 'unexpected-instruction' })
    expect(rpc.sent).toHaveLength(0)

    // The honest shape of the same supply passes the same guard.
    const honest = wire(ME, [klendLeg(IX.depositV2, 1_000_000n, ME, meObligation, usdcAta)])
    kamino.routes.set('/ktx/klend/deposit', { status: 200, body: { transaction: honest } })
    await expect(p.supply({ token: USDC, amount: 1_000_000n })).resolves.toMatchObject({ hash: 'S'.repeat(87) })
  })

  it('what the module pins: our obligation and ATA in a deposit, no borrow inside a repay, the vault\'s shares to our account', async () => {
    // Lend: the rules the module hands the guard for a supply.
    const ma = account()
    const m = new KaminoMarketProtocolSolana(ma, { fetch: api().fetch })
    ma.accounts.set(OBLIGATION, obligationAccount({ deposits: [{ reserve: USDC_RESERVE, ctokens: 5_000_000n }], borrows: [{ reserve: USDC_RESERVE, borrowedSf: 1_000_000n * SF }] }))
    const usdcAta = associatedTokenAddress(USER, USDC, TOKEN_PROGRAM)
    await m.quoteSupply({ token: USDC, amount: 1_000_000n })
    const supplyRules = ma.guards.at(-1)!.guard.instructions
    expect(oddOf(wire(USER, [klendLeg(IX.depositV2, 1_000_000n, USER, OBLIGATION, usdcAta)]), supplyRules)).toBeUndefined()
    // Into the attacker's obligation, or from someone else's token account: refused.
    expect(oddOf(wire(USER, [klendLeg(IX.depositV2, 1_000_000n, USER, vanillaObligation(ATTACKER, MARKET), usdcAta)]), supplyRules)).toMatchObject({ index: 0 })
    expect(oddOf(wire(USER, [klendLeg(IX.depositV2, 1_000_000n, USER, OBLIGATION, associatedTokenAddress(USER, USDC, TOKEN_2022_PROGRAM))]), supplyRules)).toMatchObject({ index: 0 })
    // A repay may not borrow (repay's own layout differs; a V2 borrow on our obligation is simply not a repay).
    await m.quoteRepay({ token: USDC, amount: 500_000n })
    const repayRules = ma.guards.at(-1)!.guard.instructions
    const borrow = anchor(KLEND_PROGRAM, IX.borrowV2, 10_000_000n, [[USER, true], [OBLIGATION, true], [MARKET, false], ['9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo', false], [USDC_RESERVE, true], [USDC, false], ['Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6', true], ['B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D', true], [usdcAta, true]])
    expect(oddOf(wire(USER, [borrow]), repayRules)).toMatchObject({ index: 0, program: KLEND_PROGRAM })

    // Earn vault: shares minted to the attacker's account, or a reward harvest, are not the operation.
    const acc = account()
    const f = api()
    const v = new KaminoVaultProtocolSolana(acc, { vault: VAULT, fetch: f.fetch, asset: USDC })
    await v.quoteSupply({ amount: 1_000_000n })
    const depositRules = acc.guards.at(-1)!.guard.instructions
    const vaultDeposit = (sharesAta: string) => anchor(KVAULT_PROGRAM, IX.vaultDeposit, 1_000_000n, [[USER, true], [VAULT, true], ['CKTEDx5z19CntAB9B66AxuS98S1NuCgMvfpsew7TQwi', true], [USDC, false], ['AyY6VCkHfTWdFs7SqBbu6AnCqLUhgzVHBzW3WcJu5Jc8', false], [SHARES, true], [usdcAta, true], [sharesAta, true]])
    expect(oddOf(wire(USER, [vaultDeposit(SHARES_ATA)]), depositRules)).toBeUndefined()
    expect(oddOf(wire(USER, [vaultDeposit(associatedTokenAddress(ATTACKER, SHARES, TOKEN_PROGRAM))]), depositRules)).toMatchObject({ index: 0 })
    const harvest = anchor(FARMS_PROGRAM, '44c8e4e9b820e2bc', 0n, [[USER, true], [USER_STATE, true], ['ArwyAHmnFmbKbUxC2fnK5VUEpspHrnoFtJ22bvEyriKk', true], [ATTACKER, true]])
    expect(oddOf(wire(USER, [vaultDeposit(SHARES_ATA), harvest]), depositRules)).toMatchObject({ index: 1, program: FARMS_PROGRAM })
    // A plain token transfer of the deposit, the original finding's other half.
    const transfer = getTransferInstruction({ source: usdcAta as Address, destination: associatedTokenAddress(ATTACKER, USDC, TOKEN_PROGRAM) as Address, authority: createNoopSigner(USER as Address), amount: 1_000_000n })
    expect(oddOf(wire(USER, [transfer]), depositRules)).toMatchObject({ index: 0, program: TOKEN_PROGRAM })
  })
})

describe('F2 / F12 / F11: the vault\'s bounds come from the chain; a lying tokensPerShare is refused', () => {
  const lyingRate = (tokensPerShare: string) => {
    const acc = account()
    acc.accounts.set(SHARES_ATA, tokenAccount(SHARES, USER, 9_000_000_000n)) // 9 000 shares
    const f = api()
    f.routes.set(`/kvaults/vaults/${VAULT}/metrics`, { status: 200, body: { ...vaultMetrics, tokensPerShare } })
    return { acc, f, p: new KaminoVaultProtocolSolana(acc, { vault: VAULT, fetch: f.fetch, asset: USDC }) }
  }

  it('a rate 100 000× too low is refused on a max and a partial withdraw, before anything is built', async () => {
    const { acc, f, p } = lyingRate('0.000010627800342202')
    await expect(p.withdraw({ amount: 'max' })).rejects.toThrow(/does not match the chain: tokensPerShare/)
    await expect(p.withdraw({ amount: 10_000_000n })).rejects.toThrow(/does not match the chain/)
    await expect(p.quoteWithdraw({ amount: 10_000_000n })).rejects.toThrow(KaminoError)
    expect(ktxCalls(f)).toHaveLength(0)
    expect(acc.guards).toHaveLength(0)
  })

  it('an inflated rate is refused on supply (it zeroed the minimum shares)', async () => {
    const { f, p } = lyingRate('106278.00342202071868')
    await expect(p.supply({ amount: 1_000_000_000n })).rejects.toThrow(/does not match the chain/)
    expect(ktxCalls(f)).toHaveLength(0)
  })

  it('F11: a negative rate is refused on supply and withdraw', async () => {
    const { f, p } = lyingRate('-0.000000000000000001')
    await expect(p.supply({ amount: 1_000_000n })).rejects.toThrow(/signed figure/)
    await expect(p.withdraw({ amount: 'max' })).rejects.toThrow(/signed figure/)
    expect(ktxCalls(f)).toHaveLength(0)
  })

  it('a rate within 1% passes, and the share ceiling is what the amount needs at the chain\'s rate, capped by the shares on chain', async () => {
    const { acc, f, p } = lyingRate('1.0675') // ~0.45% above the chain's 1.06278
    const q = await p.quoteWithdraw({ amount: 10_000_000n })
    expect(q.shares).toBe(divWadUp(10_000_000n, CHAIN_TPS))
    expect(acc.guards.at(-1)!.guard.expect.maxTokenOut).toEqual({ mint: SHARES, amount: divWadUp(10_000_000n, CHAIN_TPS) })
    expect(ktxCalls(f).at(-1)!.body).toMatchObject({ amount: toDecimalString(divWadUp(10_000_000n, CHAIN_TPS), 6) }) // 9.409285 shares, not the API's 9.367681
    // The API's position plays no part: it may claim anything.
    f.position = { stakedShares: '0', unstakedShares: '100000000', totalShares: '100000000' }
    await expect(p.quoteWithdraw({ amount: 10_000_000_000_000n })).rejects.toThrow(/exceeds the position: .* the wallet holds 9000000000/)
    expect(toWad('1.0675') > CHAIN_TPS).toBe(true)
  })
})

describe('F6 / F10: \'max\' on a Lend market comes from the obligation on chain', () => {
  const lend = (legs: { deposits?: unknown[]; borrows?: unknown[] } | null, chain: Parameters<typeof obligationAccount>[0]) => {
    const acc = account()
    acc.accounts.set(OBLIGATION, obligationAccount(chain))
    const f = api()
    if (legs) f.obligations = [{ ...obligation, loanInfo: { ...obligation.loanInfo, collateral: { deposits: legs.deposits ?? [] }, debt: { borrows: legs.borrows ?? [] } } }]
    return { acc, f, p: new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }) }
  }
  const usdcLeg = (tokenAmount: string) => ({ tokenMint: USDC, tokenName: 'USDC', tokenAmount, tokenValue: tokenAmount })

  it('F6: an inflated debt (19 900 reported, 10 owed) is refused; the repay ceiling never comes from the API', async () => {
    const { acc, f, p } = lend({ borrows: [usdcLeg('19900')] }, { deposits: [{ reserve: USDC_RESERVE, ctokens: 50_000_000n }], borrows: [{ reserve: USDC_RESERVE, borrowedSf: 10_000_000n * SF }] })
    await expect(p.repay({ token: USDC, amount: 'max' })).rejects.toThrow(/reports 19900000000 base units borrowed .* has 10000000 on chain/)
    expect(ktxCalls(f)).toHaveLength(0)
    expect(acc.guards).toHaveLength(0)
  })

  it('debt grows with the reserve\'s borrow rate; an API that reports nothing (the live format) leaves the chain\'s figure', async () => {
    const acc = account()
    acc.accounts.set(OBLIGATION, obligationAccount({ borrows: [{ reserve: USDC_RESERVE, borrowedSf: 10_000_000n * SF, cumulativeBorrowRate: SF }] }))
    acc.accounts.set(USDC_RESERVE, reserveAccount({ mint: USDC, available: 10n ** 15n, collateralSupply: 10n ** 15n, cumulativeBorrowRate: (SF * 101n) / 100n }))
    const f = api()
    // /users/<user>/obligations as the API answers on 2026-10-28: raw state, no per-token legs.
    f.obligations = [{ obligationAddress: OBLIGATION, state: { owner: USER }, deposits: {}, borrows: {}, refreshedStats: {}, obligationTag: 0, humanTag: 'Vanilla' }]
    const p = new KaminoMarketProtocolSolana(acc, { fetch: f.fetch })
    await p.quoteRepay({ token: USDC, amount: 'max' })
    expect(ktxCalls(f).at(-1)!.body).toMatchObject({ amount: '10.1' })
    expect(acc.guards.at(-1)!.guard.expect.maxTokenOut).toEqual({ mint: USDC, amount: 10_100_000n + 50_500n })
    expect((await new KaminoApi(undefined, f.fetch).getUserObligations(MARKET, USER))[0]!.obligation).toBe(OBLIGATION)
  })

  it('F10: a negative deposit from the API is refused; the chain\'s deposit is what max withdraws', async () => {
    const neg = lend({ deposits: [usdcLeg('-1000000')] }, { deposits: [{ reserve: USDC_RESERVE, ctokens: 5_000_000n }] })
    await expect(neg.p.withdraw({ token: USDC, amount: 'max' })).rejects.toThrow(/signed figure/)
    expect(ktxCalls(neg.f)).toHaveLength(0)
    expect(() => fromDecimalString('-1000000', 6)).toThrow(KaminoError)

    const ok = lend(null, { deposits: [{ reserve: USDC_RESERVE, ctokens: 5_000_000n }] })
    await ok.p.quoteWithdraw({ token: USDC, amount: 'max' })
    expect(ktxCalls(ok.f).at(-1)!.body).toMatchObject({ amount: '5' })
    expect(ok.acc.guards.at(-1)!.guard.expect.tokenIn).toEqual({ mint: USDC, minAmount: 4_975_000n })
    // Nothing on chain is nothing to withdraw, whatever the API says.
    const none = lend({ deposits: [usdcLeg('5')] }, {})
    await expect(none.p.withdraw({ token: USDC, amount: 'max' })).rejects.toThrow(/Nothing supplied/)
  })

  it('the reserve the API resolves must be this market\'s and lend the token, on chain', async () => {
    const acc = account()
    acc.accounts.set(USDC_RESERVE, reserveAccount({ market: 'DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek', mint: USDC, available: 1n, collateralSupply: 1n }))
    const f = api()
    const p = new KaminoMarketProtocolSolana(acc, { fetch: f.fetch })
    await expect(p.supply({ token: USDC, amount: 1_000_000n })).rejects.toThrow(/belongs to market DxXdAy/)
    acc.accounts.set(USDC_RESERVE, reserveAccount({ mint: WSOL, available: 1n, collateralSupply: 1n }))
    await expect(p.supply({ token: USDC, amount: 1_000_000n })).rejects.toThrow(/lends So111/)
    acc.accounts.set(USDC_RESERVE, { ...reserveAccount({ mint: USDC, available: 1n, collateralSupply: 1n }), owner: ATTACKER })
    await expect(p.supply({ token: USDC, amount: 1_000_000n })).rejects.toThrow(/is not a Kamino Reserve/)
    expect(ktxCalls(f)).toHaveLength(0)
  })

  it('a wallet-solana account without chain reads cannot write: the API is never taken on its word', async () => {
    const acc = account()
    delete (acc as Partial<typeof acc>).getAccountInfos
    const f = api()
    await expect(new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }).supply({ token: USDC, amount: 1n })).rejects.toThrow(/getAccountInfos/)
    expect(ktxCalls(f)).toHaveLength(0)
    expect(TX).toBeTypeOf('string')
  })
})
