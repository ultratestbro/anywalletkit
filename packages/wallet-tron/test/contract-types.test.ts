import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletManagerTron, toHexAddress, type TronRawTransaction } from '../src/index.js'
import { NOW, RECIPIENT, fakeNode, seal } from './fake-node.js'

// Audit 2026-10-25 round 3, H5: signRaw / sendTransaction(prebuilt) signed any contract type a dApp
// built. An AccountPermissionUpdateContract (a new owner key: the account changes hands) went out
// with only a description warning, as did types the wallet has no decoder for — some move TRX
// (ParticipateAssetIssue, Exchange*, MarketSellAsset, CreateSmartContract with a call value).
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const WITNESS = toHexAddress(RECIPIENT)

function contract(me: string, type: string, rest: string): TronRawTransaction {
  return seal({
    contract: [{ type, parameter: { value: { owner_address: me, raw_parameter_hex: '0a15' + me + rest }, type_url: `type.googleapis.com/protocol.${type}` } }],
    ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW,
  })
}
// field 2 = owner Permission { type = Owner, permission_name = "foo" } — enough for the type check
const permissionUpdate = (me: string) => contract(me, 'AccountPermissionUpdateContract', '12050a03666f6f')
// to_address (2) = the issuer, asset_name (3), amount (4): pays TRX for TRC-10 tokens
const participate = (me: string) => contract(me, 'ParticipateAssetIssueContract', '1215' + WITNESS + '1a0131' + '20c0843d')
// votes (2) = [{ vote_address, vote_count: 5 }]: re-assigns votes, moves nothing
const vote = (me: string) => contract(me, 'VoteWitnessContract', '1219' + '0a15' + WITNESS + '1005')

beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }) })
afterEach(() => { vi.useRealTimers() })

describe('Tron contract types the wallet will sign', () => {
  it('refuses an AccountPermissionUpdateContract (signRaw, sendTransaction, signTransaction) unless allowPermissionChanges', async () => {
    const f = fakeNode()
    const a = await new WalletManagerTron(SEED, { provider: f.fetch }).getAccount(0)
    const tx = permissionUpdate(toHexAddress(a.address))
    await expect(a.signRaw(tx)).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'permission-change' })
    await expect(a.sendTransaction(tx)).rejects.toMatchObject({ code: 'permission-change' })
    await expect(a.signTransaction(tx)).rejects.toMatchObject({ code: 'permission-change' })
    expect(f.broadcast).toHaveLength(0)
    // allowUndecodedContracts is not enough: handing over the keys is its own decision
    const undecoded = await new WalletManagerTron(SEED, { provider: f.fetch, allowUndecodedContracts: true }).getAccount(0)
    await expect(undecoded.signRaw(tx)).rejects.toMatchObject({ code: 'permission-change' })
    const allowed = await new WalletManagerTron(SEED, { provider: f.fetch, allowPermissionChanges: true }).getAccount(0)
    expect((await allowed.signRaw(tx)).signature).toHaveLength(1)
  })

  it('refuses a contract type it cannot decode unless allowUndecodedContracts', async () => {
    const f = fakeNode()
    const a = await new WalletManagerTron(SEED, { provider: f.fetch }).getAccount(0)
    const tx = participate(toHexAddress(a.address))
    await expect(a.signRaw(tx)).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'undecoded-contract' })
    await expect(a.sendTransaction(tx)).rejects.toMatchObject({ code: 'undecoded-contract' })
    expect(f.broadcast).toHaveLength(0)
    const allowed = await new WalletManagerTron(SEED, { provider: f.fetch, allowUndecodedContracts: true }).getAccount(0)
    expect((await allowed.signRaw(tx)).signature).toHaveLength(1)
  })

  it('still signs a VoteWitnessContract (votes only, nothing moves) and the decoded types', async () => {
    const a = await new WalletManagerTron(SEED).getAccount(0)
    const me = toHexAddress(a.address)
    expect((await a.signRaw(vote(me))).signature).toHaveLength(1)
    const transfer = seal({
      contract: [{ type: 'TransferContract', parameter: { value: { owner_address: me, to_address: WITNESS, amount: 1 }, type_url: 'type.googleapis.com/protocol.TransferContract' } }],
      ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW,
    })
    expect((await a.signRaw(transfer)).signature).toHaveLength(1)
  })
})
