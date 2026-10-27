import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { WalletManagerBtc } from '@anywalletkit/wallet-btc'
import { Wallet, applyPolicies } from '../src/index.js'

// Regression tests for the 2026-10-27 key/signing scan: each one replays the exploit input from
// the report against a policy-guarded account and expects it to be refused or flagged unknown.

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const BTC = 'bip122:000000000019d6689c085ae165831e93'
const BTC_ALLOWED = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'
const BTC_ATTACKER = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'

describe('scan 2026-10-27 G1 (F1): internal signing helpers behind the policy wrapper', () => {
  it('a guarded BTC account does not hand out signPlan, signInputs or signSpend', async () => {
    const w = new Wallet(PHRASE, { policies: { allowlist: { bip122: [BTC_ALLOWED] } } })
    w.registerWallet('bip122', WalletManagerBtc, {})
    const account = (await w.getAccount(BTC)) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    const plan = { to: BTC_ALLOWED, amount: 1000n, change: 0n, fee: 2000n, feeRate: 1n, utxos: [{ txid: '11'.repeat(32), vout: 0, value: 100_000n }] }
    // The exploit: the plan names the allowlisted address, the payment goes to the second argument.
    const attempts = [
      () => account.signPlan!(plan, BTC_ATTACKER, 98_000n, 0n, 0, true),
      () => account.signInputs!({ inputsLength: 0 }, []),
      () => account.signSpend!({ to: BTC_ALLOWED, value: 1000n }),
    ]
    for (const attempt of attempts) await expect((async () => attempt())()).rejects.toThrow()
    for (const name of ['signPlan', 'signInputs', 'signSpend']) expect([name, typeof account[name]]).toEqual([name, 'undefined'])
    w.dispose()
  })

  it('any sign* / send* method outside the known write surface is refused, with or without a fee cap', async () => {
    const helpers = { signPrepared: async () => '0xsigned', signHash: async () => '0xsig', sendRawThing: async () => '0xhash' }
    for (const policies of [{}, { allowlist: { 'eip155:1': ['0x000000000000000000000000000000000000beef'] } }, { confirm: async () => true }]) {
      const raw = Object.assign(createMockAccount({ chain: 'eip155:1' }), helpers)
      const guarded = applyPolicies(raw, policies, 'eip155:1') as unknown as typeof helpers
      await expect(guarded.signPrepared()).rejects.toMatchObject({ name: 'PolicyViolationError', policy: 'method' })
      await expect(guarded.signHash()).rejects.toMatchObject({ name: 'PolicyViolationError', policy: 'method' })
      await expect(guarded.sendRawThing()).rejects.toMatchObject({ name: 'PolicyViolationError', policy: 'method' })
    }
  })
})

const TON = 'ton:-239'
const TON_SELF = `0:${'11'.repeat(32)}`
const TON_TREASURY = `0:${'aa'.repeat(32)}`
const TON_ATTACKER = `0:${'bb'.repeat(32)}`
const TON_USDT = `0:${'cc'.repeat(32)}`
const TON_FAKE_MASTER = `0:${'dd'.repeat(32)}`

describe('scan 2026-10-27 G2 (F3, F5, F9): TON jetton transfer() is judged on everything that receives TON', () => {
  const tonAccount = () => createMockAccount({ chain: TON, address: TON_SELF })

  it('an attacker responseDestination is a destination: allowlist and blocklist refuse it', async () => {
    const exploit = { token: TON_USDT, recipient: TON_TREASURY, amount: 1n, attachedValue: 500_000_000_000n, responseDestination: TON_ATTACKER }
    const a = tonAccount()
    await expect(applyPolicies(a, { allowlist: { ton: [TON_TREASURY, TON_USDT] } }, TON).transfer(exploit)).rejects.toMatchObject({ policy: 'allowlist' })
    await expect(applyPolicies(a, { blocklist: { ton: [TON_ATTACKER] } }, TON).transfer(exploit)).rejects.toMatchObject({ policy: 'blocklist' })
    expect(a.sent).toHaveLength(0)
  })

  it('the jetton master is a destination: a fake master is refused under an allowlist', async () => {
    const a = tonAccount()
    const exploit = { token: TON_FAKE_MASTER, recipient: TON_TREASURY, amount: 1n, attachedValue: 500_000_000_000n }
    await expect(applyPolicies(a, { allowlist: { ton: [TON_TREASURY] } }, TON).transfer(exploit)).rejects.toMatchObject({ policy: 'allowlist' })
    expect(a.sent).toHaveLength(0)
  })

  it('a forward or custom payload cell cannot be read: destinationUnknown; confirm sees attachedValue and forwardTonAmount', async () => {
    const a = tonAccount()
    const cell = { bits: { length: 0, at: () => false }, refs: [] }
    for (const extra of [{ forwardPayload: cell }, { customPayload: cell }]) {
      await expect(applyPolicies(a, { allowlist: { ton: [TON_TREASURY, TON_USDT] } }, TON).transfer({ token: TON_USDT, recipient: TON_TREASURY, amount: 1n, ...extra })).rejects.toMatchObject({ policy: 'allowlist' })
    }
    let seen: Record<string, unknown> = {}
    await applyPolicies(a, { allowlist: { ton: [TON_TREASURY, TON_USDT] }, confirm: async (i) => { seen = i as never; return true } }, TON)
      .transfer({ token: TON_USDT, recipient: TON_TREASURY, amount: 1n, responseDestination: TON_SELF, attachedValue: 60_000_000n, forwardTonAmount: 10_000_000n, memo: 'invoice 7' } as never)
    expect(seen).toMatchObject({ destinations: [TON_TREASURY, TON_USDT], destinationUnknown: false, attachedValue: 60_000_000n, forwardTonAmount: 10_000_000n })
    expect(a.sent).toHaveLength(1)
  })
})

// A TEP-74 transfer of 1 jetton to TON_ATTACKER (response TON_ATTACKER), as @ton/core serialises it, and
// the same cell with the with_hashes flag (d1 | 0x10) and a zero hash area in front of its data.
const TRANSFER_TO_ATTACKER = 'te6ccgEBAQEAVwAAqg+KfqUAAAAAAAAAB0O5rKAIAXd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3AC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7uwgI='
const WITH_HASHES = 'te6ccgEBAQEAeQAQqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPin6lAAAAAAAAAAdDuaygCAF3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3dwAu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7sIC'
const TON_JETTON_WALLET = `0:${'ee'.repeat(32)}`

describe('scan 2026-10-27 G3 (F2, F4): a TON body the kit cannot read the way the signer does is unknown', () => {
  const send = (policies: Parameters<typeof applyPolicies>[1], tx: unknown) => applyPolicies(createMockAccount({ chain: TON, address: TON_SELF }), policies, TON).sendTransaction(tx as never)

  it('the canonical transfer names the attacker (control)', async () => {
    await expect(send({ blocklist: { ton: [TON_ATTACKER] } }, { to: TON_JETTON_WALLET, value: 50_000_000n, bodyBoc: TRANSFER_TO_ATTACKER })).rejects.toMatchObject({ policy: 'blocklist' })
  })

  it('a with_hashes BoC hiding the transfer is refused by the allowlist and by a blocklist without confirm', async () => {
    const tx = { to: TON_JETTON_WALLET, value: 50_000_000n, bodyBoc: WITH_HASHES }
    await expect(send({ allowlist: { ton: [TON_JETTON_WALLET] } }, tx)).rejects.toMatchObject({ policy: 'allowlist' })
    await expect(send({ blocklist: { ton: [TON_ATTACKER] } }, tx)).rejects.toMatchObject({ policy: 'blocklist' })
  })

  it('a Cell-shaped body that is not a Cell is unknown, whatever bodyBoc says', async () => {
    const tx = { to: TON_JETTON_WALLET, value: 50_000_000n, body: { bits: { length: 0, at: () => false } }, bodyBoc: TRANSFER_TO_ATTACKER }
    await expect(send({ allowlist: { ton: [TON_JETTON_WALLET] } }, tx)).rejects.toMatchObject({ policy: 'allowlist' })
    let seen: Record<string, unknown> = {}
    await send({ confirm: async (i) => { seen = i as never; return true } }, tx)
    expect(seen.destinationUnknown).toBe(true)
  })
})

describe('scan 2026-10-27 G4 (F18): a TON address in a loose spelling is not a known destination', () => {
  const hex = 'ab'.repeat(32)
  const loose = [`+0:${hex}`, ` 0:${hex}`, `0.0:${hex}`, `0:${hex}:x`, `0:${hex} `]
  it('the blocklist cannot be dodged with +0:, a space, 0.0: or a suffix', async () => {
    for (const to of loose) {
      const a = createMockAccount({ chain: TON, address: TON_SELF })
      await expect(applyPolicies(a, { blocklist: { ton: [`0:${hex}`] } }, TON).sendTransaction({ to, value: 1n } as never)).rejects.toMatchObject({ policy: 'blocklist' })
      await expect(applyPolicies(a, { blocklist: { ton: [`0:${hex}`] } }, TON).transfer({ recipient: to, amount: 1n })).rejects.toMatchObject({ policy: 'blocklist' })
      let seen: Record<string, unknown> = {}
      await applyPolicies(a, { confirm: async (i) => { seen = i as never; return true } }, TON).transfer({ recipient: to, amount: 1n })
      expect([to, seen.destinationUnknown]).toEqual([to, true])
    }
  })
  it('the strict raw and friendly forms stay known', async () => {
    let seen: Record<string, unknown> = {}
    const a = createMockAccount({ chain: TON, address: TON_SELF })
    await applyPolicies(a, { confirm: async (i) => { seen = i as never; return true } }, TON).transfer({ recipient: `-1:${hex}`, amount: 1n })
    expect(seen.destinationUnknown).toBe(false)
    await applyPolicies(a, { confirm: async (i) => { seen = i as never; return true } }, TON).transfer({ recipient: 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi', amount: 1n })
    expect(seen.destinationUnknown).toBe(false)
  })
})

describe('scan 2026-10-27 G5 (F7, F8, F16): a NEAR method name the kit reads as non-ASCII is unknown', () => {
  it('base64 borsh with EF BB BF + ft_transfer to drainer.near is refused under the allowlist', async () => {
    const { encodeTransaction, toBase64 } = await import('@anywalletkit/wallet-near')
    const tx = toBase64(encodeTransaction({
      signerId: 'alice.near', publicKey: { keyType: 'ed25519', data: new Uint8Array(32).fill(1) }, nonce: 7n, receiverId: 'usdt.tether-token.near', blockHash: new Uint8Array(32).fill(9),
      actions: [{ functionCall: { methodName: '﻿ft_transfer', args: { receiver_id: 'drainer.near', amount: '1000000' }, gas: 30n * 10n ** 12n, deposit: 1n } }],
    }))
    const near = () => createMockAccount({ chain: 'near:mainnet', address: 'alice.near' })
    await expect(applyPolicies(near(), { allowlist: { near: ['usdt.tether-token.near', 'friend.near'] } }, 'near:mainnet').sendTransaction(tx as never)).rejects.toMatchObject({ policy: 'allowlist' })
    let seen: Record<string, unknown> = {}
    await applyPolicies(near(), { confirm: async (i) => { seen = i as never; return true } }, 'near:mainnet').sendTransaction(tx as never)
    expect(seen.destinationUnknown).toBe(true)
  })

  it('an object action with a non-ASCII method name is unknown too', async () => {
    let seen: Record<string, unknown> = {}
    const tx = { receiverId: 'usdt.tether-token.near', actions: [{ functionCall: { methodName: '﻿ft_transfer', args: { receiver_id: 'drainer.near', amount: '1' }, gas: 1n, deposit: 1n } }] }
    await applyPolicies(createMockAccount({ chain: 'near:mainnet', address: 'alice.near' }), { confirm: async (i) => { seen = i as never; return true } }, 'near:mainnet').sendTransaction(tx as never)
    expect(seen.destinationUnknown).toBe(true)
  })
})

describe('scan 2026-10-27 G6 (F6, F28, F29): NEAR object actions the kit cannot read as wallet-near encodes them are unknown', () => {
  const near = () => createMockAccount({ chain: 'near:mainnet', address: 'alice.near' })
  const allow = { allowlist: { near: ['usdt.tether-token.near', 'dex.near'] } }
  const confirmed = async (tx: unknown) => {
    let seen: Record<string, unknown> = {}
    await applyPolicies(near(), { confirm: async (i) => { seen = i as never; return true } }, 'near:mainnet').sendTransaction(tx as never)
    return seen
  }
  it('a non-string methodName (an array that ToString makes "ft_transfer")', async () => {
    const tx = { receiverId: 'usdt.tether-token.near', actions: [{ functionCall: { methodName: ['ft_transfer'], args: { receiver_id: 'attacker.near', amount: '1000000' }, gas: 1n, deposit: 1n } }] }
    await expect(applyPolicies(near(), allow, 'near:mainnet').sendTransaction(tx as never)).rejects.toMatchObject({ policy: 'allowlist' })
    expect((await confirmed(tx)).destinationUnknown).toBe(true)
  })
  it('an action object with two keys (deleteAccount next to a harmless functionCall)', async () => {
    const tx = { receiverId: 'usdt.tether-token.near', actions: [{ deleteAccount: { beneficiaryId: 'attacker.near' }, functionCall: { methodName: 'ft_balance_of', args: {}, gas: 1n, deposit: 0n } }] }
    await expect(applyPolicies(near(), allow, 'near:mainnet').sendTransaction(tx as never)).rejects.toMatchObject({ policy: 'allowlist' })
    expect((await confirmed(tx)).destinationUnknown).toBe(true)
  })
  it('storage_deposit with positional array args names a beneficiary: unknown, not "for the caller"', async () => {
    for (const args of [['attacker.near', false], JSON.stringify(['attacker.near', false]), new TextEncoder().encode('["attacker.near",false]')]) {
      const tx = { receiverId: 'dex.near', actions: [{ functionCall: { methodName: 'storage_deposit', args, gas: 1n, deposit: 10n ** 22n } }] }
      await expect(applyPolicies(near(), allow, 'near:mainnet').sendTransaction(tx as never)).rejects.toMatchObject({ policy: 'allowlist' })
      expect((await confirmed(tx)).destinationUnknown).toBe(true)
    }
    // Control: the documented object form without account_id deposits for the caller.
    expect((await confirmed({ receiverId: 'dex.near', actions: [{ functionCall: { methodName: 'storage_deposit', args: { registration_only: true }, gas: 1n, deposit: 1n } }] })).destinationUnknown).toBe(false)
  })
})

describe('scan 2026-10-27 G8 (F10, F17): Tron calls are judged by the selector bytes the node hashes, not the signature text', () => {
  const TRON = 'tron:0x2b6653dc'
  const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const ATTACKER = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9'
  const tron = () => createMockAccount({ chain: TRON, address: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH' })
  // A public 4byte.directory collision: keccak256 of this text starts with a9059cbb, transfer(address,uint256).
  const collision = { contractAddress: USDT, functionSelector: 'join_tg_invmru_haha_fd06787(address,bool)', parameters: [{ type: 'address', value: ATTACKER }, { type: 'bool', value: true }] }

  it('a colliding signature text is read as the transfer it signs: the blocklist sees the recipient', async () => {
    await expect(applyPolicies(tron(), { blocklist: { tron: [ATTACKER] } }, TRON).sendTransaction(collision as never)).rejects.toMatchObject({ policy: 'blocklist' })
    await expect(applyPolicies(tron(), { allowlist: { tron: [USDT] } }, TRON).sendTransaction(collision as never)).rejects.toMatchObject({ policy: 'allowlist' })
    let seen: Record<string, unknown> = {}
    await applyPolicies(tron(), { confirm: async (i) => { seen = i as never; return true } }, TRON).sendTransaction(collision as never)
    expect(seen).toMatchObject({ token: USDT, amount: 1n, destinationUnknown: false })
    expect(seen.destinations).toHaveLength(2) // the token contract and the recipient the calldata names
  })

  it('parameters that do not encode one strict word each are unknown', async () => {
    const shifted = { contractAddress: USDT, functionSelector: 'transfer(address,uint256)', parameters: [{ type: 'bytes32', value: '00'.repeat(32) + 'ff'.repeat(32) }, { type: 'uint256', value: 1n }] }
    let seen: Record<string, unknown> = {}
    await applyPolicies(tron(), { confirm: async (i) => { seen = i as never; return true } }, TRON).sendTransaction(shifted as never)
    expect(seen.destinationUnknown).toBe(true)
  })
})

/** A mock Tron account with signRaw (the kit guards it; the mock signs nothing). */
const tronSigner = (address: string) => Object.assign(createMockAccount({ chain: 'tron:0x2b6653dc', address }), { signRaw: async (tx: unknown) => tx })

describe('scan 2026-10-27 G9 (F26): the signRaw intent comes from the signed bytes, never the JSON copy', () => {
  it('a VoteWitnessContract whose JSON says "1 TRX to the merchant" shows no payment', async () => {
    const { encodeRawData } = await import('@anywalletkit/wallet-tron')
    const owner = '41' + '11'.repeat(20)
    const raw_data = { contract: [{ type: 'VoteWitnessContract', parameter: { value: { owner_address: owner }, type_url: 'type.googleapis.com/protocol.VoteWitnessContract' } }], ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: 1, timestamp: 1 }
    const hex = Array.from(encodeRawData(raw_data as never), (b) => b.toString(16).padStart(2, '0')).join('')
    const merchant = '41' + '22'.repeat(20)
    const lying = { txID: '00'.repeat(32), raw_data_hex: hex, raw_data: { ...raw_data, contract: [{ ...raw_data.contract[0], parameter: { ...raw_data.contract[0]!.parameter, value: { owner_address: owner, to_address: merchant, amount: 1_000_000 } } }] } }
    let seen: Record<string, unknown> = {}
    await applyPolicies(tronSigner(owner), { confirm: async (i) => { seen = i as never; return true } }, 'tron:0x2b6653dc').signRaw(lying)
    expect(seen.to).toBeUndefined()
    expect(seen.amount).toBeUndefined()
  })

  it('a TransferContract and a TRC-20 call read to / amount / token off raw_data_hex', async () => {
    const { encodeRawData } = await import('@anywalletkit/wallet-tron')
    const owner = '41' + '11'.repeat(20), to = '41' + '33'.repeat(20), usdt = '41' + 'a6'.repeat(20)
    const hexOf = (raw: unknown) => Array.from(encodeRawData(raw as never), (b) => b.toString(16).padStart(2, '0')).join('')
    const base = { ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: 1, timestamp: 1 }
    const trx = { ...base, contract: [{ type: 'TransferContract', parameter: { value: { owner_address: owner, to_address: to, amount: 2 ** 60 }, type_url: 'type.googleapis.com/protocol.TransferContract' } }] }
    let seen: Record<string, unknown> = {}
    const guarded = applyPolicies(tronSigner(owner), { confirm: async (i) => { seen = i as never; return true } }, 'tron:0x2b6653dc')
    // The JSON copy is omitted on purpose: only the bytes speak.
    await guarded.signRaw({ txID: '00'.repeat(32), raw_data_hex: hexOf(trx) })
    expect(seen).toMatchObject({ to, amount: 2n ** 60n })
    const data = 'a9059cbb' + to.slice(2).padStart(64, '0') + (10n ** 30n).toString(16).padStart(64, '0')
    const call = { ...base, contract: [{ type: 'TriggerSmartContract', parameter: { value: { owner_address: owner, contract_address: usdt, data }, type_url: 'type.googleapis.com/protocol.TriggerSmartContract' } }] }
    await guarded.signRaw({ txID: '00'.repeat(32), raw_data_hex: hexOf(call) })
    expect(seen).toMatchObject({ to: usdt, token: usdt, amount: 10n ** 30n })
  })
})

describe('scan 2026-10-27 G10 (F12): non-canonical EVM calldata is unknown', () => {
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const ATTACKER = '000000000000000000000000000000000000dead'
  const transferCalldata = 'a9059cbb' + ATTACKER.padStart(64, '0') + 'f'.repeat(64)
  it('1x / prefix-less / odd-length data is refused by an allowlist of the token and a blocklist without confirm', async () => {
    for (const data of ['1x' + transferCalldata, transferCalldata, '0x' + '95ea7b3' + ATTACKER.padStart(64, '0') + 'f'.repeat(64)]) {
      const tx = { to: USDC, chainId: 1, gasLimit: 100_000n, data }
      await expect(applyPolicies(createMockAccount({ chain: 'eip155:1' }), { allowlist: { 'eip155:1': [USDC] } }, 'eip155:1').signTransaction(tx)).rejects.toMatchObject({ policy: 'allowlist' })
      await expect(applyPolicies(createMockAccount({ chain: 'eip155:1' }), { blocklist: { 'eip155:1': ['0x' + '11'.repeat(20)] } }, 'eip155:1').signTransaction(tx)).rejects.toMatchObject({ policy: 'blocklist' })
    }
  })
})

describe('scan 2026-10-27 G11 (F30): a present but unreadable EVM chainId is refused', () => {
  it('an offline eip155:1 account with chainId "0b10001001" is refused (wallet-evm would sign for chain 137)', async () => {
    const offline = Object.assign(createMockAccount({ chain: 'eip155:unknown' }), { _config: {}, getChainId: async () => { throw new Error('no provider') } })
    const tx = { to: '0x' + '11'.repeat(20), chainId: '0b10001001', value: 1n, gasLimit: 21_000n }
    await expect(applyPolicies(offline, { allowlist: { 'eip155:1': ['0x' + '11'.repeat(20)] } }, 'eip155:1').signTransaction(tx)).rejects.toMatchObject({ policy: 'chain' })
    await expect(applyPolicies(offline, { confirm: async () => true }, 'eip155:1').signTransaction(tx)).rejects.toMatchObject({ policy: 'chain' })
  })
})

describe('scan 2026-10-27 G12 (F20): approve({ amount: 0 }) is a revoke only on a known ERC-20', () => {
  const NFT = '0x' + '77'.repeat(20)
  const DRAINER = '0x' + 'dd'.repeat(20)
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const evm = (getTokenInfo?: (t: string) => Promise<unknown>) => Object.assign(createMockAccount({ chain: 'eip155:1' }), { approve: async (o: unknown) => ({ hash: '0x1', fee: 0n, o }) }, getTokenInfo ? { getTokenInfo } : {})
  it('on an unknown token (an ERC-721) it is an approval of the spender: the blocklist and allowlist apply', async () => {
    const notToken = async () => { throw new Error('it has no decimals()') }
    await expect(applyPolicies(evm(notToken), { blocklist: { 'eip155:1': [DRAINER] } }, 'eip155:1').approve!({ token: NFT, spender: DRAINER, amount: 0n })).rejects.toMatchObject({ policy: 'blocklist' })
    await expect(applyPolicies(evm(), { allowlist: { 'eip155:1': [NFT] } }, 'eip155:1').approve!({ token: NFT, spender: DRAINER, amount: 0n })).rejects.toMatchObject({ policy: 'allowlist' })
    let seen: Record<string, unknown> = {}
    await applyPolicies(evm(notToken), { confirm: async (i) => { seen = i as never; return true } }, 'eip155:1').approve!({ token: NFT, spender: DRAINER, amount: 0n })
    expect(seen).toMatchObject({ kind: 'approval', to: DRAINER, amount: 0n })
  })
  it('on a catalogued ERC-20 (USDC), or one the account reads as ERC-20, it stays a revoke a blocklisted drainer cannot block', async () => {
    let seen: Record<string, unknown> = {}
    await applyPolicies(evm(), { blocklist: { 'eip155:1': [DRAINER] }, confirm: async (i) => { seen = i as never; return true } }, 'eip155:1').approve!({ token: USDC, spender: DRAINER, amount: 0n })
    expect(seen.kind).toBe('revoke')
    const custom = '0x' + 'cc'.repeat(20)
    await applyPolicies(evm(async () => ({ standard: 'erc20', decimals: 18 })), { blocklist: { 'eip155:1': [DRAINER] }, confirm: async (i) => { seen = i as never; return true } }, 'eip155:1').approve!({ token: custom, spender: DRAINER, amount: 0n })
    expect(seen.kind).toBe('revoke')
  })
})

describe('scan 2026-10-27 G13 (F13): a Stake instruction whose layout-deciding account is unresolved is unknown', () => {
  const STAKE = 'Stake11111111111111111111111111111111111111'
  const SA = 'BQcdHdAQW1hczDbBi9hiegXPR7MzRYNM4gYHBJLjHCkS'
  const ME = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
  const DRAINER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
  it('AuthorizeChecked with the Clock slot from a lookup table: the blocklisted new authority cannot hide behind the wallet', async () => {
    // The Clock account sits in a lookup table: no address here.
    const tx = { instructions: [{ programAddress: STAKE, accounts: [{ address: SA }, { lookupTableAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', addressIndex: 0 }, { address: ME }, { address: DRAINER }], data: Uint8Array.from([...u32(10), ...u32(1)]) }] }
    const sol = () => createMockAccount({ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: ME })
    await expect(applyPolicies(sol(), { blocklist: { solana: [DRAINER] } }, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp').sendTransaction(tx as never)).rejects.toMatchObject({ policy: 'blocklist' })
    await expect(applyPolicies(sol(), { allowlist: { solana: [ME, SA] } }, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp').sendTransaction(tx as never)).rejects.toMatchObject({ policy: 'allowlist' })
  })
})

describe('scan 2026-10-27 G13 (F19): a Zcash recipient that is not plain base58 is unknown', () => {
  const T1 = 't1Ju9gpPpCwUZgjiNnCMGxfyLL4TQLK8W5B'
  it('a blocklisted address padded with U+FEFF or a space is refused by the blocklist; case is not folded', async () => {
    for (const recipient of [T1 + '﻿', ' ' + T1, T1 + ' ']) {
      await expect(applyPolicies(createMockAccount({ chain: 'zcash:mainnet' }), { blocklist: { zcash: [T1] } }, 'zcash:mainnet').transfer({ recipient, amount: 1n })).rejects.toMatchObject({ policy: 'blocklist' })
    }
    await expect(applyPolicies(createMockAccount({ chain: 'zcash:mainnet' }), { blocklist: { zcash: [T1] } }, 'zcash:mainnet').transfer({ recipient: T1, amount: 1n })).rejects.toMatchObject({ policy: 'blocklist' })
    // base58 is case-sensitive: another case is another address, not the listed one.
    await expect(applyPolicies(createMockAccount({ chain: 'zcash:mainnet' }), { allowlist: { zcash: [T1] } }, 'zcash:mainnet').transfer({ recipient: T1.toLowerCase(), amount: 1n })).rejects.toMatchObject({ policy: 'allowlist' })
  })
})

describe('scan 2026-10-27 G14 (F24): EIP-712 primary-type inference is bounded', () => {
  it('20 000 types and 20 000 fields without primaryType are refused quickly', async () => {
    const types: Record<string, Array<{ name: string; type: string }>> = {}
    for (let i = 0; i < 20_000; i++) types[`T${i}`] = [{ name: 'f', type: `T${i + 1}` }]
    const t0 = performance.now()
    await expect(applyPolicies(Object.assign(createMockAccount(), { signTypedData: async (_typed: unknown) => '0x' }), { confirm: async () => true }, 'eip155:1').signTypedData!({ domain: {}, types, message: {} } as never)).rejects.toThrow(/types/)
    expect(performance.now() - t0).toBeLessThan(200)
  })
})
