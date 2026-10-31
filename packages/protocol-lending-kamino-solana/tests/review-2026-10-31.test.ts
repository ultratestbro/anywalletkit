// Review 2026-10-31: a Lend withdrawal bound only the MINIMUM the wallet receives. The withdrawV2 rule
// pins discriminator, length and accounts, not the u64 collateral amount, so an API that answered a
// 1 USDC request with a 50 USDC withdraw from the same obligation was signed. Now the payout is also
// capped: the amount plus the slippage tolerance, one cToken's worth at the reserve's on-chain rate and
// a unit of rounding — on the token side and the SOL side alike.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { UnsafeTransactionError, WalletManagerSolana, type SolanaRpc } from '@anywalletkit/wallet-solana'
import { KaminoMarketProtocolSolana } from '../src/index.js'
import { lessBps } from '../src/amounts.js'
import { decodeReserve, oneCtokenLiquidityUp, type ChainAccount } from '../src/chain.js'
import { IX } from '../src/policy.js'
import { associatedTokenAddress, vanillaObligation } from '../src/pda.js'
import { FARMS_PROGRAM, KLEND_PROGRAM, TOKEN_PROGRAM } from '../src/programs.js'
import { MARKET, SOL, SOL_RESERVE, USDC, USDC_RESERVE, api } from './fixture.js'
import { defaultChain, obligationAccount, reserveAccount, tokenAccount } from './chain-fixture.js'

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/live-ktx-2026-10-28.json', import.meta.url), 'utf8')) as { wallet: string }
const ME = LIVE.wallet
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const U64_MAX = (1n << 64n) - 1n

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
/** klend's withdrawV2 with the live transaction's reserve accounts, on the given reserve, mint and destination. */
function withdrawLeg(ctokens: bigint, obligation: string, reserve: string, mint: string, ata: string): Instruction {
  const accounts: Array<[string, boolean]> = [
    [ME, true], [obligation, true], [MARKET, false], ['9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo', false], [reserve, true], [mint, false],
    ['Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6', true], ['B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D', true], ['3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL', true], [ata, true],
    [KLEND_PROGRAM, false], [TOKEN_PROGRAM, false], [TOKEN_PROGRAM, false], ['Sysvar1nstructions1111111111111111111111111', false],
    ['DTgnAC2DnS49zU6Bjoj59BLgSxH2HoGZgtzC1suExbkp', true], ['JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh', true], [FARMS_PROGRAM, false],
  ]
  return {
    programAddress: KLEND_PROGRAM as Address,
    accounts: accounts.map(([address, w], i) => ({ address: address as Address, role: i === 0 ? AccountRole.WRITABLE_SIGNER : w ? AccountRole.WRITABLE : AccountRole.READONLY })),
    data: Uint8Array.from([...Buffer.from(IX.withdrawV2, 'hex'), ...u64(ctokens)]),
  }
}

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
const BAL = 10n ** 9n

/**
 * A USDC withdrawal through a real wallet-solana guard: the obligation holds `deposited` cTokens, the
 * API's transaction burns `ctokensArg` of them and the simulation credits `received` to the wallet's ATA.
 */
async function usdcCase(o: { deposited: bigint; ctokensArg: bigint; received: bigint; chain?: Map<string, ChainAccount> }) {
  const usdcAta = associatedTokenAddress(ME, USDC, TOKEN_PROGRAM)
  const ob = vanillaObligation(ME, MARKET)
  const chain = o.chain ?? defaultChain()
  chain.set(ob, obligationAccount({ owner: ME, deposits: [{ reserve: USDC_RESERVE, ctokens: o.deposited }] }))
  const pre = new Map([...chain, [ME, sys(BAL)], [usdcAta, tokenAccount(USDC, ME, 0n)]])
  const post = new Map([[ME, sys(BAL - 5_000n)], [usdcAta, tokenAccount(USDC, ME, o.received)]])
  const rpc = fakeRpc(pre, post)
  const wallet = await new WalletManagerSolana(SEED, { provider: rpc.rpc }).getAccount(0)
  const kamino = api()
  kamino.routes.set('/ktx/klend/withdraw', { status: 200, body: { transaction: wire(ME, [withdrawLeg(o.ctokensArg, ob, USDC_RESERVE, USDC, usdcAta)]) } })
  kamino.routes.set(`/kamino-market/${MARKET}/users/${ME}/obligations`, { status: 200, body: [] })
  return { p: new KaminoMarketProtocolSolana(wallet, { fetch: kamino.fetch }), rpc, wallet }
}

describe('review 2026-10-31: a Lend withdrawal pays out at most about what was asked', () => {
  it('a 1 USDC request answered with a 50 USDC withdraw from our obligation is refused before signing', async () => {
    const { p, rpc, wallet } = await usdcCase({ deposited: 50_000_000n, ctokensArg: 50_000_000n, received: 50_000_000n })
    await expect(p.quoteWithdraw({ token: USDC, amount: 1_000_000n })).rejects.toMatchObject({ code: 'token-in-excess' })
    await expect(p.withdraw({ token: USDC, amount: 1_000_000n })).rejects.toBeInstanceOf(UnsafeTransactionError)
    expect(rpc.sent).toHaveLength(0)
    wallet.dispose()
  })

  it('control: the honest 1 USDC withdrawal (with a unit of rounding) is quoted, signed and sent', async () => {
    const { p, rpc, wallet } = await usdcCase({ deposited: 50_000_000n, ctokensArg: 1_000_000n, received: 1_000_001n })
    const q = await p.quoteWithdraw({ token: USDC, amount: 1_000_000n })
    expect(q.minReceived).toBe(995_000n)
    await expect(p.withdraw({ token: USDC, amount: 1_000_000n })).resolves.toMatchObject({ hash: 'S'.repeat(87) })
    expect(rpc.sent).toHaveLength(1)
    wallet.dispose()
  })

  it("control: a full 'max' withdrawal (u64::MAX cTokens) with interest accrued until the block passes", async () => {
    // The obligation holds 50 USDC on chain at read time; by the block 0.3% has accrued (within the 0.5% tolerance).
    const { p, rpc, wallet } = await usdcCase({ deposited: 50_000_000n, ctokensArg: U64_MAX, received: 50_150_000n })
    await expect(p.withdraw({ token: USDC, amount: 'max' })).resolves.toMatchObject({ hash: 'S'.repeat(87) })
    expect(rpc.sent).toHaveLength(1)
    wallet.dispose()
  })

  it("a 'max' that pays out well beyond the obligation's on-chain deposit and the tolerance is refused", async () => {
    const { p, rpc, wallet } = await usdcCase({ deposited: 50_000_000n, ctokensArg: U64_MAX, received: 60_000_000n })
    await expect(p.withdraw({ token: USDC, amount: 'max' })).rejects.toMatchObject({ code: 'token-in-excess' })
    expect(rpc.sent).toHaveLength(0)
    wallet.dispose()
  })

  it("the cap allows one cToken's worth at the reserve's rate: a reserve whose cToken redeems for 3 units", async () => {
    // 3 units of liquidity per cToken: asking 1 USDC burns ceil(1e6 / 3) cTokens, which redeem for up to 2 units more.
    const chain = defaultChain()
    chain.set(USDC_RESERVE, reserveAccount({ mint: USDC, available: 3n * 10n ** 15n, collateralSupply: 10n ** 15n }))
    expect(oneCtokenLiquidityUp(decodeReserve(USDC_RESERVE, chain.get(USDC_RESERVE)!))).toBe(3n)
    const ok = await usdcCase({ chain, deposited: 10_000_000n, ctokensArg: 333_334n, received: 1_000_002n })
    await expect(ok.p.withdraw({ token: USDC, amount: 1_000_000n })).resolves.toMatchObject({ hash: 'S'.repeat(87) })
    ok.wallet.dispose()
    const cap = 1_000_000n + (1_000_000n - lessBps(1_000_000n, 50)) + 3n + 1n
    const over = await usdcCase({ chain: (() => { const c = defaultChain(); c.set(USDC_RESERVE, chain.get(USDC_RESERVE)!); return c })(), deposited: 10_000_000n, ctokensArg: 333_334n, received: cap + 1n })
    await expect(over.p.withdraw({ token: USDC, amount: 1_000_000n })).rejects.toMatchObject({ code: 'token-in-excess' })
    over.wallet.dispose()
  })

  it('the SOL side is bounded the same way: 1 SOL asked, 50 SOL unwrapped into the wallet is refused; 1 SOL passes', async () => {
    const wsolAta = associatedTokenAddress(ME, SOL, TOKEN_PROGRAM)
    const ob = vanillaObligation(ME, MARKET)
    const run = async (lamportsIn: bigint) => {
      const chain = defaultChain()
      chain.set(ob, obligationAccount({ owner: ME, deposits: [{ reserve: SOL_RESERVE, ctokens: 50n * BAL }] }))
      const pre = new Map([...chain, [ME, sys(BAL)]])
      // The withdrawn SOL lands in the wSOL account, which is closed into the wallet: the wallet's lamports go up.
      const post = new Map([[ME, sys(BAL + lamportsIn - 5_000n)]])
      const rpc = fakeRpc(pre, post)
      const wallet = await new WalletManagerSolana(SEED, { provider: rpc.rpc }).getAccount(0)
      const kamino = api()
      kamino.routes.set('/ktx/klend/withdraw', { status: 200, body: { transaction: wire(ME, [withdrawLeg(lamportsIn, ob, SOL_RESERVE, SOL, wsolAta)]) } })
      const p = new KaminoMarketProtocolSolana(wallet, { fetch: kamino.fetch })
      return { p, rpc, wallet }
    }
    const bad = await run(50n * BAL)
    await expect(bad.p.withdraw({ token: SOL, amount: BAL })).rejects.toMatchObject({ code: 'token-in-excess' })
    expect(bad.rpc.sent).toHaveLength(0)
    bad.wallet.dispose()

    const good = await run(BAL)
    await expect(good.p.withdraw({ token: SOL, amount: BAL })).resolves.toMatchObject({ hash: 'S'.repeat(87) })
    expect(good.rpc.sent).toHaveLength(1)
    good.wallet.dispose()
  })
})
