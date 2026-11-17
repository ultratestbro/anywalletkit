/**
 * @anywalletkit/tx-preview-solana in the Hermes VM: saved mainnet transactions (legacy, v0 with lookup tables, v1,
 * Token-2022 TransferCheckedWithFee, a memo) decoded and their balance changes computed, each result compared string
 * for string with Node's (pinned in the package's tests/hermes-expected.json). The memo is read with TextDecoder
 * removed, since the package reads memo text itself.
 */
import * as txPreviewSolana from '@anywalletkit/tx-preview-solana'
import { canonical, hermesCases } from '../../packages/tx-preview-solana/tests/hermes-cases.js'
import expected from '../../packages/tx-preview-solana/tests/hermes-expected.json'
import memo from '../../packages/tx-preview-solana/tests/fixtures/memo/memo-v2.json'

type Check = (what: string, ok: boolean, detail?: string) => void

export function smokeTxPreviewSolana(check: Check): void {
  const got = hermesCases(txPreviewSolana as never)
  const want = expected as Record<string, string>
  check('tx-preview-solana: same cases as Node', Object.keys(got).join('|') === Object.keys(want).join('|'), Object.keys(got).join('|'))
  for (const [name, value] of Object.entries(want)) {
    const mine = got[name]
    let at = 0
    if (mine !== value) while (at < value.length && mine?.[at] === value[at]) at++
    check(`tx-preview-solana: ${name}`, mine === value, mine === value ? undefined : `differs at ${at}: hermes …${mine?.slice(at, at + 80)}… node …${value.slice(at, at + 80)}…`)
  }
  // Memo text without TextDecoder (React Native's Hermes ships none; the smoke installs a polyfill, removed here).
  const g = globalThis as { TextDecoder?: unknown }
  const saved = g.TextDecoder
  delete g.TextDecoder
  try {
    const d = txPreviewSolana.decodeTransaction(memo.wire)
    check('tx-preview-solana: memo without TextDecoder', d.instructions[0]?.args.text === '7B1BB3214D2BF68D34932234E92503EFC162C7483A8BDCE4C96BB6B1861E5F72', canonical(d.instructions[0]))
  } finally {
    g.TextDecoder = saved
  }
}
