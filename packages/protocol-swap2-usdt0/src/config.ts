// USDT0 — Tether's LayerZero OFT for USDT. Source: docs.usdt0.to
// (technical-documentation/deployments, read 2026-10-20) — every row below was
// then re-read on-chain over public RPCs the same day: the OFT's `token()` is
// the listed token, `endpoint()` is the listed endpoint (and reports the
// listed eid), `approvalRequired()` is true only for the Ethereum adapter,
// `sharedDecimals()` = 6 everywhere, and `peers(eid)` are wired between the
// chains. `oftVersion()` = (0x02e49c2c, 1) on all of them.
//
// Only chains the SDK ships (swap2-assets / wallet-evm) are listed. USDT0 is
// also deployed on Conflux eSpace (1030, eid 30212), Flare (14, 30295),
// Hedera (295, 30316), Mantle (5000, 30181), Morph (2818, 30322), Rootstock
// (30, 30333), Stable (988, 30396), Tempo (4217, 30410), plus HyperCore, IOTA
// and Stellar (non-EVM) — not wallet chains here, so not routable here.
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";

export interface Usdt0Chain {
  caip2: string;
  chainId: number;
  /** LayerZero V2 endpoint id. */
  eid: number;
  name: string;
  /** The ERC-20 the user holds: USDT on Ethereum, USDT0 elsewhere (6 decimals everywhere). */
  token: string;
  /**
   * The OFT contract `quoteSend` / `send` are called on. On Ethereum it is the
   * OFT *adapter* that locks USDT (`approvalRequired()` = true, approve the
   * token to it); elsewhere it is the OUpgradeable OFT that burns the caller's
   * USDT0 through the token's mint/burn role — no approval.
   */
  oft: string;
  /** LayerZero V2 EndpointV2 on that chain (`lzReceive` retries of a stored payload go here). */
  endpoint: string;
  /** True on Ethereum: the OFT is a lockbox adapter in front of plain USDT. */
  adapter: boolean;
}

const LZ_ENDPOINT_A = "0x1a44076050125825900e736c501f859c50fE728c";
const LZ_ENDPOINT_B = "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B";

const c = (chainId: number, eid: number, name: string, token: string, oft: string, endpoint: string, adapter = false): Usdt0Chain => ({
  caip2: `eip155:${chainId}`, chainId, eid, name, token, oft, endpoint, adapter,
});

/** CAIP-2 → USDT0 deployment. */
export const USDT0_CHAINS: Readonly<Record<string, Usdt0Chain>> = Object.freeze(Object.fromEntries([
  c(1, 30101, "Ethereum", "0xdAC17F958D2ee523a2206206994597C13D831ec7", "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee", LZ_ENDPOINT_A, true),
  c(42161, 30110, "Arbitrum", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92", LZ_ENDPOINT_A),
  c(10, 30111, "OP Mainnet", "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", "0xF03b4d9AC1D5d1E7c4cEf54C2A313b9fe051A0aD", LZ_ENDPOINT_A),
  c(137, 30109, "Polygon PoS", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "0x6BA10300f0DC58B7a1e4c0e41f5daBb7D7829e13", LZ_ENDPOINT_A),
  c(999, 30367, "HyperEVM", "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", "0x904861a24F30EC96ea7CFC3bE9EA4B476d237e98", "0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9"),
  c(57073, 30339, "Ink", "0x0200C29006150606B650577BBE7B6248F58470c1", "0x1cB6De532588fCA4a21B7209DE7C456AF8434A65", "0xca29f3A6f966Cb2fc0dE625F8f325c0C46dbE958"),
  c(80094, 30362, "Berachain", "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", "0x3Dc96399109df5ceb2C226664A086140bD0379cB", LZ_ENDPOINT_B),
  c(130, 30320, "Unichain", "0x9151434b16b9763660705744891fA906F660EcC5", "0xc07bE8994D035631c36fb4a89C918CeFB2f03EC3", LZ_ENDPOINT_B),
  c(1329, 30280, "Sei", "0x9151434b16b9763660705744891fA906F660EcC5", "0x56Fe74A2e3b484b921c447357203431a3485CC60", LZ_ENDPOINT_A),
  c(9745, 30383, "Plasma", "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", "0x02ca37966753bDdDf11216B73B16C1dE756A7CF9", LZ_ENDPOINT_B),
  c(143, 30390, "Monad", "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", "0x9151434b16b9763660705744891fA906F660EcC5", LZ_ENDPOINT_B),
  c(4326, 30398, "MegaETH", "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", "0x9151434b16b9763660705744891fA906F660EcC5", LZ_ENDPOINT_B),
  c(196, 30274, "X Layer", "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", "0x94bcCa6BdfD6a61817aB0E960BfedE4984505554", LZ_ENDPOINT_A),
  // 2026-10-20 (evm-chains-6 batch): docs.usdt0.to deployments, re-read on-chain (token(), approvalRequired() = false,
  // sharedDecimals() = 6, endpoint(), peers(30110) = the Arbitrum OFT).
  c(5000, 30181, "Mantle", "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", "0xcb768e263FB1C62214E7cab4AA8d036D76dc59CC", LZ_ENDPOINT_A),
  c(2818, 30322, "Morph", "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", "0xcb768e263FB1C62214E7cab4AA8d036D76dc59CC", LZ_ENDPOINT_B),
  c(14, 30295, "Flare", "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", "0x567287d2A9829215a37e3B88843d32f9221E7588", LZ_ENDPOINT_A),
].map((x) => [x.caip2, x])));

/** LayerZero eid → deployment. */
export const USDT0_BY_EID: Readonly<Record<number, Usdt0Chain>> = Object.freeze(
  Object.fromEntries(Object.values(USDT0_CHAINS).map((x) => [x.eid, x])),
);

/** LayerZero Scan — message status by source transaction hash. */
export const LZ_SCAN_API = "https://scan.layerzero-api.com";

/** Token symbols the catalog uses for the same asset across chains. */
export const USDT0_SYMBOLS: readonly string[] = Object.freeze(["USDT0", "USDT", "USD₮0", "USD₮"]);

export const usdt0 = {
  supportsChain(chain: string): boolean {
    return isEvm(chain) && !!USDT0_CHAINS[`eip155:${evmRef(chain)}`];
  },
  supports(from: string, to: string): boolean {
    return from !== to && this.supportsChain(from) && this.supportsChain(to);
  },
};
