import { describe, expect, it } from 'vitest'
import { PAGE_TARGET, pageRequestFrom } from '../src/index.js'

// Audit 2026-10-25 round 3, H6: the content script stamped the site's origin on any message the
// window received, so an iframe's `parent.postMessage({ eth_sendTransaction })` reached the approval
// window as the site.
describe('pageRequestFrom', () => {
  const page = { location: { origin: 'https://dapp.example' } }
  const frame = { location: { origin: 'https://ads.example' } }
  const data = { target: PAGE_TARGET.toContent, id: 'r1', chain: 'eip155', method: 'eth_sendTransaction', params: [] }
  it('takes the page\'s own requests only', () => {
    expect(pageRequestFrom({ data, origin: 'https://dapp.example', source: page }, page)).toBe(data)
    // an iframe posting to its parent: another source, another origin
    expect(pageRequestFrom({ data, origin: 'https://ads.example', source: frame }, page)).toBeNull()
    // a same-origin frame is still not the page
    expect(pageRequestFrom({ data, origin: 'https://dapp.example', source: frame }, page)).toBeNull()
    // the page's window with another origin (a navigated-away document) is refused too
    expect(pageRequestFrom({ data, origin: 'https://evil.example', source: page }, page)).toBeNull()
    expect(pageRequestFrom({ data: { hello: 1 }, origin: 'https://dapp.example', source: page }, page)).toBeNull()
  })
})
