import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseActivityFixture, type ActivityFixtureJson } from '@anywalletkit/conformance'
import { encodeFunctionData, parseAbi, type Hex } from 'viem'
import { describeCurveLendingActivity } from '../src/index.js'
import { CRVUSD, OTHER, VAULT } from './fixture.js'

const load = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/activity/${name}.json`, import.meta.url)), 'utf8')) as ActivityFixtureJson
const APPROVE = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

describe('describeCurveLendingActivity', () => {
  it('a deposit made through another contract (smart wallet, multicall) is recognized by the shares minted to the wallet', () => {
    const { tx, own } = parseActivityFixture(load('ethereum-deposit-crvusd'))
    const wallet = '0x00000000000000000000000000000000000000Cc'
    const viaWallet = { ...tx, to: wallet, call: { to: wallet, selector: '0x1cff79cd', data: '0x1cff79cd' } }
    const item = describeCurveLendingActivity(viaWallet, { own })
    expect(item).toMatchObject({ kind: 'supply', title: 'Deposited crvUSD', counterparty: wallet, subtitle: 'Savings crvUSD · Ethereum' })
  })

  it('approve(scrvUSD, 0) on crvUSD is a revoke; an approve for another spender is not this module’s', () => {
    const { tx, own } = parseActivityFixture(load('ethereum-approve-crvusd'))
    const zero = encodeFunctionData({ abi: APPROVE, functionName: 'approve', args: [VAULT, 0n] })
    expect(describeCurveLendingActivity({ ...tx, call: { to: CRVUSD, selector: zero.slice(0, 10), data: zero } }, { own })).toMatchObject({ kind: 'revoke', title: 'Revoked crvUSD for Savings crvUSD' })
    const other = encodeFunctionData({ abi: APPROVE, functionName: 'approve', args: [OTHER, 5n] })
    expect(describeCurveLendingActivity({ ...tx, call: { to: CRVUSD, selector: other.slice(0, 10), data: other } }, { own })).toBeNull()
    expect(describeCurveLendingActivity({ ...tx, call: { to: CRVUSD, selector: '0x095ea7b3', data: '0x095ea7b3' as Hex } }, { own })).toBeNull()
  })

  it('the same vault call on another chain is not scrvUSD (bridged scrvUSD on L2s is a plain token)', () => {
    const { tx, own } = parseActivityFixture(load('ethereum-deposit-crvusd'))
    expect(describeCurveLendingActivity({ ...tx, chain: 'eip155:8453' }, { own })).toBeNull()
  })
})
