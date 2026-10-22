import { describe, expect, it } from 'vitest'
import { PhishingDetector, hostOf, levenshtein } from '../src/index.js'

const list = { version: 2, tolerance: 1, blacklist: ['evil.example', 'uniswap-airdrop.xyz', 'metamask.io.phish.net'], whitelist: ['app.uniswap.org', 'metamask.io'], fuzzylist: ['app.uniswap.org', 'metamask.io', 'opensea.io'] }

describe('PhishingDetector', () => {
  const d = new PhishingDetector(list)
  it('blocks listed hosts and their subdomains, never the parent TLD; whitelisted hosts are clean', () => {
    expect(d.size).toBe(3)
    expect(d.check('https://evil.example/path').blocked).toBe(true)
    expect(d.check('login.evil.example').blocked).toBe(true)
    expect(d.check('example').blocked).toBe(false)
    expect(d.check('https://app.uniswap.org')).toEqual({ host: 'app.uniswap.org', blocked: false, warnings: [] })
    expect(d.check('https://metamask.io').warnings).toEqual([])
    expect(d.check('https://sub.metamask.io').blocked).toBe(false)
    expect(d.check('metamask.io.phish.net').blocked).toBe(true)
  })

  it('warns on lookalikes within the tolerance and on punycode; distinct hosts are clean', () => {
    expect(d.check('https://app.uniswep.org').warnings).toEqual(['The address looks like app.uniswap.org but is not that site.'])
    expect(d.check('https://metamask.co').warnings).toEqual(['The address looks like metamask.io but is not that site.']) // same name, other TLD
    expect(d.check('https://www.opensea.io').warnings).toEqual([]) // www. of the real site
    expect(d.check('https://xn--metamsk-9bb.io').warnings[0]).toMatch(/punycode/)
    expect(d.check('https://github.com').warnings).toEqual([])
    expect(d.check('https://openseas.io').warnings).toEqual(['The address looks like opensea.io but is not that site.'])
    expect(d.check('https://totally-different.io').warnings).toEqual([])
  })

  it('helpers', () => {
    expect(hostOf('https://App.Example.COM:8443/x')).toBe('app.example.com')
    expect(hostOf('App.Example.com.')).toBe('app.example.com')
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('', 'ab')).toBe(2)
    expect(d.check('').blocked).toBe(false)
  })
})
