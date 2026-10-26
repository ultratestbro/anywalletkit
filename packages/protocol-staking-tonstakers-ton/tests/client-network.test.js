'use strict'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Address } from '@ton/core'

import TonstakersProtocolTon from '../index.js'

const OWNER = 'UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG'
const MAINNET_POOL = 'EQCkWxfyhAkim3g2DjKQQg8T5P4g-Q1-K_jErGcDJZ4i-vqR'
const TESTNET_POOL = 'kQANFsYyYn-GSZ4oajUJmboDURZU-udMHf9JxzO4vYM_hFP3'

/** A wallet-ton `TonRpc`: toncenter v2 JSON-RPC methods → results. */
const tonRpc = (seen = []) => ({
  async call (method, params) {
    seen.push({ method, params })
    // toncenter v2 getAddressInformation, as TonClient.getBalance asks for it
    if (method === 'getAddressInformation') {
      return {
        balance: '123000000000', state: 'active', data: '', code: '',
        last_transaction_id: { '@type': 'internal.transactionId', lt: '0', hash: '' },
        block_id: { '@type': 'ton.blockIdExt', workchain: -1, shard: '-9223372036854775808', seqno: 1, root_hash: '', file_hash: '' },
        sync_utime: 0
      }
    }
    throw new Error(`unexpected ${method}`)
  }
})
const account = (config, chain = 'ton:-239') => ({ chain, async getAddress () { return OWNER }, _config: config })

// Audit 2026-10-25 round 3, L19.
test('the documented `provider` alias of the account config is used (it was ignored: "must be initialized with a tonClient")', async () => {
  const seen = []
  const p = new TonstakersProtocolTon(account({ provider: tonRpc(seen) }))
  assert.equal(await p.getInstantLiquidity(), 123_000_000_000n)
  assert.equal(seen[0].method, 'getAddressInformation')
})

test('a TonRpc is driven as one (it was wrapped as TonClient({ endpoint: undefined }))', async () => {
  const seen = []
  const p = new TonstakersProtocolTon(account({ tonClient: [tonRpc(seen)] }))
  assert.equal(await p.getInstantLiquidity(), 123_000_000_000n)
  assert.ok(Address.parse(seen[0].params.address).equals(Address.parse(MAINNET_POOL)))
  const viaConfig = new TonstakersProtocolTon(account({}), { tonClient: tonRpc() })
  assert.equal(await viaConfig.getInstantLiquidity(), 123_000_000_000n)
})

test('a testnet account stakes into the testnet pool; a mainnet config on it is refused', async () => {
  const seen = []
  const p = new TonstakersProtocolTon(account({ network: 'testnet', provider: tonRpc(seen) }, 'ton:-3'))
  await p.getInstantLiquidity()
  assert.ok(Address.parse(seen[0].params.address).equals(Address.parse(TESTNET_POOL)))
  assert.throws(() => new TonstakersProtocolTon(account({ network: 'testnet' }, 'ton:-3'), { network: '-239' }), /testnet.*mainnet|-3.*-239/)
  assert.throws(() => new TonstakersProtocolTon(account({}), { network: '-3' }), /mainnet.*testnet|-239.*-3/)
})
