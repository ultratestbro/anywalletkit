/** What browser and React Native bundles get for ./node-transport.js: no pinned Node transport there. */
export type PinnedCall = (
  call: { url: string; method: 'GET' | 'POST'; body?: { sender: string; data: string } },
  opts: { timeoutMs: number; maxResponseBytes: number },
) => Promise<{ status: number; body: { data: string } | { error: string } }>

export const loadNodeTransport: (() => Promise<PinnedCall>) | null = null
