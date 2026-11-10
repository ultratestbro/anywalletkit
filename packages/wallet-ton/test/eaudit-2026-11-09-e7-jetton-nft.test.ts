import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { Address, beginCell } from '@ton/core'
import { JETTON_TRANSFER_OP, NFT_TRANSFER_OP, commentCell, decodeBody, describeTransaction } from '../src/index.js'

// extension audit 2026-11-09 E7: a TON Connect jetton or NFT transfer looked like a small GRAM spend to the user's own
// jetton wallet. The description now carries the real recipient of each, and flags state init, NFT transfers and unknown ops.
const OWN_JETTON_WALLET = Address.parse('0:' + '11'.repeat(32)).toString({ bounceable: true })
const ATTACKER = Address.parse('0:' + 'aa'.repeat(32))
const ME = Address.parse('0:' + '7a'.repeat(32))
const NFT_ITEM = Address.parse('0:' + '22'.repeat(32)).toString({ bounceable: true })

const jettonAll = () => beginCell().storeUint(JETTON_TRANSFER_OP, 32).storeUint(0n, 64).storeCoins(123_456_789n)
  .storeAddress(ATTACKER).storeAddress(ATTACKER).storeMaybeRef(null).storeCoins(1n).storeMaybeRef(commentCell('gm')).endCell()
const nftTransfer = () => beginCell().storeUint(NFT_TRANSFER_OP, 32).storeUint(9n, 64)
  .storeAddress(ATTACKER).storeAddress(ME).storeMaybeRef(null).storeCoins(10_000_000n).storeBit(0).endCell()

describe('E7: jetton and NFT transfers are decoded to their real recipients', () => {
  it('a TEP-74 transfer sent to the own jetton wallet names the jetton recipient, amount and response destination', () => {
    const d = describeTransaction({ to: OWN_JETTON_WALLET, value: 50_000_000n, body: jettonAll() })
    expect(d.kind).toBe('jetton-transfer')
    expect(d.items[0]!.jetton).toMatchObject({ amount: 123_456_789n, destination: ATTACKER.toString(), responseDestination: ATTACKER.toString(), forwardPayload: 'comment', forwardComment: 'gm' })
  })

  it('a TEP-62 NFT transfer is decoded (new owner, response destination, forward amount) and warned about', () => {
    expect(decodeBody(nftTransfer())).toMatchObject({ type: 'nft-transfer', nft: { newOwner: ATTACKER.toString(), responseDestination: ME.toString(), forwardTonAmount: 10_000_000n, queryId: 9n } })
    const d = describeTransaction({ to: NFT_ITEM, value: 50_000_000n, body: nftTransfer() })
    expect(d.kind).toBe('nft-transfer')
    expect(d.items[0]).toMatchObject({ kind: 'nft-transfer', op: '0x5fcc3d14', nft: { newOwner: ATTACKER.toString() } })
    expect(d.warnings).toEqual([{ code: 'nft-transfer', message: expect.stringContaining(ATTACKER.toString()), index: 0 }])
  })

  it('a message carrying a state init and a contract call with an unknown op are warned about', () => {
    const init = beginCell().storeUint(0, 2).storeMaybeRef(null).storeMaybeRef(null).storeMaybeRef(null).endCell()
    const d = describeTransaction([
      { to: OWN_JETTON_WALLET, value: 1n, stateInit: init.toBoc().toString('base64') },
      { to: OWN_JETTON_WALLET, value: 1n, body: beginCell().storeUint(0xabcdef01, 32).endCell() },
    ])
    expect(d.warnings.map((w) => [w.code, w.index])).toEqual([['state-init', 0], ['unknown-op', 1]])
  })
})
