import { describe, expect, it } from 'vitest'
import {
  appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, setTransactionMessageLifetimeUsingDurableNonce, type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { getAssignInstruction, getTransferSolInstruction } from '@solana-program/system'
import { AuthorityType, getSetAuthorityInstruction } from '@solana-program/token'
import { WalletManagerSolana, ZERO_ADDRESS } from '../src/index.js'

// Audit 2026-10-25 round 3 (open item from the post-release round): signCompiled and
// signTransactionMessage are public signing primitives that ran none of the wallet's checks, so a
// caller could get a drainer shape, a burn or a durable nonce signed through them. They now run
// the same enforce() as every other signing path (with the same opt-ins).

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const TO = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb' as Address
const DRAINER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const ATA = 'BQcdHdAQW1hczDbBi9hiegXPR7MzRYNM4gYHBJLjHCkS' as Address
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'

const me = createNoopSigner(ME)
const msg = (ixs: Instruction[], nonce = false) => pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayer(ME, m),
  (m) => (nonce
    ? setTransactionMessageLifetimeUsingDurableNonce({ nonce: BLOCKHASH as never, nonceAccountAddress: DRAINER, nonceAuthorityAddress: ME }, m)
    : setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, m)),
  (m) => appendTransactionMessageInstructions(ixs, m),
) as unknown as TransactionMessage
const compiled = (m: TransactionMessage) => compileTransaction(m as never) as Transaction

const transfer = getTransferSolInstruction({ source: me, destination: TO, amount: 1n })
const cases: Array<[string, TransactionMessage, string]> = [
  ['a token authority handed away', msg([getSetAuthorityInstruction({ owned: ATA, owner: me, authorityType: AuthorityType.AccountOwner, newAuthority: DRAINER })]), 'sets-authority'],
  ["the wallet's account reassigned", msg([getAssignInstruction({ account: me, programAddress: DRAINER })]), 'assigns-wallet'],
  ['a transfer to the burn address', msg([getTransferSolInstruction({ source: me, destination: ZERO_ADDRESS as Address, amount: 1n })]), ''],
  ['a durable nonce', msg([transfer], true), 'durable-nonce'],
]

describe('signCompiled / signTransactionMessage run the wallet checks', async () => {
  const a = await new WalletManagerSolana(SEED, {}).getAccount(0)
  for (const [name, m] of cases) {
    it(`refuse ${name}`, async () => {
      await expect(a.signTransactionMessage(m)).rejects.toMatchObject({ name: 'UnsafeTransactionError' })
      // @solana/kit will not even compile a transfer to the System program (a writable program address)
      if (name.includes('burn')) return
      await expect(a.signCompiled(compiled(m))).rejects.toMatchObject({ name: 'UnsafeTransactionError' })
    })
  }

  it('sign the ordinary shapes, and a durable nonce when the call opts in', async () => {
    expect((await a.signTransactionMessage(msg([transfer]))).signatures[ME]).toBeDefined()
    expect((await a.signCompiled(compiled(msg([transfer])))).signatures[ME]).toBeDefined()
    expect((await a.signCompiled(compiled(msg([transfer], true)), { allowDurableNonce: true })).signatures[ME]).toBeDefined()
  })
})
