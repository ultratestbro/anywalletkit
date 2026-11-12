/**
 * Settlement contracts this deployment trusts for Omniston, per CAIP-2 chain.
 * Audited public addresses — no secret — so both the server wiring and the
 * browser-side provider import them from here.
 * See how-to-project/OMNISTON-NETWORK-ONBOARDING.md before adding a network.
 */
export const AUDITED_OMNISTON_SETTLEMENT_CONTRACTS: Record<string, string[]> = {
  // The TON Escrow Minter a new TON <-> EVM order may name. The provider
  // compares TON addresses as these exact strings, so it is kept in the form
  // Omniston's quotes use.
  // - EQDybO88… (code 9737943f…, "rev2"): every TON <-> EVM quote names it
  //   since 2026-11-10 ~19:00Z. Reviewed 2026-11-12, read-only:
  //   - Deploy tx fkabfHcN8DcrqQyazmlB+UprljBDeEkvFlgaVOi905g=
  //     (2026-11-10 18:47:06Z). Code and data still equal that StateInit:
  //     no upgrade since, none pending (no pendingCode, upgradeAfter 0).
  //   - Same admin (0:408fff62…) as rev1; it is also the admin_address of the
  //     STON.fi DEX v2 routers api.ston.fi lists. Deployed from the same
  //     wallet as rev1 (a weak signal on TON: anyone can send a StateInit).
  //   - The bytecode diff to rev1: escrow / execution code must be in an
  //     embedded whitelist (9e77…, f6ed…, d304…, pinned in ton.ts, plus 9fe4…
  //     for TON <-> TON, which the SDK does not pin), the escrow sub-VM must
  //     return one value, and a failed position deploy now credits the amount
  //     back to the same account contract instead of aborting (the only new
  //     path that moves value; no real message has used it). Fees, timelocks,
  //     payouts, admin and the 7-day upgrade delay are unchanged. Replayed
  //     through both codes, the real traffic of both minters (~42k
  //     transactions) and of ~1,070 of their positions gave the same outputs.
  //   - It deploys positions with code eb503578…, the only code in
  //     DEFAULT_OMNISTON_TON_CODE_HASHES.position. The address and that pin
  //     go together: without the pin every EVM -> TON order on this minter
  //     fills and then fails the disclosure check.
  // - EQAbWJ3Y… (code f91c43d3…, "rev1", deployed 2026-06-09) is no longer
  //   trusted by default (2026-11-12). Omniston's resolvers moved to rev2 on
  //   2026-11-10, and rev1 lacks the escrow-code whitelist rev2 added: on
  //   rev1 only the SDK's own pins check the escrow and execution code an
  //   order carries. A quote or build that names rev1 is refused with its
  //   address in the reason; its positions (code e4d5115a…) fail
  //   position-code-hash. It stays in OMNISTON_ESCROWS (activity.ts), which
  //   recognizes history and grants no trust. Old orders need nothing from
  //   this table: trackIntent reads no trust table, and every disclosure
  //   check refuses a quote older than 6 h, so a rev1 order quoted before
  //   the switch cannot be closed by any version. Listing rev1 here or in
  //   trustedProtocolAddresses trusts it again for NEW orders; it does not
  //   help close an old one.
  "ton:-239": ["EQDybO88l2lrrAmALRUqpmgEE_tuxk510F4Yd4xjbQZxC9IA"],
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
