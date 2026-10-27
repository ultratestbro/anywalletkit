import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { encodeTransaction } from '@anywalletkit/wallet-near'
import { applyPolicies, type Policies, type WriteIntent } from '../src/index.js'

// Audit 2026-10-25 round 3, M1: recipients and spenders inside calldata were not destinations.
// With `blocklist: [DRAINER]`, `sendTransaction({ to: USDC, data: transfer(DRAINER, amt) })`
// passed because the destination was USDC; the same for transferFrom / approve /
// increaseAllowance / Permit2 approve, TRC-20 calls, NEAR ft_transfer / storage_deposit, TON
// jetton transfers and SPL transfers (whose recipient is the token account's owner). Each form:
// the blocklist catches the recipient, an allowlist without it refuses, one with it passes.

type Verdict = 'passed' | 'allowlist' | 'blocklist' | string
async function verdict(acc: object, chain: string, policies: Policies, tx: unknown, method = 'sendTransaction'): Promise<Verdict> {
  const g = applyPolicies(acc as never, policies, chain) as unknown as Record<string, (t: unknown) => Promise<unknown>>
  return g[method]!(tx).then(() => 'passed', (e: { policy?: string; message?: string }) => e.policy ?? String(e.message))
}
async function judge(chain: string, tx: unknown, o: { contract?: string; recipient: string; extra?: string[]; method?: string; account?: () => object }) {
  const acc = o.account ?? (() => Object.assign(createMockAccount({ chain }), { signRaw: async () => '0xsigned' }))
  const contract = o.contract !== undefined ? [o.contract] : []
  return {
    blocked: await verdict(acc(), chain, { blocklist: { [chain]: [o.recipient] } }, tx, o.method),
    outside: await verdict(acc(), chain, { allowlist: { [chain]: [...contract, ...(o.extra ?? [])] } }, tx, o.method),
    inside: await verdict(acc(), chain, { allowlist: { [chain]: [...contract, o.recipient, ...(o.extra ?? [])] } }, tx, o.method),
  }
}
const REFUSED = { blocked: 'blocklist', outside: 'allowlist', inside: 'passed' }
async function intentOf(chain: string, tx: unknown, account?: object): Promise<WriteIntent> {
  let seen: WriteIntent | undefined
  await applyPolicies((account ?? createMockAccount({ chain })) as ReturnType<typeof createMockAccount>, { confirm: (i) => { seen = i; return true } }, chain).sendTransaction(tx as never)
  return seen!
}

// ── EVM ──────────────────────────────────────────────────────────────────────

const TOKEN = `0x${'11'.repeat(20)}`
const RCPT = `0x${'22'.repeat(20)}`
const OTHER = `0x${'33'.repeat(20)}`
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const word = (v: string) => v.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const call = (selector: string, ...words: string[]) => selector + words.map(word).join('')

describe('EVM: the recipient or spender inside calldata is a destination', () => {
  const forms: Array<[string, Record<string, unknown>, string]> = [
    ['transfer', { to: TOKEN, data: call('0xa9059cbb', RCPT, '0x5') }, TOKEN],
    ['transferFrom', { to: TOKEN, data: call('0x23b872dd', OTHER, RCPT, '0x5') }, TOKEN],
    ['approve with native value (not read as an approval)', { to: TOKEN, data: call('0x095ea7b3', RCPT, '0x5'), value: 1n }, TOKEN],
    ['increaseAllowance', { to: TOKEN, data: call('0x39509351', RCPT, '0x5') }, TOKEN],
    ['Permit2 approve', { to: PERMIT2, data: call('0x87517c45', TOKEN, RCPT, '0x5', '0x0') }, PERMIT2],
    ['ERC-721 safeTransferFrom', { to: TOKEN, data: call('0x42842e0e', OTHER, RCPT, '0x1') }, TOKEN],
    ['ERC-1155 safeTransferFrom', { to: TOKEN, data: call('0xf242432a', OTHER, RCPT, '0x1', '0x1', '0xa0', '0x0') }, TOKEN],
    ['ERC-677 transferAndCall', { to: TOKEN, data: call('0x4000aea0', RCPT, '0x5', '0x60', '0x0') }, TOKEN],
    ['on-chain EIP-2612 permit', { to: TOKEN, data: call('0xd505accf', OTHER, RCPT, '0x5', '0x9', '0x1b', '0x1', '0x2') }, TOKEN],
    ['calldata as bytes', { to: TOKEN, data: Uint8Array.from(Buffer.from(call('0xa9059cbb', RCPT, '0x5').slice(2), 'hex')) }, TOKEN],
  ]
  for (const [name, tx, contract] of forms) {
    it(name, async () => {
      expect(await judge('eip155:1', tx, { contract, recipient: RCPT })).toEqual(REFUSED)
    })
  }

  it('a batch: every call\'s recipients', async () => {
    const batch = [{ to: OTHER, data: '0x' }, { to: TOKEN, data: call('0xa9059cbb', RCPT, '0x5') }]
    expect(await judge('eip155:1', batch, { contract: TOKEN, extra: [OTHER], recipient: RCPT })).toEqual(REFUSED)
  })

  it('the intent names the token and amount of an ERC-20 transfer, not the native value', async () => {
    const i = await intentOf('eip155:1', { to: TOKEN, data: call('0xa9059cbb', RCPT, '0x5'), value: 0n })
    expect(i).toMatchObject({ to: TOKEN, token: TOKEN, amount: 5n, destinations: [TOKEN, RCPT], destinationUnknown: false })
  })

  it('a known selector with missing words is unknown, not a call to the contract only', async () => {
    const short = { to: TOKEN, data: '0xa9059cbb' }
    expect(await intentOf('eip155:1', short)).toMatchObject({ destinationUnknown: true })
    expect(await verdict(createMockAccount(), 'eip155:1', { allowlist: { eip155: [TOKEN, RCPT] } }, short)).toBe('allowlist')
  })

  it('setApprovalForAll(…, false) and approve(0x0, id) name nobody new', async () => {
    const i = await intentOf('eip155:1', [{ to: TOKEN, data: call('0xa22cb465', RCPT, '0x0') }, { to: OTHER, data: '0x' }])
    expect(i.destinations).toEqual([TOKEN, OTHER])
  })
})

// ── Tron ─────────────────────────────────────────────────────────────────────

const T_TOKEN = `41${'11'.repeat(20)}`
const T_RCPT = `41${'22'.repeat(20)}`
const T_ME = `41${'44'.repeat(20)}`

function varint(n: number): number[] { const out: number[] = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b) } while (n > 0); return out }
const field = (num: number, bytes: number[]) => [...varint(num * 8 + 2), ...varint(bytes.length), ...bytes]
const hexBytes = (h: string) => Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'))

/** raw_data_hex of a TriggerSmartContract carrying `data`. */
function triggerRaw(contract: string, data: string): string {
  const trigger = [...field(1, hexBytes(T_ME)), ...field(2, hexBytes(contract)), ...field(4, hexBytes(data))]
  const any = [...field(1, Array.from(Buffer.from('type.googleapis.com/protocol.TriggerSmartContract'))), ...field(2, trigger)]
  const contractMsg = [...varint(1 * 8 + 0), ...varint(31), ...field(2, any)]
  return Buffer.from(field(11, contractMsg)).toString('hex')
}

describe('Tron: TRC-20 recipients', () => {
  it('a call with `parameters`', async () => {
    const tx = { contractAddress: T_TOKEN, functionSelector: 'transfer(address,uint256)', parameters: [{ type: 'address', value: T_RCPT }, { type: 'uint256', value: 5 }] }
    expect(await judge('tron:mainnet', tx, { contract: T_TOKEN, recipient: T_RCPT })).toEqual(REFUSED)
    expect(await intentOf('tron:mainnet', tx)).toMatchObject({ token: T_TOKEN, amount: 5n })
  })

  it('a recipient parameter that is not typed address is unknown', async () => {
    const tx = { contractAddress: T_TOKEN, functionSelector: 'transfer(address,uint256)', parameters: [{ type: 'uint256', value: `0x${'22'.repeat(20)}` }, { type: 'uint256', value: 5 }] }
    expect(await intentOf('tron:mainnet', tx)).toMatchObject({ destinationUnknown: true })
  })

  it('prebuilt: the call data inside raw_data_hex (sendTransaction and signRaw)', async () => {
    const tx = { txID: 'ab'.repeat(32), raw_data_hex: triggerRaw(T_TOKEN, call('0xa9059cbb', `0x${'22'.repeat(20)}`, '0x5')) }
    expect(await judge('tron:mainnet', tx, { contract: T_TOKEN, recipient: T_RCPT })).toEqual(REFUSED)
    expect(await judge('tron:mainnet', tx, { contract: T_TOKEN, recipient: T_RCPT, method: 'signRaw' })).toEqual(REFUSED)
  })
})

// ── NEAR ─────────────────────────────────────────────────────────────────────

const FT = 'usdt.tether-token.near'
const N_RCPT = 'drainer.near'

describe('NEAR: who a function call or action pays', () => {
  const fc = (methodName: string, args: unknown) => ({ functionCall: { methodName, args, gas: 30_000_000_000_000n, deposit: 1n } })
  const forms: Array<[string, Record<string, unknown>]> = [
    ['ft_transfer', { receiverId: FT, actions: [fc('ft_transfer', { receiver_id: N_RCPT, amount: '5' })] }],
    ['ft_transfer_call with byte args', { receiverId: FT, actions: [fc('ft_transfer_call', Uint8Array.from(Buffer.from(JSON.stringify({ receiver_id: N_RCPT, amount: '5', msg: '' }))))] }],
    ['nft_transfer with string args', { receiverId: FT, actions: [fc('nft_transfer', JSON.stringify({ receiver_id: N_RCPT, token_id: '1' }))] }],
    ['storage_deposit for another account', { receiverId: FT, actions: [fc('storage_deposit', { account_id: N_RCPT })] }],
    ['an args object whose toJSON names someone else', { receiverId: FT, actions: [fc('ft_transfer', { receiver_id: 'ok.near', amount: '5', toJSON: () => ({ receiver_id: N_RCPT, amount: '5' }) })] }],
  ]
  for (const [name, tx] of forms) {
    it(name, async () => {
      expect(await judge('near:mainnet', tx, { contract: FT, recipient: N_RCPT })).toEqual(REFUSED)
    })
  }

  it('deleteAccount: the beneficiary', async () => {
    expect(await judge('near:mainnet', { receiverId: 'me.near', actions: [{ deleteAccount: { beneficiaryId: N_RCPT } }] }, { contract: 'me.near', recipient: N_RCPT })).toEqual(REFUSED)
  })

  it('storage_deposit for oneself names nobody else; the intent of an ft_transfer has token and amount', async () => {
    expect((await intentOf('near:mainnet', { receiverId: FT, actions: [fc('storage_deposit', {})] })).destinations).toEqual([FT])
    expect(await intentOf('near:mainnet', { receiverId: FT, actions: [fc('ft_transfer', { receiver_id: N_RCPT, amount: '5' })] })).toMatchObject({ token: FT, amount: 5n })
  })

  it('base64 borsh: actions are read too', async () => {
    const bytes = encodeTransaction({
      signerId: 'me.near', publicKey: { keyType: 'ed25519', data: new Uint8Array(32) }, nonce: 1n, receiverId: FT, blockHash: new Uint8Array(32),
      actions: [{ transfer: { deposit: 1n } }, fc('ft_transfer', { receiver_id: N_RCPT, amount: '5' }) as never, { deleteAccount: { beneficiaryId: 'heir.near' } }],
    })
    const tx = Buffer.from(bytes).toString('base64')
    expect(await judge('near:mainnet', tx, { contract: FT, extra: ['heir.near'], recipient: N_RCPT })).toEqual(REFUSED)
    expect((await intentOf('near:mainnet', tx)).destinations).toEqual([FT, N_RCPT, 'heir.near'])
  })
})

// ── TON ──────────────────────────────────────────────────────────────────────

const JETTON_WALLET = `0:${'cc'.repeat(32)}`
const DEST = `0:${'83'.repeat(32)}`
const SELF = `0:${'aa'.repeat(32)}`
// Bodies built with @ton/core (beginCell): jetton transfer to DEST with excess to SELF, an NFT
// transfer to DEST, a burn with excess to DEST, a text comment.
const JETTON_BOC = 'te6cckEBAQEAVQAApg+KfqUAAAAAAAAAACA+iAEHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqoIC2IAPFQ=='
const NFT_BOC = 'te6cckEBAQEAMQAAXV/MPRQAAAAAAAAAAIAQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcGAQruQXvg=='
const BURN_BOC = 'te6cckEBAQEAMQAAXVlfB7wAAAAAAAAAABBYAQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHSCeEKg=='
const COMMENT_BOC = 'te6cckEBAQEACAAADAAAAABoaeh7Muk='

/** A Cell-shaped body (what @ton/core hands over: `bits.length`, `bits.at(i)`, `refs`, `hash()`, `toBoc()`), built bit by bit here. */
function cell(...parts: Array<[bigint, number]>) {
  const bits: boolean[] = []
  for (const [v, n] of parts) for (let k = n - 1; k >= 0; k--) bits.push(((v >> BigInt(k)) & 1n) === 1n)
  return { bits: { length: bits.length, at: (i: number) => bits[i]! }, refs: [], hash: () => new Uint8Array(32), toBoc: () => new Uint8Array(0) }
}
const std = (raw: string): Array<[bigint, number]> => [[0b100n, 3], [0n, 8], [BigInt(`0x${raw.split(':')[1]}`), 256]]

describe('TON: a body pays its jetton / NFT destination and excess receiver', () => {
  it('jetton transfer as bodyBoc', async () => {
    const tx = { to: JETTON_WALLET, value: 50_000_000n, bodyBoc: JETTON_BOC }
    expect(await judge('ton:mainnet', tx, { contract: JETTON_WALLET, extra: [SELF], recipient: DEST })).toEqual(REFUSED)
    expect((await intentOf('ton:mainnet', tx)).destinations).toEqual([JETTON_WALLET, DEST, SELF])
  })

  it('jetton transfer as a Cell, in a batch', async () => {
    const body = cell([0x0f8a7ea5n, 32], [0n, 64], [2n, 4], [1000n, 16], ...std(DEST), [0n, 2])
    const tx = [{ to: SELF, value: 1n }, { to: JETTON_WALLET, value: 50_000_000n, body }]
    expect(await judge('ton:mainnet', tx, { contract: JETTON_WALLET, extra: [SELF], recipient: DEST })).toEqual(REFUSED)
  })

  it('NFT transfer and burn', async () => {
    expect(await judge('ton:mainnet', { to: JETTON_WALLET, value: 1n, bodyBoc: NFT_BOC }, { contract: JETTON_WALLET, recipient: DEST })).toEqual(REFUSED)
    expect(await judge('ton:mainnet', { to: JETTON_WALLET, value: 1n, bodyBoc: BURN_BOC }, { contract: JETTON_WALLET, recipient: DEST })).toEqual(REFUSED)
  })

  it('a comment pays nobody else; a body that cannot be read is unknown', async () => {
    expect((await intentOf('ton:mainnet', { to: DEST, value: 1n, bodyBoc: COMMENT_BOC })).destinations).toEqual([DEST])
    expect((await intentOf('ton:mainnet', { to: DEST, value: 1n, body: 'hello' })).destinationUnknown).toBe(false)
    expect((await intentOf('ton:mainnet', { to: DEST, value: 1n, bodyBoc: 'not a boc' })).destinationUnknown).toBe(true)
    expect((await intentOf('ton:mainnet', { to: DEST, value: 1n, body: { some: 'object' } })).destinationUnknown).toBe(true)
  })
})

// ── Solana: SPL transfers pay the token account's owner ─────────────────────

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ME = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const MY_TA = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'
const DEST_TA = 'BQcdHdAQW1hczDbBi9hiegXPR7MzRYNM4gYHBJLjHCkS'
const S_RCPT = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'

const accs = (...a: string[]) => a.map((address) => ({ address }))
const transfer = { programAddress: TOKEN_PROGRAM, accounts: accs(MY_TA, DEST_TA, ME), data: Uint8Array.from([3, 5, 0, 0, 0, 0, 0, 0, 0]) }
const transferChecked = { programAddress: TOKEN_PROGRAM, accounts: accs(MY_TA, MINT, DEST_TA, ME), data: Uint8Array.from([12, 5, 0, 0, 0, 0, 0, 0, 0, 6]) }
function solAccount(owners: Record<string, string> | 'throws' | 'none') {
  const acc = createMockAccount({ chain: 'solana:mainnet', address: ME })
  if (owners === 'none') return acc
  return Object.assign(acc, { getTokenAccountOwner: vi.fn(async (a: string) => { if (owners === 'throws') throw new Error('rpc down'); return owners[a] }) })
}

describe('Solana: an SPL transfer pays the owner of the token account', () => {
  for (const [name, ix] of [['Transfer', transfer], ['TransferChecked', transferChecked]] as const) {
    it(`${name}: the owner, read through the account`, async () => {
      expect(await judge('solana:mainnet', { instructions: [ix] }, { recipient: S_RCPT, account: () => solAccount({ [DEST_TA]: S_RCPT }) })).toEqual(REFUSED)
    })
  }

  it('an associated token account the transaction creates: its owner, no network read', async () => {
    const create = { programAddress: ATA, accounts: accs(ME, DEST_TA, S_RCPT, MINT, '11111111111111111111111111111111', TOKEN_PROGRAM), data: Uint8Array.from([1]) }
    const tx = { instructions: [create, transferChecked] }
    expect(await judge('solana:mainnet', tx, { recipient: S_RCPT, account: () => solAccount('none') })).toEqual(REFUSED)
  })

  it('an owner that cannot be read is unknown: allowlist refuses, blocklist without confirm refuses, confirm sees it', async () => {
    for (const mode of ['none', 'throws'] as const) {
      const tx = { instructions: [transferChecked] }
      expect(await verdict(solAccount(mode), 'solana:mainnet', { allowlist: { solana: [S_RCPT, DEST_TA] } }, tx)).toBe('allowlist')
      expect(await verdict(solAccount(mode), 'solana:mainnet', { blocklist: { solana: [OTHER] } }, tx)).toBe('blocklist')
      const i = await intentOf('solana:mainnet', tx, solAccount(mode))
      expect(i).toMatchObject({ destinations: [DEST_TA], destinationUnknown: true })
    }
  })

  it('no list and no confirm: no network read at all', async () => {
    const acc = solAccount({ [DEST_TA]: S_RCPT })
    await applyPolicies(acc, { maxFee: { solana: 10n ** 9n } }, 'solana:mainnet').sendTransaction({ instructions: [transferChecked] } as never)
    expect((acc as unknown as { getTokenAccountOwner: ReturnType<typeof vi.fn> }).getTokenAccountOwner).not.toHaveBeenCalled()
  })
})
