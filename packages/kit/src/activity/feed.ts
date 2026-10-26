/**
 * The activity feed: every registered chain's history, merged newest-first, each
 * row described by the first protocol module that recognizes it (then the generic
 * fallback), folded with the app's intent journal (pending rows, inherited kinds,
 * cross-chain joins). Pure over its inputs: the kit hands it sources, recognizers
 * and the journal; tests hand it fakes.
 */
import type { ActivityAsset, ActivityItem, ChainTx, ChainTxStatus, DescribeActivityContext, HistoryQuery, HistorySource } from '@anywalletkit/core'
import { packCursor, sourceKey, unpackCursor, type FeedCursorState, type SourceState } from './cursor.js'
import { catalogChain, describeGeneric, isSpamTx, titleFor, type GenericActivityItem, type GenericDescribeOptions } from './generic.js'
import type { Intent, IntentJournal } from './journal.js'

/** A protocol module as the feed sees it: a name for error reports and the pure `describeActivity`. */
export interface ActivityRecognizer {
  /** Module name, used in error reports. */
  name: string
  /**
   * The module's `describeActivity`: an item when the module recognizes the transaction, `null`
   * otherwise. Must be pure.
   */
  describe(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null
}

/** One isolated failure while building a feed page. The rest of the page is still returned. */
export interface ActivityErrorReport {
  /** Where it failed: reading a history source, a recognizer that threw, or the intent journal. */
  stage: 'source' | 'recognizer' | 'journal'
  /** Chain of the failing source, when it was a source. */
  chain?: string
  /** Address of the failing source, when it was a source. */
  address?: string
  /** Recognizer name (registered protocol name) for `recognizer` failures. */
  module?: string
  /** What was thrown. */
  error: unknown
}

/** Options for the activity feed, set once with `WalletOptions.activity`. */
export interface ActivityOptions extends GenericDescribeOptions {
  /** Called for every isolated failure (a source that errored, a recognizer that threw, a journal write that failed). Failures also ride in `HistoryFeedPage.errors`. */
  onError?: (report: ActivityErrorReport) => void
  /** Seconds a pending intent may wait for its row before it is marked failed. Default 86 400 (24 h). */
  pendingTtl?: number
  /** Clock in unix seconds (tests). */
  now?: () => number
  /** Empty pages with a cursor (block-window sources) followed per source per call. Default 3. */
  maxEmptyHops?: number
}

/** One (chain, address) pair the feed reads history for. */
export interface FeedAddress { chain: string; address: string }

/**
 * Query for `wallet.history()`: which addresses and chains, the page size and the cursor from the
 * previous page.
 */
export interface HistoryFeedQuery {
  /** Which (chain, address) pairs to read. Default: account `index` on every chain with a history source. */
  addresses?: FeedAddress[]
  /** Account index resolved on every chain when `addresses` is omitted. Default 0. */
  index?: number
  /** Restrict to these CAIP-2 chains. */
  chains?: string[]
  /** Cursor from the previous page. */
  cursor?: string
  /** Items per page (default 20). */
  limit?: number
  /** Show rows the source flagged as spam. Default false. */
  includeSpam?: boolean
  /** Only transactions newer than this unix time (refresh). */
  since?: number
}

/** An activity item as the feed emits it. */
export interface FeedItem extends GenericActivityItem {
  /** Journal intent this row belongs to. */
  intentId?: string
}

/** One page of the activity feed, newest first. */
export interface HistoryFeedPage {
  /** Rows of this page, newest first, with readable titles. */
  items: FeedItem[]
  /** Pass back to get the next (older) page; absent when every source is exhausted. */
  cursor?: string
  /** Isolated failures of this call; the affected source keeps its position and is retried next call. */
  errors?: ActivityErrorReport[]
}

/**
 * @internal Everything {@link buildFeed} reads; the kit assembles it from the wallet's
 * registrations.
 */
export interface FeedInput {
  sources: ReadonlyMap<string, HistorySource>
  addresses: FeedAddress[]
  recognizers: readonly ActivityRecognizer[]
  journal?: IntentJournal
  query: HistoryFeedQuery
  opts: ActivityOptions
}

const DEFAULT_LIMIT = 20
const DEFAULT_PENDING_TTL = 86_400
const DEFAULT_EMPTY_HOPS = 3

const ownSetFor = (addresses: Iterable<string>): Set<string> => {
  const s = new Set<string>()
  for (const a of addresses) { s.add(a); if (a.startsWith('0x')) s.add(a.toLowerCase()) }
  return s
}

const txKey = (chain: string, hash: string): string => `${chain}:${hash}`
/**
 * Key for matching an intent leg to a chain row. Sources may name a chain by
 * genesis hash (bip122:… for Bitcoin) while the app journals the catalog id
 * (bitcoin:mainnet); both collapse to the catalog id here. Item ids keep the
 * source's own chain string (cached rows must not change id).
 */
const matchKey = (chain: string, hash: string): string => `${catalogChain(chain)}:${hash}`

/** Run the recognizers in order (first non-null wins, a throw is isolated) and fall back to the generic description. */
export function describeWithRecognizers(tx: ChainTx, own: Set<string>, recognizers: readonly ActivityRecognizer[], opts: ActivityOptions, report?: (r: ActivityErrorReport) => void): FeedItem {
  const ctx: DescribeActivityContext = { own: new Set([...own, ...ownSetFor([tx.address])]) }
  for (const r of recognizers) {
    try {
      const item = r.describe(tx, ctx)
      if (item) {
        const out = { ...item } as FeedItem
        if (isSpamTx(tx) && out.spam === undefined) out.spam = true
        if (out.explorerUrl === undefined) {
          const url = opts.explorerUrl?.(tx.chain, tx.hash)
          if (url !== undefined) out.explorerUrl = url
        }
        return out
      }
    } catch (error) {
      report?.({ stage: 'recognizer', chain: tx.chain, module: r.name, error })
    }
  }
  return describeGeneric(tx, ctx, opts)
}

const dedupeLegs = (legs: Array<{ chain: string; hash: string }>, except: { chain: string; hash: string }): Array<{ chain: string; hash: string }> => {
  const seen = new Set<string>([txKey(except.chain, except.hash)])
  const out: Array<{ chain: string; hash: string }> = []
  for (const l of legs) { const k = txKey(l.chain, l.hash); if (!seen.has(k)) { seen.add(k); out.push(l) } }
  return out
}

/** Fold an intent into the item for one of its hashes: generic items inherit kind / protocol / subtitle / expected assets; every item learns its other legs. */
export function applyIntent(item: FeedItem, intent: Intent, opts: GenericDescribeOptions = {}): FeedItem {
  const out: FeedItem = { ...item, intentId: intent.id }
  if (item.protocol === undefined) {
    out.kind = intent.kind
    if (intent.protocol !== undefined) out.protocol = intent.protocol
    if (intent.subtitle !== undefined) out.subtitle = intent.subtitle
    if (out.assetsOut.length === 0 && intent.expect) out.assetsOut = intent.expect.assetsOut
    if (out.assetsIn.length === 0 && intent.expect) out.assetsIn = intent.expect.assetsIn
    out.title = titleFor(out.kind, out.chain, out.assetsOut, out.assetsIn, opts)
  }
  const related = dedupeLegs([...(item.related ?? []), ...intent.hashes, ...(intent.related ?? [])], item)
  if (related.length > 0) out.related = related
  return out
}

/** The feed row for an intent that has no on-chain row (yet): `status` pending or failed, id `intent:<id>`. */
export function intentItem(intent: Intent, status: ChainTxStatus, opts: GenericDescribeOptions = {}): FeedItem {
  const assetsOut = intent.expect?.assetsOut ?? []
  const assetsIn = intent.expect?.assetsIn ?? []
  const first = intent.hashes[0]
  const item: FeedItem = {
    id: `intent:${intent.id}`, chain: intent.chain, hash: first?.hash ?? '', time: intent.createdAt, status, kind: intent.kind,
    title: titleFor(intent.kind, intent.chain, assetsOut, assetsIn, opts), assetsOut, assetsIn, intentId: intent.id,
  }
  if (intent.protocol !== undefined) item.protocol = intent.protocol
  if (intent.subtitle !== undefined) item.subtitle = intent.subtitle
  const related = dedupeLegs([...intent.hashes, ...(intent.related ?? [])], { chain: intent.chain, hash: first?.hash ?? '' })
  if (related.length > 0) item.related = related
  return item
}

interface Candidate {
  item: FeedItem
  tx?: ChainTx
  /** Positions in fetched pages this row occupies (several when two own addresses on one chain saw the same tx). */
  refs: Array<{ key: string; index: number }>
  /** Dropped from the output (second leg of a joined cross-chain intent) but still consumed when passed. */
  suppressed?: boolean
}

interface Fetched {
  key: string
  chain: string
  address: string
  rows: ChainTx[]
  /** Cursor the rows' page was fetched with, and how many of its head rows were skipped. */
  pageCursor?: string
  skip: number
  next?: string
  failed: boolean
  /** State to carry when the source failed (unchanged). */
  prior: SourceState
  /** Indexes of rows another fetched source owns (sent from that source's address): consumed here, shown there. */
  silent?: Set<number>
}

const byTimeDesc = (a: { time: number; chain: string; hash: string }, b: { time: number; chain: string; hash: string }): number =>
  b.time - a.time || (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)

const unionAssets = (lists: ActivityAsset[][]): ActivityAsset[] => {
  const out: ActivityAsset[] = []
  for (const l of lists) for (const a of l) if (!out.some((x) => x.token === a.token)) out.push(a)
  return out
}

/** One page of the merged feed. */
export async function buildFeed(input: FeedInput): Promise<HistoryFeedPage> {
  const { sources, recognizers, journal, query } = input
  const opts: ActivityOptions = { ...input.opts, explorerUrl: input.opts.explorerUrl ?? ((chain, hash) => sources.get(chain)?.explorerTxUrl(hash)) }
  const errors: ActivityErrorReport[] = []
  const report = (r: ActivityErrorReport) => { errors.push(r); opts.onError?.(r) }
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const limit = Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT))
  const state = unpackCursor(query.cursor)
  const firstPage = state === undefined
  const maxHops = opts.maxEmptyHops ?? DEFAULT_EMPTY_HOPS

  // 1. Targets: (chain, address) pairs with a source, restricted by `chains`, and on later pages to sources the cursor still carries.
  const chainFilter = query.chains ? new Set(query.chains) : undefined
  const targets = input.addresses.filter((a) => sources.has(a.chain) && (!chainFilter || chainFilter.has(a.chain)) && (state === undefined || state[sourceKey(a.chain, a.address)] !== undefined))
  const ownByChain = new Map<string, Set<string>>()
  for (const a of input.addresses) ownByChain.set(a.chain, ownSetFor([...(ownByChain.get(a.chain) ?? []), a.address]))
  const ownOn = (chain: string) => ownByChain.get(chain) ?? new Set<string>()

  // 2. Fetch one page per target, following empty-but-unfinished pages a few hops.
  const fetched: Fetched[] = await Promise.all(targets.map(async (t): Promise<Fetched> => {
    const key = sourceKey(t.chain, t.address)
    const prior: SourceState = state?.[key] ?? { n: 0 }
    const source = sources.get(t.chain)!
    let cursor = prior.c, skip = prior.n, hops = 0
    try {
      for (;;) {
        const q: HistoryQuery = { limit }
        if (cursor !== undefined) q.cursor = cursor
        if (query.since !== undefined) q.since = query.since
        const page = await source.listActivity(t.address, q)
        // The last row this page gave before: skip through it (the page may have shifted since).
        if (prior.l !== undefined && hops === 0 && cursor === prior.c) {
          const at = page.items.findIndex((r) => txKey(r.chain, r.hash) === prior.l)
          if (at >= 0) skip = at + 1
        }
        const rows = page.items.slice(skip)
        if (rows.length === 0 && page.cursor !== undefined && hops < maxHops) { cursor = page.cursor; skip = 0; hops++; continue }
        const out: Fetched = { key, chain: t.chain, address: t.address, rows, skip, failed: false, prior }
        if (cursor !== undefined) out.pageCursor = cursor
        if (page.cursor !== undefined) out.next = page.cursor
        return out
      }
    } catch (error) {
      report({ stage: 'source', chain: t.chain, address: t.address, error })
      return { key, chain: t.chain, address: t.address, rows: [], skip, failed: true, prior }
    }
  }))

  // 3. Describe every row once (two own addresses on a chain may both see one tx). A transaction
  //    sent from another own address this feed also reads is that address's row: its history always
  //    lists it, so here it is consumed silently (on another page it would otherwise show twice).
  const norm = (chain: string, a: string) => (chain.startsWith('eip155:') ? a.toLowerCase() : a)
  const senderSource = new Map(fetched.map((f) => [`${f.chain}|${norm(f.chain, f.address)}`, f.key]))
  const candidates = new Map<string, Candidate>()
  for (const f of fetched) {
    f.rows.forEach((tx, index) => {
      const owner = tx.from !== undefined ? senderSource.get(`${tx.chain}|${norm(tx.chain, tx.from)}`) : undefined
      if (owner !== undefined && owner !== f.key) { (f.silent ??= new Set()).add(index); return }
      const id = txKey(tx.chain, tx.hash)
      const existing = candidates.get(id)
      if (existing) { existing.refs.push({ key: f.key, index }); return }
      const item = describeWithRecognizers(tx, ownOn(tx.chain), recognizers, opts, report)
      candidates.set(id, { item, tx, refs: [{ key: f.key, index }] })
    })
  }

  // 4. Intents: inherit, look up missing rows, emit pending / failed ones on the first page.
  const top: FeedItem[] = []
  const journalWrites: Intent[] = []
  if (journal) {
    let intents: Intent[] = []
    try { intents = await journal.list() } catch (error) { report({ stage: 'journal', error }) }
    const byHash = new Map<string, Intent>()
    for (const i of intents) for (const h of i.hashes) byHash.set(matchKey(h.chain, h.hash), i)
    // Every leg's status is gathered first and the intent settles once (any failed leg → failed,
    // else any confirmed → confirmed): legs settling one by one wrote both values on every call, so
    // a two-leg intent with one failed leg flipped between confirmed and failed (round 3, L24).
    const legs = new Map<string, { intent: Intent; failed: boolean; confirmed: boolean }>()
    const settle = (intent: Intent, status: ChainTxStatus) => {
      const s = legs.get(intent.id) ?? { intent, failed: false, confirmed: false }
      if (status === 'failed') s.failed = true
      else if (status === 'confirmed') s.confirmed = true
      legs.set(intent.id, s)
    }
    const candidateByMatch = new Map<string, Candidate>()
    for (const c of candidates.values()) candidateByMatch.set(matchKey(c.item.chain, c.item.hash), c)
    for (const c of candidates.values()) {
      const intent = byHash.get(matchKey(c.item.chain, c.item.hash))
      if (!intent) continue
      c.item = applyIntent(c.item, intent, opts)
      settle(intent, c.item.status)
    }
    if (firstPage) {
      const unmatched = intents.filter((i) => i.status !== 'confirmed' && !i.hashes.some((h) => candidateByMatch.has(matchKey(h.chain, h.hash))))
      await Promise.all(unmatched.map(async (intent) => {
        if (intent.status === 'failed') { top.push(intentItem(intent, 'failed', opts)); return }
        // The explorer may lag behind the chain: ask each leg's source for the row directly.
        const found: ChainTx[] = []
        for (const h of intent.hashes) {
          const source = sources.get(h.chain) ?? sources.get(catalogChain(h.chain))
          if (!source) continue
          const address = catalogChain(h.chain) === catalogChain(intent.chain) ? intent.address : input.addresses.find((a) => catalogChain(a.chain) === catalogChain(h.chain))?.address
          if (!address) continue
          try {
            const tx = await source.getTransaction(h.hash, address)
            if (tx) found.push(tx)
          } catch (error) { report({ stage: 'source', chain: h.chain, address, error }) }
        }
        if (found.length > 0) {
          for (const tx of found) {
            const id = txKey(tx.chain, tx.hash)
            const existing = candidates.get(id) ?? candidateByMatch.get(matchKey(tx.chain, tx.hash))
            if (existing) {
              // The page already carries the row: the intent still owns it.
              existing.item = applyIntent(existing.item, intent, opts)
              settle(intent, existing.item.status)
              continue
            }
            const item = applyIntent(describeWithRecognizers(tx, ownOn(tx.chain), recognizers, opts, report), intent, opts)
            candidates.set(id, { item, tx, refs: [] })
            candidateByMatch.set(matchKey(tx.chain, tx.hash), { item, tx, refs: [] })
            settle(intent, item.status)
          }
          return
        }
        const ttl = opts.pendingTtl ?? DEFAULT_PENDING_TTL
        if (intent.createdAt + ttl < now()) { journalWrites.push({ ...intent, status: 'failed' }); top.push(intentItem(intent, 'failed', opts)) }
        else top.push(intentItem(intent, 'pending', opts))
      }))
    }

    for (const { intent, failed, confirmed } of legs.values()) {
      const next = failed ? 'failed' : confirmed ? 'confirmed' : 'pending'
      if (next !== 'pending' && intent.status !== next && !journalWrites.some((w) => w.id === intent.id)) journalWrites.push({ ...intent, status: next })
    }

    // Cross-chain join: several rows of one intent on this page → one item, source leg first.
    const groups = new Map<string, Candidate[]>()
    for (const c of candidates.values()) if (c.item.intentId !== undefined) groups.set(c.item.intentId, [...(groups.get(c.item.intentId) ?? []), c])
    for (const [intentId, group] of groups) {
      if (group.length < 2) continue
      const intent = intents.find((i) => i.id === intentId)!
      const first = intent.hashes[0]
      const base = group.find((c) => first && catalogChain(c.item.chain) === catalogChain(first.chain) && c.item.hash === first.hash) ?? [...group].sort((a, b) => a.item.time - b.item.time)[0]!
      const others = group.filter((c) => c !== base)
      const item: FeedItem = { ...base.item, kind: intent.kind }
      if (intent.protocol !== undefined && item.protocol === undefined) item.protocol = intent.protocol
      if (intent.subtitle !== undefined && base.item.protocol === undefined) item.subtitle = intent.subtitle
      // On-chain legs beat expected amounts: what the destination leg received is the real `assetsIn`.
      const destIn = unionAssets(others.map((c) => c.item.assetsIn))
      if (destIn.length > 0) item.assetsIn = destIn
      else if (base.item.assetsIn.length === 0 && intent.expect) item.assetsIn = intent.expect.assetsIn
      if (item.assetsOut.length === 0 && intent.expect) item.assetsOut = intent.expect.assetsOut
      if (others.some((c) => c.item.status === 'failed')) item.status = 'failed'
      item.title = titleFor(item.kind, item.chain, item.assetsOut, item.assetsIn, opts)
      item.related = dedupeLegs([...others.map((c) => ({ chain: c.item.chain, hash: c.item.hash })), ...intent.hashes, ...(intent.related ?? [])], base.item)
      base.item = item
      for (const c of others) c.suppressed = true
    }
  }

  // 5. Merge newest-first: a k-way merge of the fetched pages, each kept in its source's own order
  //    (equal timestamps stay as the source lists them), so what a page gives up is always a prefix
  //    — no row skipped, none emitted twice. A row two pages list waits until both have reached it.
  const visible = (c: Candidate) => !c.suppressed && (query.includeSpam === true || c.item.spam !== true)
  interface Head { f: Fetched; i: number }
  const heads: Head[] = fetched.filter((f) => !f.failed && f.rows.length > 0).map((f) => ({ f, i: 0 }))
  const headOf = new Map(heads.map((h) => [h.f.key, h]))
  const at = (h: Head): Candidate => candidates.get(txKey(h.f.rows[h.i]!.chain, h.f.rows[h.i]!.hash))!
  const live = (h: Head) => h.i < h.f.rows.length
  // Rows found outside any page (an intent's leg looked up directly) merge by time.
  const loose = [...candidates.values()].filter((c) => c.refs.length === 0).sort((x, y) => byTimeDesc(x.item, y.item))
  // A page used up that has more: nothing older than its last row may follow (its next page could fill the gap).
  const boundaryOf = (h: Head): number => (!live(h) && h.f.next !== undefined ? h.f.rows[h.f.rows.length - 1]!.time : -Infinity)
  const walked: Candidate[] = []
  const emitted = new Set<Candidate>()
  const consumed = new Map<string, number>()
  let emittedCount = 0
  for (let steps = 0; emittedCount < limit && steps < 100_000; steps++) {
    for (const h of heads) while (live(h) && h.f.silent?.has(h.i)) { h.i++; consumed.set(h.f.key, h.i) }
    let best: Head | undefined
    for (const h of heads) if (live(h) && (!best || at(h).item.time > at(best).item.time)) best = h
    const boundary = Math.max(-Infinity, ...heads.map(boundaryOf))
    const next = loose[0]
    if (next && (!best || next.item.time > at(best).item.time)) {
      if (next.item.time < boundary) break
      loose.shift()
      if (!emitted.has(next)) { emitted.add(next); walked.push(next); if (visible(next)) emittedCount++ }
      continue
    }
    if (!best) break
    // A shared row: first let every other page that lists it reach it.
    let h = best
    for (let guard = 0; guard < heads.length; guard++) {
      const c = at(h)
      const blocker = c.refs.map((r) => ({ r, o: headOf.get(r.key) })).find(({ r, o }) => o !== undefined && o !== h && live(o) && o.i < r.index)?.o
      if (!blocker) break
      h = blocker
    }
    const c = at(h)
    if (c.item.time < boundary) break
    for (const r of c.refs) {
      const o = headOf.get(r.key)
      if (o && live(o) && o.i === r.index) { o.i++; consumed.set(o.f.key, o.i) }
    }
    if (emitted.has(c)) continue
    emitted.add(c)
    walked.push(c)
    if (visible(c)) emittedCount++
  }
  const items = [...top.sort((a, b) => b.time - a.time), ...walked.filter(visible).map((c) => c.item)]

  // 6. Next cursor.
  const next: FeedCursorState = {}
  for (const f of fetched) {
    if (f.failed) { next[f.key] = f.prior; continue }
    const n = consumed.get(f.key) ?? 0
    if (n >= f.rows.length) {
      if (f.next !== undefined) next[f.key] = { c: f.next, n: 0 }
    } else {
      const last = n > 0 ? txKey(f.rows[n - 1]!.chain, f.rows[n - 1]!.hash) : f.prior.l !== undefined && f.pageCursor === f.prior.c ? f.prior.l : undefined
      next[f.key] = { ...(f.pageCursor === undefined ? {} : { c: f.pageCursor }), n: f.skip + n, ...(last !== undefined ? { l: last } : {}) }
    }
  }

  // 7. Persist what the chain told us about pending intents.
  if (journal) {
    for (const w of journalWrites) {
      try { await journal.put(w) } catch (error) { report({ stage: 'journal', error }) }
    }
  }

  const page: HistoryFeedPage = { items }
  const cursor = packCursor(next)
  if (cursor !== undefined) page.cursor = cursor
  if (errors.length > 0) page.errors = errors
  return page
}

/** One transaction through the same pipeline (recognizers → generic → intent inheritance), for detail screens. */
export async function describeSingle(tx: ChainTx, own: Set<string>, recognizers: readonly ActivityRecognizer[], journal: IntentJournal | undefined, opts: ActivityOptions): Promise<FeedItem> {
  const report = (r: ActivityErrorReport) => opts.onError?.(r)
  let item = describeWithRecognizers(tx, own, recognizers, opts, report)
  if (journal) {
    try {
      const intents = await journal.list()
      const intent = intents.find((i) => i.hashes.some((h) => catalogChain(h.chain) === catalogChain(tx.chain) && h.hash === tx.hash))
      if (intent) item = applyIntent(item, intent, opts)
    } catch (error) { report({ stage: 'journal', error }) }
  }
  return item
}
