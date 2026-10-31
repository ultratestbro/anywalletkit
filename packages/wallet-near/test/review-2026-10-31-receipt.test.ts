import { describe, expect, it } from 'vitest'
import { WalletManagerNear, receiptOf, type NearFetch } from '../src/index.js'
import { SEED, fakeNode } from './fake-node.js'

// getTransactionReceipt answered `{status: 1}` for a transaction the node had not executed yet
// (final_execution_status NONE / INCLUDED). The core contract is `undefined` while pending.

async function receiptFor(outcome: unknown) {
  const base = fakeNode()
  const fetch: NearFetch = async (method, params) => (method === 'tx' ? outcome : base.fetch(method, params))
  return (await new WalletManagerNear(SEED, { provider: fetch }).getAccount(0)).getTransactionReceipt('HASH')
}

const FAIL = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'boom' } } } } }

describe('NEAR receipts', () => {
  for (const outcome of [
    { final_execution_status: 'NONE' },
    { final_execution_status: 'INCLUDED' },
    { final_execution_status: 'INCLUDED', transaction: { hash: 'x' } },
    { final_execution_status: 'INCLUDED_FINAL', status: 'Started' as never },
    { status: 'NotStarted' },
    { status: 'Started', final_execution_status: 'EXECUTED_OPTIMISTIC' },
    { transaction: { hash: 'x' } },
  ]) {
    it(`pending: ${JSON.stringify(outcome)} → undefined`, async () => {
      expect(await receiptFor(outcome)).toBeUndefined()
    })
  }

  it('executed with SuccessValue → status 1', async () => {
    expect((await receiptFor({ status: { SuccessValue: '' }, final_execution_status: 'FINAL' }))?.status).toBe(1)
    expect((await receiptFor({ status: { SuccessValue: '' }, final_execution_status: 'EXECUTED_OPTIMISTIC' }))?.status).toBe(1)
    expect(receiptOf('H', { status: { SuccessReceiptId: 'R' } })?.status).toBe(1)
  })

  it('a failed transaction or receipt → status 0 with the failure', async () => {
    const top = await receiptFor({ status: FAIL, final_execution_status: 'FINAL' })
    expect(top).toMatchObject({ status: 0, failure: 'boom' })
    const inner = await receiptFor({ status: { SuccessValue: '' }, final_execution_status: 'FINAL', receipts_outcome: [{ outcome: { status: FAIL } }] })
    expect(inner).toMatchObject({ status: 0, failure: 'boom' })
  })

  it('an unknown transaction → undefined', async () => {
    expect(await receiptFor(undefined)).toBeUndefined()
  })
})
