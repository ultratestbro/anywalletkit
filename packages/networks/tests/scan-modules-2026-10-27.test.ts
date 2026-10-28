// Scan 2026-10-27 (modules), F37: isPrivateHost knew 127/8, 10/8, 172.16/12, 192.168/16 in dotted form only, so
// `https://127.1/`, `https://2130706433/`, `https://[::ffff:127.0.0.1]/`, 169.254.169.254 or 100.64/10 passed as public.
import { describe, expect, it } from 'vitest'
import { checkRpcUrl, isPrivateHost, isPublicHttpsUrl } from '../src/index.js'

describe('isPrivateHost: every spelling of a private address (scan 2026-10-27 modules, F37)', () => {
  it('IPv4 in the forms a URL parser accepts, and the ranges that were missing', () => {
    for (const h of ['127.1', '2130706433', '0x7f000001', '0x7f.0.0.1', '0177.0.0.1', '017700000001', '127.0.0.1.', '0', '0.0.0.0',
      '169.254.169.254', '100.64.0.1', '100.127.255.255', '192.0.0.8', '198.18.0.1', '224.0.0.1', '255.255.255.255', '10.1', '3232235777' /* 192.168.1.1 */,
      '1.2.3.0x1ff' /* not a valid IPv4: a URL parser fails it */, '1.256.0.0']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
    for (const h of ['8.8.8.8', '134744072' /* 8.8.8.8 */, '100.63.255.255', '100.128.0.0', '172.32.0.1', '192.0.1.1', '1.1.1.1']) expect(isPrivateHost(h), h).toBe(false)
  })

  it('IPv6: mapped, compatible and NAT64 addresses carry their IPv4; zones, multicast, expanded loopback', () => {
    for (const h of ['::1', '[::1]', '0:0:0:0:0:0:0:1', '::', '::ffff:127.0.0.1', '[::ffff:7f00:1]', '::ffff:192.168.1.1', '::127.0.0.1', '64:ff9b::a9fe:a9fe',
      'fe80::1', 'fe80::1%en0', 'fd12:3456::1', 'ff02::1', 'not:an:ipv6:::']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
    for (const h of ['2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808']) expect(isPrivateHost(h), h).toBe(false)
  })

  it('a host that is not printable ASCII is private: a URL parser maps it to ASCII (127.0.0.１, ｒｏｕｔｅｒ.ｌａｎ); 6to4 carries its IPv4', () => {
    for (const h of ['127.0.0.\uFF11', '127\u30020\u30020\u30021', '127.0.0.\u00AD1', '\uFF52\uFF4F\uFF55\uFF54\uFF45\uFF52.\uFF4C\uFF41\uFF4E', 'b\u00FCcher.example', '2002:7f00:1::', '2002:c0a8:101::1']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
    for (const u of ['https://127.0.0.\uFF11/', 'https://127\u30020\u30020\u30021/x', 'https://\uFF52\uFF4F\uFF55\uFF54\uFF45\uFF52.\uFF4C\uFF41\uFF4E/']) expect(isPublicHttpsUrl(u), u).toBe(false)
    // What a WHATWG URL parser does with them (Node): the reason the test above matters.
    expect(new URL('https://127.0.0.\uFF11/').hostname).toBe('127.0.0.1')
    for (const h of ['xn--bcher-kva.example', '2002:808:808::']) expect(isPrivateHost(h), h).toBe(false)
  })

  it('private names; public names stay public', () => {
    for (const h of ['localhost', 'LOCALHOST.', 'a.localhost', 'printer.local', 'db.internal', 'nas.home.arpa', 'router.lan']) expect(isPrivateHost(h), h).toBe(true)
    for (const h of ['example.com', 'eth.llamarpc.com', '123.com', 'lan.example', 'internal.example.org']) expect(isPrivateHost(h), h).toBe(false)
  })

  it('isPublicHttpsUrl: https, no credentials, no template in the host, a public host', () => {
    expect(isPublicHttpsUrl('https://gateway.example/{sender}/{data}.json')).toBe(true)
    for (const u of ['http://gateway.example/x', 'https://user:pw@gateway.example/', 'https://{data}.example/', 'https://192.168.1.1/x', 'https://127.1/', 'https://[::ffff:127.0.0.1]/', 'ftp://gateway.example/', 'gateway.example']) {
      expect(isPublicHttpsUrl(u), u).toBe(false)
    }
  })

  it('the RPC URL policy reads them as local too (http only behind the opt-in)', () => {
    expect(checkRpcUrl('http://100.64.0.1:8545')).toMatchObject({ ok: false, reason: 'http-not-allowed' })
    expect(checkRpcUrl('https://2130706433/')).toMatchObject({ ok: true, local: true })
    expect(checkRpcUrl('https://eth.llamarpc.com')).toMatchObject({ ok: true, local: false })
  })
})
