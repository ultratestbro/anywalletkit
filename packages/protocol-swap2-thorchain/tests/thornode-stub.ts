/**
 * Answers for the reads a confirming THORNode gets besides `inbound_addresses` (THORNODE_CONFIRM_PATHS), for tests
 * whose own fetch stub only knows quotes and inbound snapshots. Shapes come from live answers recorded read-only on
 * 2026-11-12 (fixtures/thornode/2026-11-12: the Liquify gateway, THORWallet's and the IBS team's nodes).
 */
import asgardLive from "../fixtures/thornode/2026-11-12/liquify/vaults_asgard.json";
import lastblockLive from "../fixtures/thornode/2026-11-12/liquify/lastblock.json";
import mimirLive from "../fixtures/thornode/2026-11-12/liquify/mimir.json";

/** THORChain height in the recorded lastblock answer. */
export const LIVE_HEIGHT = 28643286;

export const LIVE_ASGARD = asgardLive as unknown as {pub_key: string; status: string; addresses: {chain: string; address: string}[]}[];
export const LIVE_MIMIR = mimirLive as Record<string, number>;

/** The recorded lastblock list with every chain's `thorchain` height set to `height`. */
export function lastblockAt(height: number): unknown[] {
  return lastblockLive.map((e) => ({...e, thorchain: height}));
}

/** A vault in the live shape (the first recorded vault as template) with its own pub key, status and addresses. */
export function vault(pubKeyTail: string, status: string, addresses: {chain: string; address: string}[]): Record<string, unknown> {
  const template = asgardLive[0] as Record<string, unknown>;
  return {...template, pub_key: `thorpub1addwnpepq${pubKeyTail.toLowerCase().padEnd(56, "q")}`, status, addresses};
}

/** One ActiveVault per distinct address in an inbound snapshot, holding it for every chain the snapshot lists it on. */
export function asgardFor(inbound: unknown): Record<string, unknown>[] {
  const entries = (Array.isArray(inbound) ? inbound : []) as {chain?: string; address?: string}[];
  const byAddress = new Map<string, {chain: string; address: string}[]>();
  for (const e of entries) {
    if (!e?.chain || !e.address) continue;
    byAddress.set(e.address, [...(byAddress.get(e.address) ?? []), {chain: e.chain, address: e.address}]);
  }
  return [...byAddress.values()].map((addresses, i) => vault(`stub${i}`, "ActiveVault", addresses));
}

const json = (body: unknown) => new Response(JSON.stringify(body), {status: 200});

/**
 * The confirming reads the calling stub does not answer itself: lastblock at LIVE_HEIGHT, asgard vaults holding the
 * host's own inbound addresses, the recorded mimir. Null for any other path.
 */
export function confirmReads(url: string, inbound: () => unknown): Response | null {
  const path = new URL(url).pathname;
  if (path.endsWith("/thorchain/lastblock")) return json(lastblockAt(LIVE_HEIGHT));
  if (path.endsWith("/thorchain/vaults/asgard")) return json(asgardFor(inbound()));
  if (path.endsWith("/thorchain/mimir")) return json(mimirLive);
  return null;
}
