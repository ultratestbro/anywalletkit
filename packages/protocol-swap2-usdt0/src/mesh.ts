// USDT0 Legacy Mesh — the pool-based LayerZero network that connects Tether's USDT where it was never replaced by an
// OFT (Ethereum, Tron, TON, Celo, Solana) with the USDT0 hub on Arbitrum. One `UsdtOFT` per chain: `send` locks the
// caller's USDT (or Arbitrum's USDT0) in that chain's pool, the destination pool pays out the same token less the
// mesh fee (`feeBps` = 3 → 0.03 %), and per-destination `credits` cap how much a pool can send there.
//
// Sources, all read 2026-11-12:
//  - docs.usdt0.to/api/deployments (`usdt0.legacyMesh`, the JSON behind docs.usdt0.to/technical-documentation/deployments
//    → "Legacy Mesh"): Ethereum OFT 0x1F74…dFB0 (eid 30101), Arbitrum OFT 0x7765…9B92 (30110), Celo OFT 0xf10E…b243
//    (30125), TON OFT EQAd31…jX6Gq (30343), Tron OFT TFG4wB…zevLPt (30420); Solana (30168) is not wired here.
//  - docs.usdt0.to/technical-documentation/developer §4 and docs.usdt0.to/overview/the-legacy-mesh: the UsdtOFT
//    interface (quoteOFT / quoteSend / send), the 0.03 % fee, "migrated as a whole" on an upgrade.
//  - The verified source (Sourcify full match, chain 1 and 42161, contracts/UsdtOFT.sol): not a proxy; `quoteOFT` →
//    limit 0..credits[dstEid], no fee rows, received = amount − amount·feeBps/10000; `quoteSend` reverts below the
//    credits; `send` pulls the token with transferFrom (`approvalRequired()` = true); the message carries
//    `SendParam.to` verbatim and the EVM / Tron side pays `address(uint160(uint256(to)))`; compose to TON reverts.
//  - On-chain over public RPCs: on each of the three EVM OFTs `token()` is the token below, `approvalRequired()` true,
//    `endpoint()` the EndpointV2 below, `sharedDecimals()` 6, `feeBps()` 3, `peers(30420)` = 0x…3a08f767…0e97 (the
//    Tron OFT's 20 bytes, left-padded) and `peers(30343)` = 0x1ddf5800…a35f (the TON OFT's account hash; it sits on
//    workchain 0), and they peer each other; `enforcedOptions(30420 | 30343, 2)` carry the executor gas (type 3), so
//    `extraOptions` stays empty.
//  - Recipient encoding, checked against real deliveries on LayerZero Scan (2026-11-12): a direct `send` on the
//    Arbitrum OFT to eid 30420 with `to` = 0x000…005b3307de…d924 and one to eid 30343 with `to` = 0xcc62e9d7…1f79;
//    the packets carried those bytes verbatim, TronGrid shows USDT from TFG4wB…zevLPt to the base58check spelling of
//    the 20 bytes, and tonapi / toncenter show the USDT jetton from the TON OFT to 0:<the 32 bytes>. The 32 bytes hold
//    no workchain: the TON side pays on workchain 0 (basechain), so any other workchain is refused here.
//
// Only EVM sources sign here; Tron and TON are destinations. A Tron or TON source needs that chain's signer to call
// its own OFT (see the package README).
import {base58} from "@scure/base";
import {isHex, sha256, type Hex} from "viem";
import {base64Bytes, tonRawAddress} from "@anywalletkit/protocol-swap2-core/util";
import {catalogChainId, ccAsset} from "@anywalletkit/swap2-assets";

/** An EVM chain whose Legacy Mesh OFT can send into Tron / TON. */
export interface Usdt0MeshSource {
  caip2: string;
  chainId: number;
  /** LayerZero V2 endpoint id. */
  eid: number;
  name: string;
  /** The ERC-20 the pool locks: Tether's USDT on Ethereum and Celo, USDT0 on Arbitrum (6 decimals everywhere). */
  token: string;
  /** The `UsdtOFT` `quoteOFT` / `quoteSend` / `send` are called on; it pulls `token` (approve it to this address). */
  oft: string;
  /** LayerZero V2 EndpointV2 on that chain. */
  endpoint: string;
}

/** A Legacy Mesh destination family (the provider's `meshDestinations` option names them). */
export type Usdt0MeshFamily = "tron" | "ton";

/**
 * The Legacy Mesh destinations a provider offers unless its `meshDestinations` option says otherwise: TON only. Tron is
 * opt-in: the LayerZero fee into Tron (live 2026-11-12: ≈ 0.0053 ETH from Ethereum / Arbitrum, ≈ 170 CELO from Celo,
 * before the 25 % headroom) is above the swap2 engine's native-fee ceiling (0.005 ETH, 100 CELO), so the engine refuses
 * to execute such a send; offer it only where the send can be executed.
 */
export const USDT0_MESH_DEFAULT_DESTINATIONS: readonly Usdt0MeshFamily[] = Object.freeze(["ton"] as const);

/** A Legacy Mesh destination this package delivers to (no signing there). */
export interface Usdt0MeshDestination {
  caip2: string;
  family: Usdt0MeshFamily;
  eid: number;
  name: string;
  /** The destination's `UsdtOFT`, in that chain's own spelling. */
  oft: string;
  /** `peers(eid)` on every EVM mesh OFT: the destination OFT as LayerZero bytes32. */
  peer: Hex;
  /** Tether's USDT there (TRC-20 contract / jetton master). */
  token: string;
}

const LZ_ENDPOINT_V2 = "0x1a44076050125825900e736c501f859c50fE728c";

/** CAIP-2 → Legacy Mesh OFT on an EVM source chain. */
export const USDT0_MESH_SOURCES: Readonly<Record<string, Usdt0MeshSource>> = Object.freeze({
  "eip155:1": Object.freeze({caip2: "eip155:1", chainId: 1, eid: 30101, name: "Ethereum", token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", oft: "0x1F748c76dE468e9D11bd340fA9D5CBADf315dFB0", endpoint: LZ_ENDPOINT_V2}),
  "eip155:42161": Object.freeze({caip2: "eip155:42161", chainId: 42161, eid: 30110, name: "Arbitrum", token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", oft: "0x77652D5aba086137b595875263FC200182919B92", endpoint: LZ_ENDPOINT_V2}),
  // Celo's mesh token is Tether's USD₮ 0x4806…3D5e (470M supply, `token()` of the OFT), not the catalog's "USDT"
  // 0x617f…a546 (a bridged USDT): on Celo the route takes the contract address.
  "eip155:42220": Object.freeze({caip2: "eip155:42220", chainId: 42220, eid: 30125, name: "Celo", token: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", oft: "0xf10E161027410128E63E75D0200Fb6d34b2db243", endpoint: LZ_ENDPOINT_V2}),
});

/** CAIP-2 (catalog id) → Legacy Mesh destination. */
export const USDT0_MESH_DESTINATIONS: Readonly<Record<string, Usdt0MeshDestination>> = Object.freeze({
  "tron:728126428": Object.freeze({
    caip2: "tron:728126428", family: "tron" as const, eid: 30420, name: "Tron", oft: "TFG4wBaDQ8sHWWP1ACeSGnoNR6RRzevLPt",
    peer: "0x0000000000000000000000003a08f76772e200653bb55c2a92998daca62e0e97" as Hex, token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  }),
  "ton:-239": Object.freeze({
    caip2: "ton:-239", family: "ton" as const, eid: 30343, name: "TON", oft: "EQAd31gAUhdO0d0NZsNb_cGl_Maa9PSuNhVLE9z8bBSjX6Gq",
    peer: "0x1ddf580052174ed1dd0d66c35bfdc1a5fcc69af4f4ae36154b13dcfc6c14a35f" as Hex, token: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
  }),
});

/** LayerZero eid → mesh source / destination. */
export const USDT0_MESH_SOURCE_BY_EID: Readonly<Record<number, Usdt0MeshSource>> = Object.freeze(
  Object.fromEntries(Object.values(USDT0_MESH_SOURCES).map((x) => [x.eid, x])),
);
export const USDT0_MESH_DESTINATION_BY_EID: Readonly<Record<number, Usdt0MeshDestination>> = Object.freeze(
  Object.fromEntries(Object.values(USDT0_MESH_DESTINATIONS).map((x) => [x.eid, x])),
);

/** Dry-quote placeholders (never built: a live quote needs the real recipient): the zero account of each family. */
export const USDT0_MESH_PLACEHOLDER: Readonly<Record<Usdt0MeshFamily, string>> = Object.freeze({
  tron: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
  ton: `0:${"0".repeat(64)}`,
});

const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/** The mesh source on `chain` (an `eip155:` id), if any. */
export function meshSourceFor(chain: string): Usdt0MeshSource | undefined {
  return own(USDT0_MESH_SOURCES, chain);
}

/** The mesh destination on `chain` (`tron:728126428` / `tron:0x2b6653dc`, `ton:-239`), if any. */
export function meshDestinationFor(chain: string): Usdt0MeshDestination | undefined {
  return own(USDT0_MESH_DESTINATIONS, catalogChainId(chain));
}

/** The mesh destination on `chain` when its family is one of `families` (default {@link USDT0_MESH_DEFAULT_DESTINATIONS}). */
export function meshDestinationOn(chain: string, families: readonly string[] = USDT0_MESH_DEFAULT_DESTINATIONS): Usdt0MeshDestination | undefined {
  const dst = meshDestinationFor(chain);
  return dst && families.includes(dst.family) ? dst : undefined;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** A Tron base58check address (`T…`) → its 20 account bytes (the 0x41 prefix dropped); null for anything else. */
export function tronAccountBytes(address: unknown): Uint8Array | null {
  if (typeof address !== "string" || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return null;
  let b: Uint8Array;
  try { b = base58.decode(address); } catch { return null; }
  if (b.length !== 25 || b[0] !== 0x41) return null;
  if (!sameBytes(sha256(sha256(b.subarray(0, 21), "bytes"), "bytes").subarray(0, 4), b.subarray(21))) return null;
  return b.slice(1, 21);
}

/** The base58check spelling (`T…`) of 20 Tron account bytes. */
export function tronAddressOf(account: Uint8Array): string {
  if (account.length !== 20) throw new Error("usdt0: a Tron account is 20 bytes");
  const body = new Uint8Array(25);
  body[0] = 0x41;
  body.set(account, 1);
  body.set(sha256(sha256(body.subarray(0, 21), "bytes"), "bytes").subarray(0, 4), 21);
  return base58.encode(body);
}

/** A TON address read strictly: workchain + 32-byte account hash; or the reason it is not one the mesh can pay. */
export function tonAccount(address: unknown): {workchain: number; hash: Uint8Array} | {refusal: string} {
  const notTon = {refusal: "destination must be a TON address (raw 0:… or user-friendly EQ…/UQ…)"};
  if (typeof address !== "string") return notTon;
  const text = address.trim();
  const raw = /^(-?[0-9]{1,3}):([0-9a-fA-F]{64})$/.exec(text);
  let workchain: number;
  let hash: Uint8Array;
  if (raw) {
    workchain = Number(raw[1]);
    hash = Uint8Array.from(raw[2]!.match(/../g)!.map((h) => parseInt(h, 16)));
  } else {
    // tonRawAddress checks the CRC16; the tag byte is checked here: 0x11 bounceable / 0x51 non-bounceable, 0x80 = testnet only.
    if (!/^[A-Za-z0-9+/_-]{48}$/.test(text) || tonRawAddress(text) === null) return notTon;
    const bytes = base64Bytes(text);
    if (!bytes || bytes.length !== 36) return notTon;
    const tag = bytes[0]!;
    if (tag & 0x80) return {refusal: "destination is a testnet-only TON address"};
    if (tag !== 0x11 && tag !== 0x51) return notTon;
    workchain = bytes[1] === 0xff ? -1 : bytes[1]!;
    hash = bytes.slice(2, 34);
  }
  return {workchain, hash};
}

/**
 * The bytes32 `SendParam.to` for a recipient on a mesh destination, or the reason it cannot be one: Tron → the 20
 * account bytes left-padded (what the Tron OFT turns back into an address), TON → the 32-byte account hash on
 * workchain 0 (the only workchain the TON OFT pays on).
 */
export function meshRecipientBytes32(dst: Usdt0MeshDestination, address: string): {to: Hex} | {refusal: string} {
  if (dst.family === "tron") {
    const account = tronAccountBytes(address);
    if (!account) return {refusal: "destination must be a Tron address (base58check T…)"};
    return {to: `0x${"00".repeat(12)}${hex(account)}`};
  }
  const t = tonAccount(address);
  if ("refusal" in t) return t;
  if (t.workchain !== 0) return {refusal: `destination must be a TON workchain 0 address — the USDT0 Legacy Mesh pays on the basechain only, not workchain ${t.workchain}`};
  return {to: `0x${hex(t.hash)}`};
}

/**
 * `to` read back the way the destination OFT reads it and compared with the requested recipient: Tron → the low 20
 * bytes (the high 12 must be zero) as base58check, equal to the request's spelling; TON → `0:<to>`, equal to the
 * request on workchain 0.
 */
export function meshRecipientMatches(dst: Usdt0MeshDestination, to: string, address: string): boolean {
  if (!isHex(to) || to.length !== 66) return false;
  const bytes = Uint8Array.from(to.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
  if (dst.family === "tron") {
    if (bytes.subarray(0, 12).some((x) => x !== 0)) return false;
    return typeof address === "string" && tronAddressOf(bytes.subarray(12)) === address;
  }
  const t = tonAccount(address);
  return !("refusal" in t) && t.workchain === 0 && tonRawAddress(address) === `0:${hex(bytes)}`;
}

/** Does `token` name Tether's USDT on the destination? Its contract / jetton master (any TON spelling), or a USDT symbol the catalog binds to it. */
export function meshDestTokenMatches(dst: Usdt0MeshDestination, token: string): boolean {
  if (typeof token !== "string" || token === "") return false;
  if (dst.family === "ton") {
    const raw = tonRawAddress(token);
    if (raw !== null) return raw === tonRawAddress(dst.token);
  } else if (token.startsWith("T") && token.length === 34) {
    return token === dst.token;
  }
  if (token.toUpperCase().replace("USD₮", "USDT") !== "USDT") return false;
  return ccAsset(dst.caip2, "USDT")?.contract === dst.token;
}

/** `0x` dropped and lowercased: Tron and TON explorers name a transaction by its bare hex hash. */
export function meshDestTxHash(hash: string): string {
  return /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash.slice(2).toLowerCase() : hash;
}
