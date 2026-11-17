import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { computeBalanceChanges, decodeTransaction, type BalanceChanges, type DecodedTransaction, type LookupTables } from '../src/index.js'

/** A confirmed mainnet transaction saved by `scripts/fetch-fixture.mjs`. */
export interface Fixture {
  signature: string
  slot: number
  version: 'legacy' | 0 | 1
  note?: string
  wire: string
  lookupTables: Record<string, (string | null)[]>
  meta: {
    err: unknown
    fee: string
    preBalances: string[]
    postBalances: string[]
    preTokenBalances: Array<{ accountIndex: number; mint: string; owner?: string; programId?: string; uiTokenAmount: { amount: string; decimals: number } }>
    postTokenBalances: Array<{ accountIndex: number; mint: string; owner?: string; programId?: string; uiTokenAmount: { amount: string; decimals: number } }>
    loadedAddresses: { writable: string[]; readonly: string[] }
    innerInstructions: unknown
    logMessages: string[] | null
  }
}

export function loadFixture(relative: string): Fixture {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${relative}`, import.meta.url)), 'utf8')) as Fixture
}

export function decodeFixture(f: Fixture, options: Parameters<typeof decodeTransaction>[1] = {}): DecodedTransaction {
  return decodeTransaction(f.wire, { lookupTables: f.lookupTables as LookupTables, ...options })
}

/** The account list the meta's balances refer to: static keys, then the loaded writable, then readonly addresses. */
export function metaAccountKeys(f: Fixture): string[] {
  const statics = decodeTransaction(f.wire).accounts.filter((a) => a.lookupTable === undefined).map((a) => a.address!)
  return [...statics, ...f.meta.loadedAddresses.writable, ...f.meta.loadedAddresses.readonly]
}

/** Balance changes of the confirmed transaction, computed from its meta (what an explorer shows). */
export function fixtureBalanceChanges(f: Fixture, signer?: string): BalanceChanges | null {
  return computeBalanceChanges(metaAccountKeys(f), { ...f.meta, preBalances: f.meta.preBalances.map(BigInt), postBalances: f.meta.postBalances.map(BigInt) }, signer ?? decodeTransaction(f.wire).feePayer)
}
