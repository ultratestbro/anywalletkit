'use strict'

// Every instruction this module builds, and the v0 message each operation compiles to, as plain
// strings — compared byte for byte with tests/instruction-bytes.json by instruction-bytes.test.js.
// The fixture pins the output across @solana/* upgrades: derived addresses (PDAs, seed accounts,
// ATAs), account metas and roles, instruction data, and the compiled message bytes.
//
// Regenerate (only when a change of bytes is intended, and say why in the commit):
//   node -e "import('./tests/byte-cases.js').then(async (m) => console.log(JSON.stringify(await m.buildByteCases(), null, 2)))" > tests/instruction-bytes.json

import { appendTransactionMessageInstructions, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/transaction-messages'
import { compileTransaction } from '@solana/transactions'

import SplStakePoolProtocolSolana, { SPL_STAKE_POOL_ADDRESS_MAP, codec } from '../index.js'
import { JITO_POOL_ACCOUNT, JITO_VALIDATOR_LIST_HEAD } from './fixtures.js'

const JITO = SPL_STAKE_POOL_ADDRESS_MAP.jito
const HOLDER = '9hNaQ3crLjWihWa5BeQgSYfrPY3eoDmHJAX2sTWE8nUC'
const OTHER = 'J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8DGUJ9Qv'
const VOTE_A = 'hy1oJTV2kX9acsqpwk7hbteqXFw9VDbWvbxoamFEufW'
const VOTE_B = 'J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8DGUJ9Qv'
const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const SOL = 10n ** 9n
const RENT = 2_077_224n
const EPOCH = 1030n

const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
const toB64 = (u8) => Buffer.from(u8).toString('base64')
const hex = (u8) => Buffer.from(u8).toString('hex')
const le64 = (x) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(x), true); return b }
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }

const POOL_STATE = codec.decodeStakePool(b64(JITO_POOL_ACCOUNT.data))

function tokenAccount (owner, amount) {
  const d = new Uint8Array(165)
  d.set(codec.addressToBytes(JITO.mint), 0)
  d.set(codec.addressToBytes(owner), 32)
  d.set(le64(amount), 64)
  d[108] = 1
  return d
}

function validatorList (entries) {
  const header = cat(Uint8Array.of(2), new Uint8Array(4), (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, entries.length, true); return b })())
  return cat(header, ...entries.map((e) => cat(le64(e.active), le64(0n), le64(EPOCH), le64(0n), new Uint8Array(4), new Uint8Array(4), Uint8Array.of(0), codec.addressToBytes(e.vote))))
}

function stakeAccount ({ authority, stake, deactivationEpoch = 0xffffffffffffffffn }) {
  const d = new Uint8Array(200)
  new DataView(d.buffer).setUint32(0, 2, true)
  d.set(le64(RENT), 4)
  d.set(codec.addressToBytes(authority), 12)
  d.set(codec.addressToBytes(authority), 44)
  d.set(codec.addressToBytes(VOTE_A), 124)
  d.set(le64(stake), 156)
  d.set(le64(900n), 164)
  d.set(le64(deactivationEpoch), 172)
  return d
}

function stubRpc ({ accounts = {}, balances = {} } = {}) {
  const ACCOUNTS = { [JITO.pool]: { data: b64(JITO_POOL_ACCOUNT.data), lamports: JITO_POOL_ACCOUNT.lamports, owner: codec.STAKE_POOL_PROGRAM }, ...accounts }
  const info = (address) => {
    const a = ACCOUNTS[address]
    return a ? { data: [toB64(a.data), 'base64'], lamports: Number(a.lamports ?? 0n), owner: a.owner ?? codec.STAKE_PROGRAM } : null
  }
  return {
    async request (method, params) {
      switch (method) {
        case 'getEpochInfo': return { epoch: Number(EPOCH), slotIndex: 100_000, slotsInEpoch: 432_000 }
        case 'getMinimumBalanceForRentExemption': return Number(RENT)
        case 'getStakeMinimumDelegation': return { value: Number(SOL) }
        case 'getAccountInfo': return { value: info(params[0]) }
        case 'getMultipleAccounts': return { value: params[0].map(info) }
        case 'getBalance': {
          if (params[0] === POOL_STATE.reserveStake) return { value: 1_045_392_561_161 }
          if (params[0] in balances) return { value: Number(balances[params[0]]) }
          return { value: Number(ACCOUNTS[params[0]]?.lamports ?? 0n) }
        }
        default: throw new Error(`stub rpc: unexpected ${method}`)
      }
    }
  }
}

function capture (rpc, config = {}) {
  const sent = []
  const account = {
    async getAddress () { return HOLDER },
    async sendTransaction (message) { sent.push(message); return { hash: 'ab'.repeat(32), fee: 5_000n } },
    async quoteSendTransaction () { return { fee: 5_000n } }
  }
  return { sent, protocol: new SplStakePoolProtocolSolana(account, { provider: rpc, ...config }) }
}

/** One instruction as strings: program, `address:role` per account, data hex. */
export const ixToJson = (ix) => ({ program: ix.programAddress, accounts: ix.accounts.map((a) => `${a.address}:${a.role}`), data: hex(ix.data) })

/** The message as the wallet sends it: v0, the holder pays, a fixed blockhash; the compiled message bytes in hex. */
export function compileMessage (message) {
  let m = createTransactionMessage({ version: message.version })
  m = setTransactionMessageFeePayer(HOLDER, m)
  m = setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 1n }, m)
  m = appendTransactionMessageInstructions(message.instructions, m)
  return hex(compileTransaction(m).messageBytes)
}

const flow = (message) => ({ instructions: message.instructions.map(ixToJson), message: compileMessage(message) })

/** @returns {Promise<Record<string, unknown>>} Every case, keyed by name. */
export async function buildByteCases () {
  const withdrawAuthority = await codec.findWithdrawAuthority(JITO.pool)
  const ata = await codec.findAta(HOLDER, JITO.mint)
  const v0 = codec.decodeValidatorList(b64(JITO_VALIDATOR_LIST_HEAD)).validators[0]
  const slots = []
  for (const i of [0, 1, 7, 8, 39]) slots.push(await codec.findUnstakeAccount(HOLDER, 'Jito', i))
  const voteAStake = await codec.findValidatorStakeAccount(JITO.pool, VOTE_A, 0)

  const derivations = {
    withdrawAuthority,
    ata,
    ataOther: await codec.findAta(OTHER, JITO.mint),
    unstakeSlots: slots,
    validatorStake: await codec.findValidatorStakeAccount(JITO.pool, v0.voteAccount, v0.validatorSeedSuffix),
    validatorStakeSuffix7: await codec.findValidatorStakeAccount(JITO.pool, VOTE_A, 7),
    addressRoundTrip: [JITO.pool, JITO.mint, HOLDER, codec.SYSTEM_PROGRAM].map((a) => codec.bytesToAddress(codec.addressToBytes(a)))
  }

  const pool = { pool: JITO.pool, state: POOL_STATE, withdrawAuthority }
  const encoders = {
    setComputeUnitLimit: ixToJson(codec.ixSetComputeUnitLimit(300_000)),
    setComputeUnitPrice: ixToJson(codec.ixSetComputeUnitPrice(50_000n)),
    createAtaIdempotent: ixToJson(codec.ixCreateAtaIdempotent({ payer: HOLDER, ata, owner: HOLDER, mint: JITO.mint })),
    depositSol: ixToJson(codec.ixDepositSol({ ...pool, from: HOLDER, destination: ata, lamports: SOL })),
    depositSolWithSlippage: ixToJson(codec.ixDepositSol({ ...pool, from: HOLDER, destination: ata, lamports: SOL, minimumPoolTokensOut: 765_357_502n })),
    withdrawSol: ixToJson(codec.ixWithdrawSol({ ...pool, owner: HOLDER, source: ata, poolTokens: SOL / 20n })),
    withdrawSolWithSlippage: ixToJson(codec.ixWithdrawSol({ ...pool, owner: HOLDER, source: ata, poolTokens: SOL / 20n, minimumLamportsOut: 64_612_612n })),
    withdrawStake: ixToJson(codec.ixWithdrawStake({ ...pool, owner: HOLDER, source: ata, splitFrom: voteAStake, splitTo: slots[0], poolTokens: SOL })),
    withdrawStakeWithSlippage: ixToJson(codec.ixWithdrawStake({ ...pool, owner: HOLDER, source: ata, splitFrom: voteAStake, splitTo: slots[0], poolTokens: SOL, minimumLamportsOut: 1_292_252_267n })),
    createAccountWithSeed: ixToJson(codec.ixCreateAccountWithSeed({ from: HOLDER, newAccount: slots[0], base: HOLDER, seed: codec.unstakeSeed('Jito', 0), lamports: SOL + RENT, space: 200n, owner: codec.STAKE_PROGRAM })),
    createAccountWithSeedOtherBase: ixToJson(codec.ixCreateAccountWithSeed({ from: OTHER, newAccount: slots[1], base: HOLDER, seed: codec.unstakeSeed('Jito', 1), lamports: RENT, space: 200n, owner: codec.STAKE_PROGRAM })),
    transferWithSeed: ixToJson(codec.ixTransferWithSeed({ from: slots[0], base: HOLDER, seed: codec.unstakeSeed('Jito', 0), fromOwner: codec.STAKE_PROGRAM, to: HOLDER, lamports: 890_880n })),
    stakeDeactivate: ixToJson(codec.ixStakeDeactivate({ stake: slots[0], authority: HOLDER })),
    stakeWithdraw: ixToJson(codec.ixStakeWithdraw({ stake: slots[0], recipient: HOLDER, authority: HOLDER, lamports: SOL + RENT + 123n }))
  }

  const position = (accounts = {}) => stubRpc({
    accounts: {
      [ata]: { data: tokenAccount(HOLDER, 5n * SOL), lamports: 2_039_280n, owner: codec.TOKEN_PROGRAM },
      [POOL_STATE.validatorList]: { data: validatorList([{ vote: VOTE_A, active: 197_304n * SOL }, { vote: VOTE_B, active: 3_091_411n }]), lamports: 1n, owner: codec.STAKE_POOL_PROGRAM },
      ...accounts
    },
    balances: { [voteAStake]: 197_304n * SOL }
  })

  const flows = {}
  {
    const { sent, protocol } = capture(stubRpc())
    await protocol.stake({ amount: SOL / 10n })
    flows.stake = flow(sent[0])
  }
  {
    const { sent, protocol } = capture(stubRpc(), { computeUnitLimit: 250_000, computeUnitPrice: 1n, slippageBps: 100 })
    await protocol.stake({ amount: 3n * SOL })
    flows.stakeCustomBudget = flow(sent[0])
  }
  {
    const { sent, protocol } = capture(position())
    await protocol.requestWithdrawal({ amount: SOL / 20n, mode: 'instant' })
    flows.instantExit = flow(sent[0])
  }
  {
    const { sent, protocol } = capture(position())
    await protocol.requestWithdrawal({ amount: SOL })
    flows.delayedExit = flow(sent[0])
  }
  {
    const prefunded = { data: new Uint8Array(0), lamports: 890_880n, owner: codec.SYSTEM_PROGRAM }
    const { sent, protocol } = capture(position({ [slots[0]]: prefunded }))
    await protocol.requestWithdrawal({ amount: SOL })
    flows.delayedExitReclaimsPrefundedSlot = flow(sent[0])
  }
  {
    const accounts = {
      [slots[0]]: { data: stakeAccount({ authority: HOLDER, stake: SOL, deactivationEpoch: EPOCH - 1n }), lamports: SOL + RENT + 123n },
      [slots[1]]: { data: stakeAccount({ authority: HOLDER, stake: 2n * SOL, deactivationEpoch: EPOCH - 2n }), lamports: 2n * SOL + RENT }
    }
    const { sent, protocol } = capture(stubRpc({ accounts }))
    await protocol.claimWithdrawals()
    flows.claimTwoSlots = flow(sent[0])
  }

  return { derivations, encoders, flows }
}
