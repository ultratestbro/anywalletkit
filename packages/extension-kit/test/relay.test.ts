import { describe, expect, it } from 'vitest'
import { PAGE_TARGET, checkSenderOrigin, isPageEvent, isPageRequest, isPageResponse, isRelayRequest, isRelayToContent, newRequestId, stampOrigin } from '../src/index.js'

describe('relay messages', () => {
  it('guards accept well-formed messages and reject the rest', () => {
    const req = { target: PAGE_TARGET.toContent, id: newRequestId(), chain: 'eip155', method: 'eth_requestAccounts', params: [] }
    expect(isPageRequest(req)).toBe(true)
    expect(isPageRequest({ ...req, chain: 'cosmos' })).toBe(false)
    expect(isPageRequest({ ...req, id: '' })).toBe(false)
    expect(isPageRequest({ ...req, target: PAGE_TARGET.toPage })).toBe(false)
    expect(isPageRequest(null)).toBe(false)
    expect(isPageResponse({ target: PAGE_TARGET.toPage, id: 'x', result: 1 })).toBe(true)
    expect(isPageEvent({ target: PAGE_TARGET.toPage, chain: 'solana', event: 'connect' })).toBe(true)
    expect(isPageEvent({ target: PAGE_TARGET.toPage, id: 'x', chain: 'solana', event: 'connect' })).toBe(false)
    expect(isRelayToContent({ kind: 'response', id: 'x', error: { code: 4001, message: 'no' } })).toBe(true)
    expect(isRelayToContent({ kind: 'event', event: 'chainChanged', data: '0x1' })).toBe(true)
    expect(isRelayToContent({ kind: 'request' })).toBe(false)
  })

  it('the content script stamps the origin; a page-supplied origin is never carried over', () => {
    const page = { target: PAGE_TARGET.toContent, id: 'r1', chain: 'eip155', method: 'eth_chainId', origin: 'https://evil.example' } as never
    const stamped = stampOrigin(page, 'https://app.example')
    expect(stamped).toEqual({ kind: 'request', id: 'r1', origin: 'https://app.example', chain: 'eip155', method: 'eth_chainId' })
    expect(isRelayRequest(stamped)).toBe(true)
    expect(isRelayRequest({ ...stamped, origin: 1 })).toBe(false)
  })

  it('the service worker trusts port.sender over the stamp', () => {
    expect(checkSenderOrigin({ origin: 'https://app.example', tab: { id: 1 } }, 'https://app.example')).toBe('https://app.example')
    expect(checkSenderOrigin({ url: 'https://app.example/path?q=1' }, 'https://app.example')).toBe('https://app.example')
    expect(checkSenderOrigin({ origin: 'https://app.example' }, 'https://other.example')).toBeNull()
    expect(checkSenderOrigin({ origin: 'null' }, 'null')).toBeNull()
    expect(checkSenderOrigin(undefined, 'https://app.example')).toBeNull()
    expect(checkSenderOrigin({ url: 'not a url' }, 'https://app.example')).toBeNull()
  })
})
