// Dry live check of every Omniston order route through the built module: quote + build with all validators, nothing is signed or sent. Run after `pnpm run build`: node examples/live-routes.mjs
import { omnistonProvider } from "../dist/index.js";
import { createOmnistonEvmInputValidator, createOmnistonEvmOutputValidator, createOmnistonTonValidators, AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS } from "../dist/validators.js";
const ton = createOmnistonTonValidators({});
const p = omnistonProvider({
  trustedSettlementContracts: AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, trustedEvmOrderProtocols: AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS,
  maxHtlcExecutions: 1, ...ton, validateEvmInputPosition: createOmnistonEvmInputValidator(), validateEvmOutputPosition: createOmnistonEvmOutputValidator(),
});
const TON_TRADER = "EQCOPHYSaiB-c3bH4js_jIIwVhLxikq4edDNbtJcjY0Rsg88"; // a live TON wallet with USDT jetton wallet (resolver)
const EVM = "0x4444444444444444444444444444444444444444", DEST = "0x3333333333333333333333333333333333333333";
const runs = [
  ["TON USDT → Plasma USDT0", { sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:9745", destToken: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", destAddress: DEST, refundAddress: TON_TRADER }],
  ["TON USDT → Base USDC", { sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:8453", destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", destAddress: DEST, refundAddress: TON_TRADER }],
  ["Base USDC → Arbitrum USDT0", { sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", destAddress: DEST, refundAddress: EVM }],
  ["Plasma USDT0 → Base USDC", { sourceChain: "eip155:9745", sourceToken: "USDT0", destChain: "eip155:8453", destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", destAddress: DEST, refundAddress: EVM }],
  ["Plasma USDT0 → TON USDT", { sourceChain: "eip155:9745", sourceToken: "USDT0", destChain: "ton:-239", destToken: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", destAddress: TON_TRADER, refundAddress: EVM }],
  ["TON USDT → X Layer USDT0", { sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:196", destToken: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", destAddress: DEST, refundAddress: TON_TRADER }],
  ["TON USDT → HyperEVM USDC", { sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:999", destToken: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", destAddress: DEST, refundAddress: TON_TRADER }],
  ["HyperEVM USDC → TON USDT", { sourceChain: "eip155:999", sourceToken: "USDC", destChain: "ton:-239", destToken: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", destAddress: TON_TRADER, refundAddress: EVM }],
  ["Ethereum USDT → Base USDC", { sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:8453", destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", destAddress: DEST, refundAddress: EVM }],
  ["X Layer USDT0 → Base USDC", { sourceChain: "eip155:196", sourceToken: "USDT0", destChain: "eip155:8453", destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", destAddress: DEST, refundAddress: EVM }],
];
for (const [label, base] of runs) {
  const refusals = [];
  const supported = p.supportsRoute({ chain: base.sourceChain, token: base.sourceToken }, { chain: base.destChain, token: base.destToken });
  const q = await p.getQuote({ ...base, amountIn: "20000000", slippageBps: 100, dry: false, onRefusal: (r) => refusals.push(r) });
  if (!q) { console.log(`✗ ${label}: supportsRoute=${supported} no quote — ${refusals.join("; ")}`); continue; }
  try {
    const tx = await p.buildDeposit(q);
    console.log(`✓ ${label}: out=${q.destAmount} built ${tx.typedData ? "EIP-712 order to " + tx.to : "TON escrow transfer to " + tx.to}`);
  } catch (e) { console.log(`✗ ${label}: quote ok (out=${q.destAmount}), build refused — ${e.message}`); }
}
p.close?.(); process.exit(0);
