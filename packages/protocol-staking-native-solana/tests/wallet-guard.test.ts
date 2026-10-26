import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { WalletAccountReadOnlySolana } from '@anywalletkit/wallet-solana'
import { NativeStakingProtocolSolana, type NativeStakingConfig } from '../src/index.js'
import { createWithSeed } from '../src/address.js'
import { STAKE_PROGRAM, SYSTEM_PROGRAM } from '../src/constants.js'
import { CHAIN, EPOCH, FakeNode, SOL, V1, V2, V3, WALLET } from './fake-node.js'

// Every transaction the module builds goes through wallet-solana's own signing checks (the ones
// `sendTransaction` / `quoteSendTransaction` run before anything is simulated or signed), with the
// wallet's default config. A check that starts refusing a module write fails here, not in an app.

interface Guard { describeTransaction(tx: unknown): unknown; enforce(description: unknown): void }

function guarded(config: Partial<NativeStakingConfig> = {}, node = new FakeNode()) {
  const guard = new WalletAccountReadOnlySolana(WALLET, { provider: 'http://127.0.0.1:1' } as never) as unknown as Guard
  const check = (tx: unknown) => guard.enforce(guard.describeTransaction(tx))
  const account = createMockAccount({ chain: CHAIN, address: WALLET, balance: node.balance, fee: 5000n })
  const a = account as unknown as Record<string, (tx: unknown, o?: unknown) => Promise<unknown>>
  const quote = a.quoteSendTransaction!, send = a.sendTransaction!
  a.quoteSendTransaction = async (tx) => { check(tx); return quote(tx) }
  a.sendTransaction = async (tx, o) => { check(tx); return send(tx, o) }
  ;(account as { getBalance: () => Promise<bigint> }).getBalance = async () => node.balance
  const p = new NativeStakingProtocolSolana(account, { validators: [V1, V2, V3], provider: node, ...config } as NativeStakingConfig)
  return { p, account }
}

describe("wallet-solana's signing checks, default config", () => {
  it('pass every write the module builds: stake, split + deactivate, claim, delegate, reactivate, merge', async () => {
    const node = new FakeNode()
    node.seedAccount(0, { stake: 3n * SOL })
    const idle = node.seedAccount(1, { activationEpoch: 1n, deactivationEpoch: 2n, stake: 2n * SOL })
    const other = node.seedAccount(2, { activationEpoch: 1n, deactivationEpoch: 2n, stake: 2n * SOL })
    const undo = node.seedAccount(3, { deactivationEpoch: EPOCH, voter: V2, stake: 2n * SOL })
    const { p, account } = guarded({}, node)
    await p.stake({ amount: SOL })                                       // CreateAccountWithSeed + Initialize + Delegate
    await p.requestWithdrawal({ amount: SOL, account: (await p.getStakeAccounts())[0]!.address }) // CreateAccountWithSeed + Split + Deactivate
    await p.claimWithdrawals()                                           // Withdraw
    await p.delegate({ account: idle, validator: V3 })                   // DelegateStake
    await p.delegate({ account: undo })                                  // reactivate
    await p.merge({ destination: idle, source: other })                  // Merge
    expect(account.sent).toHaveLength(6)
  })

  it('take over a pre-funded slot (Transfer + AllocateWithSeed + Initialize): dust in every slot cannot block staking (audit 2026-10-26, finding 3)', async () => {
    const node = new FakeNode()
    const slot = createWithSeed(WALLET, 'stake:0', STAKE_PROGRAM)
    node.accounts.set(slot, { lamports: 890_880n, owner: SYSTEM_PROGRAM, data: new Uint8Array() })
    const { p, account } = guarded({ maxAccounts: 1 }, node)
    expect((await p.quoteStake({ amount: SOL })).stakeAccount).toBe(slot)
    await p.stake({ amount: SOL })
    expect(account.sent).toHaveLength(1)
  })
})
