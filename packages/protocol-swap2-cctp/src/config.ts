// Circle CCTP V2 — mainnet domains, contracts and the native USDC each domain
// mints. Sources (read 2026-10-10, Arc + Morph 2026-10-14): developers.circle.com/cctp/evm-smart-contracts
// (domains + TokenMessengerV2 / MessageTransmitterV2, the same addresses on
// every EVM chain except EDGE), developers.circle.com/stablecoins/usdc-contract-addresses
// (native USDC). Only chains whose USDC is Circle-native are listed: CCTP
// burns native USDC, a bridged USDC.e (BSC, Gnosis) cannot ride it.
import {evmRef, isEvm} from "@forgewallet/protocol-swap2-core/util";

export interface CctpDomain {
  caip2: string;
  chainId: number;
  domain: number;
  name: string;
  usdc: string;
  tokenMessenger: string;
  messageTransmitter: string;
}

export const TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
export const MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

const d = (chainId: number, domain: number, name: string, usdc: string): CctpDomain => ({
  caip2: `eip155:${chainId}`, chainId, domain, name, usdc, tokenMessenger: TOKEN_MESSENGER_V2, messageTransmitter: MESSAGE_TRANSMITTER_V2,
});

/** CAIP-2 → CCTP domain. */
export const CCTP_DOMAINS: Readonly<Record<string, CctpDomain>> = Object.freeze(Object.fromEntries([
  d(1, 0, "Ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  d(43114, 1, "Avalanche", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"),
  d(10, 2, "OP Mainnet", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
  d(42161, 3, "Arbitrum", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
  d(8453, 6, "Base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  d(137, 7, "Polygon PoS", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
  d(130, 10, "Unichain", "0x078D782b760474a361dDA0AF3839290b0EF57AD6"),
  d(59144, 11, "Linea", "0x176211869cA2b568f2A7D4EE941E073a821EE1ff"),
  d(146, 13, "Sonic", "0x29219dd400f2Bf60E5a23d13Be72B486D4038894"),
  d(480, 14, "World Chain", "0x79A02482A880bCe3F13E09da970dC34dB4cD24D1"),
  d(143, 15, "Monad", "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"),
  d(1329, 16, "Sei", "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392"),
  d(999, 19, "HyperEVM", "0xb88339CB7199b77E23DB6E890353E22632Ba630f"),
  d(57073, 21, "Ink", "0x2D270e6886d130D724215A266106e6832161EAEd"),
  d(98866, 22, "Plume", "0x222365EF19F7947e5484218551B56bb3965Aa7aF"),
  d(9745, 33, "Plasma", "0x2d661C89D812261039AF9764eceaAee884f5F67F"),
  d(196, 37, "X Layer", "0xB6CEceAB302E2E4948951eE7843FC24E92933061"),
  // 2026-10-14: Arc and Morph (developers.circle.com/cctp/evm-smart-contracts + usdc-contract-addresses; TokenMessengerV2 /
  // MessageTransmitterV2 have code on both chains, MessageTransmitterV2.localDomain() answers 26 / 30 and
  // TokenMessengerV2.localMessageTransmitter() points at 0x81D4…). Arc's USDC is the chain's gas token: 0x3600… is its
  // 6-decimal ERC-20 interface, which is what CCTP burns and mints.
  d(5042, 26, "Arc", "0x3600000000000000000000000000000000000000"),
  d(2818, 30, "Morph", "0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B"),
].map((x) => [x.caip2, x])));

/** CCTP domain → entry. */
export const CCTP_BY_DOMAIN: Readonly<Record<number, CctpDomain>> = Object.freeze(
  Object.fromEntries(Object.values(CCTP_DOMAINS).map((x) => [x.domain, x])),
);

/** Solana is CCTP domain 5 (not executed by this package yet: the engine runs calldata on EVM only). */
export const CCTP_SOLANA_DOMAIN = 5;

export const CCTP_API = "https://iris-api.circle.com";

/** Finality thresholds the header carries: Fast Transfer (confirmed) vs Standard (finalized). */
export const FINALITY_FAST = 1000;
export const FINALITY_STANDARD = 2000;

export const cctp = {
  supportsChain(chain: string): boolean {
    return isEvm(chain) && !!CCTP_DOMAINS[`eip155:${evmRef(chain)}`];
  },
  supports(from: string, to: string): boolean {
    return from !== to && this.supportsChain(from) && this.supportsChain(to);
  },
};
