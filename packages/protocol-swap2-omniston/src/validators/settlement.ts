/**
 * Settlement contracts this deployment trusts for Omniston, per CAIP-2 chain.
 * Audited public addresses — no secret — so both the server wiring and the
 * browser-side provider import them from here.
 * See how-to-project/OMNISTON-NETWORK-ONBOARDING.md before adding a network.
 */
export const AUDITED_OMNISTON_SETTLEMENT_CONTRACTS: Record<string, string[]> = {
  "ton:-239": ["EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ"],
  "eip155:1": ["0xafCF681272AF10959736f45616eeCBC22D7095E2"],
  "eip155:56": ["0xafCF681272AF10959736f45616eeCBC22D7095E2"],
  "eip155:137": ["0x41A392062A4307a6961d48e30FF20bF6823715B8"],
  "eip155:4663": ["0xafCF681272AF10959736f45616eeCBC22D7095E2"],
  "eip155:8453": ["0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd"],
  "eip155:42161": ["0xafCF681272AF10959736f45616eeCBC22D7095E2"],
  "eip155:43114": ["0xafCF681272AF10959736f45616eeCBC22D7095E2"],
  // 2026-10-20: one factory address on X Layer, HyperEVM and Plasma. Runtime
  // bytecode equals Ethereum's 0xafCF… byte for byte except the immutable slots
  // (escrow implementations, its order protocol, domain hash); it references
  // the order protocol trusted below on the same chain.
  "eip155:196": ["0xd602079AFa5c38F550510a2a988CbFa698Fa0189"],
  "eip155:999": ["0xd602079AFa5c38F550510a2a988CbFa698Fa0189"],
  "eip155:9745": ["0xd602079AFa5c38F550510a2a988CbFa698Fa0189"],
};

/**
 * EVM order protocols (Omniston's fork of the 1inch Limit Order Protocol v4 —
 * NOT the canonical 1inch deployment) an EVM→TON order is signed against. The
 * wallet approves this contract for the input amount and signs an EIP-712
 * order whose domain names it; on fill it moves the input into the escrow the
 * factory above deploys. One address, different roles per chain (0xafCF… is
 * the factory elsewhere and the order protocol on Polygon), so this table is
 * separate from the factory table and CAIP-scoped. Runtime code hashes are in
 * how-to-project/OMNISTON-NETWORK-ONBOARDING.md (snapshot 2026-10-16).
 */
export const AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS: Record<string, string[]> = {
  "eip155:1": ["0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9"],
  "eip155:56": ["0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9"],
  "eip155:137": ["0xafCF681272AF10959736f45616eeCBC22D7095E2"],
  "eip155:8453": ["0xe7405fAcDEDB2512e91F2886BDff13231343aF5E"],
  "eip155:42161": ["0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9"],
  "eip155:43114": ["0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9"],
  // 2026-10-20: bytecode equals Ethereum's 0xb581… except immutables (wrapped
  // native, own address, chain id 196 / 9745 / 999 at the chain-id slot).
  "eip155:196": ["0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9"],
  "eip155:9745": ["0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9"],
  "eip155:999": ["0xD84778bbeEC5D2a8d17c6424249C438EC0b1ABE3"],
};
