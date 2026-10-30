import { describe, expect, it } from 'vitest'
import { Address, Cell, TupleReader, beginCell } from '@ton/core'
import { TonClient } from '@ton/ton'
import TonstakersProtocolTon, { TONSTAKERS_ADDRESS_MAP, TONSTAKERS_JETTON_WALLET_CODES, UNSTAKE_FEE_RESERVE, deriveTonstakersJettonWallet } from '../index.js'

// scan 2026-10-30 F12: requestWithdrawal sent the 1.05 GRAM unstake reserve to whatever the node's
// get_wallet_address returned. The jetton wallet is now derived on the device from the pinned code.
const MINTER = TONSTAKERS_ADDRESS_MAP['-239']!.jetton!
const TESTNET_MINTER = TONSTAKERS_ADDRESS_MAP['-3']!.jetton!
const OWNER = 'UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq'
const JETTON_WALLET = 'EQB15F1CTmKEBo6qAiljTPnYtSU3131xyY31MPFBVA_dsl3o' // OWNER's real tsTON wallet
const ATTACKER = 'EQB4UnpaXqYPlnjo3F8_1v1Xyr15TxCL__S0xlXlA3E1AHn9'
const addrCell = (a: string | Address) => ({ type: 'cell', cell: beginCell().storeAddress(typeof a === 'string' ? Address.parse(a) : a).endCell() })
const int = (v: bigint) => ({ type: 'int', value: v })
const code = (minter: string) => Cell.fromBase64(TONSTAKERS_JETTON_WALLET_CODES[Address.parse(minter).toRawString()]!)

// Real mainnet holders (toncenter v3 /jetton/wallets, 2026-10-30): owner → deployed tsTON wallet.
const HOLDERS: Array<[string, string]> = [
  ['0:DB7FF3D4D432C072778CCD68E351B2BF55CEE86A13F488EA6E1DBC48C037DA23', '0:117839D5486C8088542CF350AF518ECA36B3D28BEF00B759DB89D9F66EAA9099'],
  ['0:5FC1EB0442D7BAF8E9E756846BA17836161B3990A42D7C821318FDB6086F7CF9', '0:91B362FEB8981853958CA052A6497683BA1A8E1FD809F243F7529CD254A0FE62'],
  ['0:1508057E9D3CA62AD9D0BF428295D79A156C8852563A929BB839E604936A7314', '0:9159234C7B7469C8E860DE3AE7FCA5A2A6F894C7947744A44D0C326676BA09F4'],
  ['0:BCAD466A47FA565750729565253CD073CA24D856804499090C2100D95C809F9E', '0:910B4B5E961BF54044AF4F1DB89CDA94581EF6CC2CAC5D0D01C7DEE5573B9C43'],
  ['0:BD1F9380EA27616D2BB9B873B9A14999C1A8EBAB4EB813EF730BC506C5DB2FDE', '0:7874A3A66C807F03FAE7CBAD7E030C5EB168D713EBA4B5D4DE3A7BC8D7F00106'],
]

/** A client whose get_wallet_address answers `wallet(owner, minter)`; get_wallet_data reports 5 tsTON. */
function client(wallet: (owner: Address, minter: Address) => Address | string, seen: string[] = []) {
  const c = Object.create(TonClient.prototype)
  c.runMethodWithError = async (address: Address, name: string, args: any[]) => {
    seen.push(`${name}@${address.toString()}`)
    if (name === 'get_wallet_address') return { exit_code: 0, gas_used: 1, stack: new TupleReader([addrCell(wallet(args[0].cell.beginParse().loadAddress(), address))] as never) }
    if (name === 'get_wallet_data') return { exit_code: 0, gas_used: 1, stack: new TupleReader([int(5n * 10n ** 9n), addrCell(OWNER), addrCell(MINTER), { type: 'cell', cell: new Cell() }] as never) }
    if (name === 'get_pool_full_data') {
      const items: any[] = Array.from({ length: 30 }, () => int(0n))
      items[12] = addrCell(TESTNET_MINTER)
      return { exit_code: 0, gas_used: 1, stack: new TupleReader(items as never) }
    }
    throw new Error(`unexpected ${name}`)
  }
  return c
}
const account = (c: unknown, owner = OWNER, chain = 'ton:-239') => {
  const sent: any[] = []
  return { sent, chain, _tonClient: c, async getAddress() { return owner }, async sendTransaction(tx: any) { sent.push(tx); return { hash: 'ab'.repeat(32), fee: 1n } }, async quoteSendTransaction() { return { fee: 1n } } }
}
const honest = (o: Address, m: Address) => deriveTonstakersJettonWallet(o, m, code(m.toString()))

describe('scan 2026-10-30 F12: the tsTON jetton wallet is derived on the device', () => {
  it('the pinned mainnet code derives the real wallets of real holders', () => {
    expect(deriveTonstakersJettonWallet(Address.parse(OWNER), Address.parse(MINTER), code(MINTER)).equals(Address.parse(JETTON_WALLET))).toBe(true)
    for (const [owner, wallet] of HOLDERS) {
      expect(deriveTonstakersJettonWallet(Address.parse(owner), Address.parse(MINTER), code(MINTER)).equals(Address.parse(wallet))).toBe(true)
    }
  })

  it('a node naming another address: no withdrawal is sent, quote and balance are refused', async () => {
    const acc = account(client(() => ATTACKER))
    const p = new TonstakersProtocolTon(acc)
    await expect(p.requestWithdrawal({ amount: 10n ** 9n })).rejects.toThrow(/refused/)
    await expect(p.quoteRequestWithdrawal({ amount: 10n ** 9n })).rejects.toThrow(/refused/)
    await expect(p.getTokenBalance()).rejects.toThrow(/refused/)
    await expect(p.getJettonWallet()).rejects.toThrow(/refused/)
    expect(acc.sent).toEqual([])
    expect(UNSTAKE_FEE_RESERVE).toBe(1_050_000_000n)
  })

  it('honest node: the withdrawal goes to the derived wallet; quote and balance work', async () => {
    const seen: string[] = []
    const acc = account(client(honest, seen))
    const p = new TonstakersProtocolTon(acc)
    await p.requestWithdrawal({ amount: 10n ** 9n })
    expect(acc.sent.map((t) => ({ to: t.to, value: t.value }))).toEqual([{ to: JETTON_WALLET, value: UNSTAKE_FEE_RESERVE }])
    expect(await p.quoteRequestWithdrawal({ amount: 10n ** 9n })).toEqual({ fee: 1n })
    expect(await p.getTokenBalance()).toBe(5n * 10n ** 9n)
    expect(seen).toContain(`get_wallet_data@${JETTON_WALLET}`)
  })

  it('testnet: the default minter is pinned too, so the testnet flow works without config', async () => {
    const owner = new Address(0, Buffer.alloc(32, 0x5a)).toString({ testOnly: true, bounceable: false })
    const acc = account(client(honest), owner, 'ton:-3')
    const p = new TonstakersProtocolTon(acc)
    await p.requestWithdrawal({ amount: 10n ** 9n })
    expect(Address.parse(acc.sent[0].to).equals(honest(Address.parse(owner), Address.parse(TESTNET_MINTER)))).toBe(true)
  })

  it('a minter with no known code is refused unless the app passes its code or opts out', async () => {
    const other = new Address(0, Buffer.alloc(32, 0x11)).toString()
    const otherCode = code(MINTER) // any code cell will do for the test
    const derivedOther = (o: Address) => deriveTonstakersJettonWallet(o, Address.parse(other), otherCode)

    const refused = new TonstakersProtocolTon(account(client(() => ATTACKER)), { addresses: { jetton: other } })
    await expect(refused.getJettonWallet()).rejects.toThrow(/No known tsTON jetton-wallet code.*allowUnverifiedJettonWallet/)

    const pinnedByApp = new TonstakersProtocolTon(account(client((o) => derivedOther(o))), { addresses: { jetton: other }, jettonWalletCode: otherCode.toBoc().toString('base64') })
    expect((await pinnedByApp.getJettonWallet()).equals(derivedOther(Address.parse(OWNER)))).toBe(true)
    const pinnedByAppHostile = new TonstakersProtocolTon(account(client(() => ATTACKER)), { addresses: { jetton: other }, jettonWalletCode: otherCode })
    await expect(pinnedByAppHostile.getJettonWallet()).rejects.toThrow(/refused/)

    const optedOut = new TonstakersProtocolTon(account(client(() => ATTACKER)), { addresses: { jetton: other }, allowUnverifiedJettonWallet: true })
    expect((await optedOut.getJettonWallet()).equals(Address.parse(ATTACKER))).toBe(true)
  })
})
