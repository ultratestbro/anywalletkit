import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_NETWORKS, classifySignRequest, describeSiwe, messageText, prepareTransaction, revealHidden, type EvmNetwork } from '../src/index.js'

// Extension audit 2026-11-09, group G2: E31 (bidi / invisible characters), E32 (cross-site SIWE), E49 (site gas limit).
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const OTHER = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'
const ETH = DEFAULT_NETWORKS[0]!
const NOW = Date.parse('2026-10-20T12:00:00Z')
const hex = (s: string) => `0x${Buffer.from(s, 'utf8').toString('hex')}`
const RLO = '\u202E'
const siwe = (o: { domain?: string; statement?: string } = {}) =>
  `${o.domain ?? 'app.uniswap.org'} wants you to sign in with your Ethereum account:\n${ME}\n\n${o.statement ?? 'Sign in to Uniswap'}\n\nURI: https://${o.domain ?? 'app.uniswap.org'}/login\nVersion: 1\nChain ID: 1\nNonce: k9Qz1bX2pL7m\nIssued At: 2026-10-20T11:59:00Z`
const classify = (method: string, params: unknown[], origin = 'https://app.uniswap.org') => classifySignRequest({ network: ETH, method, params, accounts: [ME], origin, now: NOW })

describe('E31: bidi and invisible characters are shown, not obeyed', () => {
  it('revealHidden escapes Cf / bidi / zero-width characters and says so', () => {
    expect(revealHidden(`pay ${RLO}gnp.exe`)).toEqual({ text: 'pay ⟨U+202E⟩gnp.exe', hidden: true })
    expect(revealHidden('a\u200Bb\u2066c\u2069\uFEFF')).toEqual({ text: 'a⟨U+200B⟩b⟨U+2066⟩c⟨U+2069⟩⟨U+FEFF⟩', hidden: true })
    expect(revealHidden('plain ünïcödé — ok\nline 2\ttab')).toEqual({ text: 'plain ünïcödé — ok\nline 2\ttab', hidden: false })
  })

  it('messageText never returns a raw RLO / isolate / zero-width character, hex or plain', () => {
    const text = messageText(hex(`Approve 10 USDC ${RLO}0001 :tnuomA`))
    expect(text).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/)
    expect(text).toContain('⟨U+202E⟩')
    expect(messageText(`ok\u200Dthen`)).toBe('ok⟨U+200D⟩then')
  })

  it('personal_sign: the sheet text is escaped and flagged; what is signed is unchanged', () => {
    const raw = hex(`Login ${RLO}evil`)
    const info = classify('personal_sign', [raw, ME])
    expect(info).toMatchObject({ kind: 'sign-message', text: 'Login ⟨U+202E⟩evil', raw, hiddenChars: true })
    expect(classify('personal_sign', [hex('hello'), ME])).not.toHaveProperty('hiddenChars')
  })

  it('typed data: string fields with bidi controls are escaped in the text and flagged', () => {
    const typed = { domain: { name: `Safe${RLO}`, chainId: 1 }, types: { M: [{ name: 'note', type: 'string' }] }, message: { note: `to ${RLO}evil` }, primaryType: 'M' }
    const info = classify('eth_signTypedData_v4', [ME, JSON.stringify(typed)])
    expect(info).toMatchObject({ kind: 'sign-typed-data', hiddenChars: true })
    expect((info as { text: string }).text).not.toContain(RLO)
    expect((info as unknown as { typedData: { message: { note: string } } }).typedData.message.note).toBe(`to ${RLO}evil`) // signed as given
  })

  it('a sign-in message with a bidi or zero-width character is refused', () => {
    expect(classify('personal_sign', [hex(siwe({ statement: `Sign in ${RLO}` })), ME])).toMatchObject({ code: -32602 })
    expect(classify('personal_sign', [hex(siwe({ statement: 'Sign\u200Bin' })), ME])).toMatchObject({ code: -32602 })
    expect(classify('personal_sign', [hex(siwe()), ME])).toMatchObject({ kind: 'sign-message' })
  })
})

describe('E32: a cross-site sign-in is reported as such', () => {
  it('describeSiwe names the domain and the asking origin when they differ', () => {
    const info = describeSiwe(siwe({ domain: 'app.victim.com' }), { origin: 'https://evil.example', account: ME, chainId: 1, now: NOW })!
    expect(info.crossSite).toEqual({ domain: 'app.victim.com', origin: 'https://evil.example' })
    expect(describeSiwe(siwe(), { origin: 'https://app.uniswap.org', account: ME, chainId: 1, now: NOW })!.crossSite).toBeUndefined()
  })

  it('classifySignRequest carries it to the sheet', () => {
    const info = classify('personal_sign', [hex(siwe({ domain: 'app.victim.com' })), ME], 'https://evil.example')
    expect(info).toMatchObject({ kind: 'sign-message', siwe: { crossSite: { domain: 'app.victim.com', origin: 'https://evil.example' } } })
  })
})

describe('E49: a site gas limit far above the estimate is flagged', () => {
  const rpc = (estimate: string | Error) => vi.fn(async (_n: EvmNetwork, method: string): Promise<unknown> => {
    switch (method) {
      case 'eth_getTransactionCount': return '0x1'
      case 'eth_getBlockByNumber': return { baseFeePerGas: '0x3b9aca00' }
      case 'eth_maxPriorityFeePerGas': return '0x0'
      case 'eth_estimateGas': if (estimate instanceof Error) throw estimate; return estimate
      default: throw new Error(`unexpected rpc ${method}`)
    }
  })
  const tx = (gas: string | null) => ({ to: OTHER, value: '0', data: '0xa9059cbb', gas })

  it('the page limit is kept, but the estimate rides along and an excessive one is marked', async () => {
    const p = await prepareTransaction({ rpc: rpc('0xc350') }, ETH, ME, tx('0x1000000')) // 16.7M vs 50k
    expect(p.gasLimit).toBe('0x1000000')
    expect(p.gasCheck).toEqual({ estimate: '0xc350', excessive: true })
  })

  it('a modest margin over the estimate is not excessive (max(estimate × 1.5, estimate + 50 000))', async () => {
    expect((await prepareTransaction({ rpc: rpc('0x5208') }, ETH, ME, tx('0x11558'))).gasCheck).toEqual({ estimate: '0x5208', excessive: false }) // 71000 = 21000 + 50000
    expect((await prepareTransaction({ rpc: rpc('0x5208') }, ETH, ME, tx('0x11559'))).gasCheck).toEqual({ estimate: '0x5208', excessive: true })
    expect((await prepareTransaction({ rpc: rpc('0x186a0') }, ETH, ME, tx('0x249f0'))).gasCheck).toEqual({ estimate: '0x186a0', excessive: false }) // 150000 = 100000 × 1.5
  })

  it('no estimate (it reverts) → no check, the page limit still prepared; no page limit → no check', async () => {
    const p = await prepareTransaction({ rpc: rpc(new Error('execution reverted')) }, ETH, ME, tx('0x30d40'))
    expect(p.gasLimit).toBe('0x30d40')
    expect(p.gasCheck).toBeUndefined()
    expect((await prepareTransaction({ rpc: rpc('0x5208') }, ETH, ME, tx(null))).gasCheck).toBeUndefined()
  })
})
