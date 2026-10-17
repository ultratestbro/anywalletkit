import { parseBig, parseInt10, type TokenRow, type TxRow } from './rows.js'

/**
 * JSON-RPC `eth_getTransactionByHash` / `eth_getTransactionReceipt` objects →
 * the normalized rows. Shared by the Etherscan `proxy` path and the Alchemy
 * backend (whose Transfers API has no fee / status / input of its own).
 */

type Row = Record<string, unknown>

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** `time` = unix seconds already known from elsewhere (transfer metadata, block); 0 when unknown. */
export function txRowFromRpc(tx: Row, receipt: Row | null | undefined, time: number): TxRow {
  const blockHex = (receipt?.['blockNumber'] ?? tx['blockNumber']) as string | null | undefined
  const status: TxRow['status'] = !receipt || !blockHex ? 'pending' : receipt['status'] === '0x0' ? 'failed' : 'confirmed'
  const row: TxRow = {
    hash: String(tx['hash']),
    block: blockHex ? parseInt10(blockHex) : 0,
    time,
    from: String(tx['from'] ?? ''),
    to: typeof tx['to'] === 'string' && tx['to'] ? (tx['to'] as string) : null,
    value: parseBig(tx['value']),
    input: typeof tx['input'] === 'string' && tx['input'] ? (tx['input'] as string) : '0x',
    status,
    raw: { tx, receipt: receipt ?? null },
  }
  if (receipt) {
    const gasUsed = parseBig(receipt['gasUsed'])
    const price = parseBig(receipt['effectiveGasPrice'] ?? tx['gasPrice'])
    if (gasUsed > 0n && price > 0n) row.fee = gasUsed * price
    if (typeof receipt['contractAddress'] === 'string' && receipt['contractAddress']) row.contractAddress = receipt['contractAddress'] as string
  }
  return row
}

/** ERC-20 `Transfer` logs (3 topics) of a receipt → token rows. 4-topic (ERC-721) transfers are skipped. */
export function parseReceiptTransfers(receipt: Row, tx: TxRow): TokenRow[] {
  const logs = Array.isArray(receipt['logs']) ? (receipt['logs'] as Row[]) : []
  const out: TokenRow[] = []
  for (const log of logs) {
    const topics = Array.isArray(log['topics']) ? (log['topics'] as string[]) : []
    if (topics.length !== 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue
    const data = typeof log['data'] === 'string' ? (log['data'] as string) : '0x'
    out.push({
      hash: tx.hash,
      block: tx.block,
      time: tx.time,
      from: topicAddress(topics[1]!),
      to: topicAddress(topics[2]!),
      token: String(log['address'] ?? '').toLowerCase(),
      amount: data.length > 2 ? parseBig(data) : 0n,
      raw: log,
    })
  }
  return out
}

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40).toLowerCase()}`
}
