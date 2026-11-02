import { afterEach, describe, expect, it, vi } from 'vitest'
import { checksFor, decodeCall, type PreviewCall } from '@anywalletkit/tx-preview-evm'
import type { IWalletAccount } from '@anywalletkit/core'
import { createMockAccount, type MockAccountOptions } from './mock-account.js'
import type { WriteProtocolCtor as Ctor } from './ctor.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any

/** The swap2 engine's review plan (structural copy of `Swap2ExecutionPlan`; conformance does not depend on swap2-core). */
export interface Swap2BehaviourPlan {
  recipient: string
  refundAddress: string
  sourceAmount: bigint
  approvals: { token: string; spender: string; amount: bigint }[]
  source:
    | { kind: 'call'; to: string; data?: string; value: bigint }
    | { kind: 'token-transfer'; token: string; recipient: string; amount: bigint }
    | { kind: 'serialized'; serializedTx: string }
    | { kind: 'typed-order'; typedData: string }
}

type Plan = Swap2BehaviourPlan

export interface Swap2BehaviourFixture {
  name: string
  /** `Swap2Options` for `swap2()` / `quoteSwap2()` (include `minAmountOut`). */
  options: Record<string, unknown>
  /** Recorded/mocked network for this fixture, installed as the global `fetch`. */
  fetch: typeof fetch
  /** Signing mock account (address/chain must match what the recorded quote binds). */
  account?: MockAccountOptions
  /** The user's other addresses (e.g. the destination-chain recipient). The signing account is always own. */
  own?: string[]
  /** Deposit-address providers: the address the recorded quote declares. */
  depositAddress?: string
  /** Calldata providers: the approval spender the recorded quote declares (none → no approval allowed). */
  spender?: string
  /**
   * Contracts the plan's source call may go to (router, vault, OFT, wrapped-native token), on every
   * chain. The declared `spender` and `sourceToken` are ones already. A call, or native value, into
   * any other contract fails the suite.
   */
  callTargets?: string[]
  /**
   * Who the plan's output goes to, decoded by the fixture from what the account would sign — not by
   * the module: every recipient (and refund address) named inside router calldata or a typed order,
   * in the spelling of `own` / `depositAddress`. Required when the source is a contract call whose
   * calldata is not a plain token transfer, and for a typed order; each address it returns must be
   * own or the declared deposit address, and it must return at least one.
   */
  decode?: (source: Plan['source']) => string[] | Promise<string[]>
  /** Source token contract; omit for the native coin. */
  sourceToken?: string
  /**
   * Provider-serialized legs (Solana aggregators): decode what the account would be asked to sign and assert it
   * (fee payer, signers, programs, amounts). Required when the plan's source is `serialized` — opaque bytes are not
   * accepted unread.
   */
  serialized?: (serializedTx: string, own: ReadonlySet<string>) => void | Promise<void>
}

export interface ProtocolBehaviourOptions<P> {
  type: 'swap2'
  Protocol: Ctor<P>
  /** Constructor config (e.g. `{fromChain}`); the suite adds `reviewExecution`. */
  config: Record<string, unknown>
  fixtures: Swap2BehaviourFixture[]
}

class ReviewHalt extends Error {}
const UNLIMITED = 1n << 255n
// Every tx-preview warning about what the plan pays or calls: a foreign recipient, an approval beyond the
// input, a contract nobody declared, native value into it, calldata nobody can read.
const WARNINGS = new Set(['recipient-foreign', 'approval-unlimited', 'approval-excess', 'approval-unknown-spender', 'approval-unparsed', 'contract-unknown', 'native-value', 'calldata-undecodable'])
const lc = (a: string) => a.toLowerCase()
// tx-preview's unlimited threshold, type(uint128).max, for approvals it does not read itself.
const PREVIEW_UNLIMITED = (1n << 128n) - 1n
// TRC-20 shares ERC-20's selectors: approve(address,uint256), increaseAllowance(address,uint256) and the older
// StandardToken name increaseApproval(address,uint256), the three tx-preview and the kit read as approvals.
const ALLOWANCE_SELECTORS = new Set(['095ea7b3', '39509351', 'd73dd623'])
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** The 20-byte account a Tron (base58 T… / 41-hex) or EVM address names, as lowercase hex; null for anything else. */
function account20(address: string): string | null {
  const hex = /^(?:0x)?(?:41)?([0-9a-fA-F]{40})$/.exec(address)
  if (hex) return hex[1]!.toLowerCase()
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return null
  let n = 0n
  for (const ch of address) n = n * 58n + BigInt(B58.indexOf(ch))
  const full = n.toString(16).padStart(50, '0')
  return full.startsWith('41') ? full.slice(2, 42) : null
}
const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const approveData = (spender: string, amount: bigint) => `0x095ea7b3${word(spender)}${word(amount.toString(16))}`

/**
 * Opt-in behavioural conformance: runs the module against a recorded quote to the
 * engine's review gate and checks WHAT it would sign, not just its shape.
 */
export function describeProtocolBehaviour<P extends object>(name: string, o: ProtocolBehaviourOptions<P>): void {
  describe(`${name}: behaviour (${o.type})`, () => {
    afterEach(() => { vi.unstubAllGlobals() })

    for (const f of o.fixtures) {
      const setup = (review: (plan: Plan) => void) => {
        vi.stubGlobal('fetch', f.fetch)
        // Funded for gas by default: the engine refuses an account that cannot pay approvals + main call.
        const account = createMockAccount({ balance: 10n ** 30n, ...f.account })
        const p = new o.Protocol(account, { ...o.config, reviewExecution: review }) as unknown as { swap2(x: unknown): Promise<unknown>; quoteSwap2(x: unknown): Promise<unknown> }
        return { account, p }
      }
      const ownOf = async (account: IWalletAccount) => new Set([await account.getAddress(), ...(f.own ?? [])].map(lc))

      /** The fixture's own reading of router calldata / a typed order: every address it pays must be declared. */
      const decoded = async (source: Plan['source'], declared: ReadonlySet<string>) => {
        expect(f.decode, `a ${source.kind} plan needs the fixture's \`decode\` (who the calldata or order pays)`).toBeTypeOf('function')
        const paid = await f.decode!(source)
        expect(paid.length, '`decode` names no recipient').toBeGreaterThan(0)
        for (const r of paid) expect(declared.has(lc(r)), `the plan pays ${r}, which is neither own nor declared`).toBe(true)
      }

      it(`${f.name}: the reviewed plan pays only own/declared addresses, with exact approvals, and nothing is signed`, async () => {
        let plan: Plan | undefined
        const { account, p } = setup((x) => { plan = x; throw new ReviewHalt('conformance: plan captured') })
        await expect(p.swap2(f.options)).rejects.toBeInstanceOf(ReviewHalt)
        expect(account.sent, 'signed/sent before review').toHaveLength(0)
        expect(account.calls.filter((c) => /^sign/.test(c.method)), 'signed before review').toHaveLength(0)

        const own = await ownOf(account)
        const declared = new Set([...own, ...(f.depositAddress ? [lc(f.depositAddress)] : [])])
        const src = f.sourceToken && lc(f.sourceToken)
        expect(own.has(lc(plan!.recipient)), `recipient ${plan!.recipient} is not own`).toBe(true)
        expect(own.has(lc(plan!.refundAddress)), `refund ${plan!.refundAddress} is not own`).toBe(true)
        expect(plan!.sourceAmount).toBe(BigInt(f.options.fromTokenAmount as bigint))

        if (!f.spender) expect(plan!.approvals, 'approval without a declared spender').toHaveLength(0)
        for (const a of plan!.approvals) {
          expect(lc(a.spender)).toBe(lc(f.spender!))
          expect(lc(a.token)).toBe(src)
          expect(a.amount < UNLIMITED && a.amount <= plan!.sourceAmount, `approval ${a.amount} exceeds the input`).toBe(true)
        }

        const s = plan!.source
        if (s.kind === 'token-transfer') {
          expect({ token: lc(s.token), to: declared.has(lc(s.recipient)), amount: s.amount }).toEqual({ token: src, to: true, amount: plan!.sourceAmount })
        } else if (s.kind === 'call' && s.to.startsWith('0x')) {
          const d = decodeCall(s)
          if (d.transfer) expect({ token: d.transfer.token, to: declared.has(d.transfer.to), amount: d.transfer.amount }).toEqual({ token: src, to: true, amount: plan!.sourceAmount })
          else if (!d.selector) expect({ to: declared.has(d.to), enough: s.value >= plan!.sourceAmount }).toEqual({ to: true, enough: true })
          else await decoded(s, declared)
          // tx-preview's named checks over approve → call, as the review screen sees them.
          const calls: PreviewCall[] = [...plan!.approvals.map((a) => ({ to: a.token, data: approveData(a.spender, a.amount) })), s]
          const known: Record<string, string> = {
            ...Object.fromEntries((f.callTargets ?? []).map((t) => [t, 'declared contract'])),
            ...(f.sourceToken ? { [f.sourceToken]: 'source token' } : {}),
            ...(f.spender ? { [f.spender]: 'declared spender' } : {}),
          }
          const input = { chainId: 0, from: [...own][0]!, calls, rpc: async () => null, own: [...declared], known, expectedApproval: plan!.sourceAmount }
          const warns = checksFor(input, calls.map((c) => decodeCall(c, known)), { status: 'unavailable', reason: 'conformance' })
            .filter((c) => c.status === 'warn' && WARNINGS.has(c.code)).map((c) => c.code)
          expect(warns, 'tx-preview warnings').toEqual([])
        } else if (s.kind === 'serialized') {
          expect(f.serialized, 'a serialized plan needs the fixture\'s `serialized` decoder').toBeTypeOf('function')
          await f.serialized!(s.serializedTx, own)
        } else if (s.kind === 'typed-order') {
          await decoded(s, declared)
        } else {
          // A call on a chain tx-preview does not read (Tron, TON…): the contract it calls, with or without
          // native value, must be declared as on EVM, and who it pays is still the fixture's to show.
          const targets = new Set([...declared, ...(f.callTargets ?? []), ...(f.spender ? [f.spender] : []), ...(f.sourceToken ? [f.sourceToken] : [])].map(lc))
          expect(targets.has(lc(s.to)), `the plan calls ${s.to}${s.value > 0n ? ' with native value' : ''}, which is not declared (callTargets, spender, source token, deposit address)`).toBe(true)
          // TRC-20 approve / increaseAllowance calldata: the approval checks tx-preview runs on EVM — a declared
          // spender (callTargets, spender, source token), no more than the input, and readable arguments.
          const data = (s.data ?? '').replace(/^0x/i, '').toLowerCase()
          expect(/^[0-9a-f]*$/.test(data), `the plan's call to ${s.to} carries calldata that is not hex (calldata-undecodable)`).toBe(true)
          if (ALLOWANCE_SELECTORS.has(data.slice(0, 8))) {
            expect(/^[0-9a-f]{136}$/.test(data), `the plan's call to ${s.to} carries approval calldata that cannot be read (approval-unparsed)`).toBe(true)
            const spender = data.slice(32, 72)
            const allowance = BigInt(`0x${data.slice(72, 136)}`)
            const spenders = new Set([...(f.callTargets ?? []), ...(f.spender ? [f.spender] : []), ...(f.sourceToken ? [f.sourceToken] : [])].map(account20))
            expect(/^0{24}$/.test(data.slice(8, 32)) && spenders.has(spender), `the plan's call approves 0x${spender}, which is not a declared spender (approval-unknown-spender)`).toBe(true)
            expect(allowance < PREVIEW_UNLIMITED && allowance <= plan!.sourceAmount, `approval ${allowance} exceeds the input (approval-unlimited / approval-excess)`).toBe(true)
          }
          await decoded(s, declared)
        }
      })

      it(`${f.name}: executes exactly the reviewed plan, nothing more`, async () => {
        let plan: Plan | undefined
        const { account, p } = setup((x) => { plan = x })
        await p.swap2(f.options)
        const sent = account.sent as { to?: string; data?: string; value?: bigint; token?: string; recipient?: string; amount?: bigint; serializedTx?: string }[]
        expect(sent, 'extra or missing sends').toHaveLength(plan!.approvals.length + 1)
        plan!.approvals.forEach((a, i) => expect(lc(sent[i]!.data ?? '')).toBe(approveData(a.spender, a.amount)))
        const leg = sent.at(-1)!
        const s = plan!.source
        if (s.kind === 'call') expect({ to: leg.to, data: leg.data, value: leg.value }).toEqual({ to: s.to, data: s.data, value: s.value })
        if (s.kind === 'token-transfer') expect({ token: leg.token, recipient: leg.recipient, amount: leg.amount }).toEqual({ token: s.token, recipient: s.recipient, amount: s.amount })
        if (s.kind === 'serialized') {
          const l = leg as { serializedTx?: string; expect?: { maxValueOut?: string } }
          expect(l.serializedTx, 'the account executed other bytes than were reviewed').toBe(s.serializedTx)
          expect(l.expect?.maxValueOut, 'a serialized leg goes out with the engine\'s balance expectation').toBeTypeOf('string')
        }
      })

      it(`${f.name}: quoting never signs or broadcasts`, async () => {
        const { account, p } = setup(() => {})
        try { await p.quoteSwap2(f.options) } catch { /* a dry quote may need another recording; we only assert no send */ }
        expect(account.sent).toHaveLength(0)
        expect(account.calls.filter((c) => /^sign/.test(c.method))).toHaveLength(0)
      })
    }
  })
}
