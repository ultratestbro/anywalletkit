import { describe, expect, it } from 'vitest'
import { base58Decode, base58Encode, createWithSeed, isAddress } from '../src/address.js'
import {
  decodeStakeAccount, decodeStakeHistory, ixAllocateWithSeed, ixCreateAccountWithSeed, ixDeactivate, ixDelegate, ixInitialize, ixMerge, ixSplit, ixTransfer, ixWithdraw, lockupInForce,
} from '../src/codec.js'
import { STAKE_ACCOUNT_SPACE, STAKE_PROGRAM, SYSTEM_PROGRAM } from '../src/constants.js'

// Golden vectors: instruction bytes and accounts read back from mainnet transactions (2026-10-26),
// so the encoders are checked against what the network accepted, not against themselves.
const MAINNET = {
  // 27DoUdby…: CreateAccountWithSeed + Initialize + DelegateStake by 9bhvaj…
  create: 'qS6TjWJrAqdxHpRgNGf7gPFsoBk2nGCyscRcu3146DYfhqsgt2yqBrYh6oGKK1N5utz4GyBVXUF8tzyFgwBqWGPCjgas69KTE6Xgqp7R43XgnyLfhyr1hzhfzJpQRRRfE5v1G2oqgLbtnrakZUqckBE236DM',
  initialize: '1111QzCi8pVgtK9svB2GcVNWtTKUeTV9H9N214DP4hhAtN9zeAA8euEaMuhM4FcCa6vFynQBRBiRAUfRK2gdy3V1V2PDRLGGStZBbG5r8trRrYnWeHjzFmnbi6piwK1Fc1WDLC8372zT58iURcYVaW1BBc8KA',
  delegate: '3xyZh',
  deactivate: '8QwQj', // 2ikYTnkU…
  withdraw: '5Nvj78GVF7LRqAZV', // GAqiAFed…, 1 082 599 981 lamports
  merge: 'BNuyR', // 589E9cLx…
  split: '4HSo5Vwt1cCH26sq', // 4NfPuPj5…
  /** 2wv6Sys5…: delegated to CatzoSMU… in epoch 1068, 13.1 SOL. */
  activating: 'AgAAAIDVIgAAAAAAf8GEAGLL6VQQ1OKW6eB1dElnCVXJG+hd4QKC9tB5S/F/wYQAYsvpVBDU4pbp4HV0SWcJVckb6F3hAoL20HlL8QAAAAAAAAAAAAAAAAAAAAB/wYQAYsvpVBDU4pbp4HV0SWcJVckb6F3hAoL20HlL8awfg/25zlUN6V1VjNx5VGHM9DdKxojsE6mEACIKeNoGACPSDAMAAAAsBAAAAAAAAP//////////AAAAAAAAAACcVzmLFQUAAAAAAAA=',
  /** First four entries of the StakeHistory sysvar (count patched to 4 below). */
  history: 'AAIAAAAAAAArBAAAAAAAAEdfR53dNxEGw5EbNf1WAwBmtFMMBaIBACoEAAAAAAAATLLDBlz0EAY74ye+p88FAK/xHIs4tQUAKQQAAAAAAAAdf37gszkVBj2VRLMKWgMAwqZJRojIBwAoBAAAAAAAAF+m7fcfLRcGR1udO64OBACZeO3AWysGAA==',
}
const W = '9bhvajVaz6ECMoa93J8p699zkrrH14hoTN1EcPVd1Pzp'
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

describe('addresses', () => {
  it('create_with_seed matches a stake account made on mainnet', () => {
    expect(createWithSeed(W, 'jup:mvo9aw5k:83ed053d:0', STAKE_PROGRAM)).toBe('2wv6Sys5aZyECZm94KVygYzxVQyKi9egorRBAoVEZyS9')
  })
  it('refuses a seed over 32 bytes', () => {
    expect(() => createWithSeed(W, 'x'.repeat(33), STAKE_PROGRAM)).toThrow(/longer than 32/)
  })
  it('base58 round-trips, leading zeros included', () => {
    expect(base58Decode(SYSTEM_PROGRAM)).toEqual(new Uint8Array(32))
    expect(base58Encode(new Uint8Array(32))).toBe(SYSTEM_PROGRAM)
    expect(base58Encode(base58Decode(W))).toBe(W)
    expect(isAddress(W)).toBe(true)
    expect(isAddress('0x1234')).toBe(false)
    expect(isAddress('1'.repeat(44))).toBe(false)
  })
})

describe('instructions, byte for byte against mainnet', () => {
  const stake = '2wv6Sys5aZyECZm94KVygYzxVQyKi9egorRBAoVEZyS9'
  it('CreateAccountWithSeed', () => {
    const ix = ixCreateAccountWithSeed({ payer: W, newAccount: stake, base: W, seed: 'jup:mvo9aw5k:83ed053d:0', lamports: 13_101_666_240n, space: STAKE_ACCOUNT_SPACE, owner: STAKE_PROGRAM })
    expect(base58Encode(ix.data)).toBe(MAINNET.create)
    expect(ix.accounts.map((a) => a.address)).toEqual([W, stake])
  })
  it('Initialize: same layout; this module never sets a custodian', () => {
    const ours = ixInitialize({ stake, staker: W, withdrawer: W }).data
    const theirs = base58Decode(MAINNET.initialize)
    expect(ours.length).toBe(theirs.length)
    expect(ours.subarray(0, 84)).toEqual(theirs.subarray(0, 84)) // tag, staker, withdrawer, unix timestamp, epoch
    expect(theirs.subarray(84)).toEqual(base58Decode(W)) // theirs: custodian = the wallet
    expect(ours.subarray(84)).toEqual(new Uint8Array(32)) // ours: no custodian
  })
  it('AllocateWithSeed and Transfer (4NfPuPj5…: a split destination set up this way)', () => {
    const account = 'xstQFSnKW3NBDJDALFFbbCNWku9jdQeeHeWA2XRRTNe', base = 'BFmkRYJu3GgwhjMfoJFDzAaEzTi2YqKEhdeFULDQJ4A2'
    const alloc = ixAllocateWithSeed({ account, base, seed: 'ec94722fa739fe364c29951ae46b48', space: STAKE_ACCOUNT_SPACE, owner: STAKE_PROGRAM })
    expect(base58Encode(alloc.data)).toBe('ZvJkxfaCkB1dQtV1rJfiZbKjNu2odkuYt2bkCvaX4vJukWRAWhtznvU4FKmq5JmziSPt7VT9KEtop1THd8r4JVFC3gczBDk3GFrph48jkX6FDcWFwA4Ei9zJ795G7BPQZNdjEoKY5rqXRrbm2euhUu1cDGs')
    expect(alloc.accounts.map((a) => a.address)).toEqual([account, base])
    expect(base58Encode(ixTransfer({ from: base, to: account, lamports: 1_666_240n }).data)).toBe('3Bxs4Z3PzVby6QyD')
  })
  it('DelegateStake, Deactivate, Withdraw, Merge, Split', () => {
    const a = W
    expect(base58Encode(ixDelegate({ stake, vote: a, authority: a }).data)).toBe(MAINNET.delegate)
    expect(base58Encode(ixDeactivate({ stake, authority: a }).data)).toBe(MAINNET.deactivate)
    expect(base58Encode(ixWithdraw({ stake, recipient: a, authority: a, lamports: 1_082_599_981n }).data)).toBe(MAINNET.withdraw)
    expect(base58Encode(ixMerge({ destination: stake, source: a, authority: a }).data)).toBe(MAINNET.merge)
    const split = base58Decode(MAINNET.split)
    const lamports = new DataView(split.buffer, split.byteOffset).getBigUint64(4, true)
    expect(base58Encode(ixSplit({ stake, splitStake: a, authority: a, lamports }).data)).toBe(MAINNET.split)
  })
})

describe('account layouts', () => {
  it('decodes a real delegated stake account', () => {
    const s = decodeStakeAccount(fromB64(MAINNET.activating))
    expect(s.kind).toBe('delegated')
    expect(s.staker).toBe(W)
    expect(s.withdrawer).toBe(W)
    expect(s.lockup).toEqual({ unixTimestamp: 0n, epoch: 0n, custodian: W })
    expect(s.delegation).toEqual({ voter: 'CatzoSMUkTRidT5DwBxAC2pEtnwMBTpkCepHkFgZDiqb', stake: 13_100_000_000n, activationEpoch: 1068n, deactivationEpoch: 0xffff_ffff_ffff_ffffn })
    expect(s.rentExemptReserve).toBe(2_282_880n) // the program's fixed pseudo-reserve, not the live rent
  })
  it('decodes the StakeHistory sysvar, newest first', () => {
    const raw = fromB64(MAINNET.history)
    new DataView(raw.buffer, raw.byteOffset).setBigUint64(0, 4n, true)
    const h = decodeStakeHistory(raw)
    expect([...h.keys()]).toEqual([1067n, 1066n, 1065n, 1064n])
    expect(h.get(1067n)!.effective).toBeGreaterThan(400_000_000n * 1_000_000_000n)
  })
  it('short data throws instead of reading garbage', () => {
    expect(() => decodeStakeAccount(fromB64(MAINNET.activating).subarray(0, 100))).toThrow(/too short/)
    expect(decodeStakeAccount(new Uint8Array(200)).kind).toBe('uninitialized')
  })
  it('lockup in force by epoch or by time', () => {
    const custodian = W
    expect(lockupInForce({ unixTimestamp: 0n, epoch: 0n, custodian }, 1068n, 1_800_000_000n)).toBe(false)
    expect(lockupInForce({ unixTimestamp: 0n, epoch: 1069n, custodian }, 1068n, 1_800_000_000n)).toBe(true)
    expect(lockupInForce({ unixTimestamp: 1_900_000_000n, epoch: 0n, custodian }, 1068n, 1_800_000_000n)).toBe(true)
  })
})
