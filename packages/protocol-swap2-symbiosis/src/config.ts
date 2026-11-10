import {base58} from "@scure/base";
import {sha256} from "@noble/hashes/sha2.js";
import {getAddress, isAddress} from "viem";
import {catalogChainId} from "@anywalletkit/swap2-assets";
import {tonRawAddress} from "@anywalletkit/protocol-swap2-core/util";

/**
 * Symbiosis deployments this module is bound to. Every address below is taken from
 * Symbiosis' own published configuration and re-read on-chain (`scripts/verify-live.mjs`):
 *
 *  - `gateway` — MetaRouterGateway: the ONLY contract a source transaction calls and the
 *    ONLY spender an ERC-20 / TRC-20 approval may name. It pulls the sell amount and hands
 *    it to the chain's MetaRouter (`executor`), which is never approved by a user.
 *  - `portal` / `bridge` — the chain's Portal (locks and releases real tokens) and the
 *    relayers' Bridge entry; the calldata names both for the destination leg.
 *  - host chain — Symbiosis' own chain (id 13863860) where every swap is routed through the
 *    stable pools ("octopool"): its Synthesis and Bridge are named in every source call. Its pools,
 *    their token indexes and the synthetic-token map are pinned in `pools.ts`.
 *
 * Chains Symbiosis serves that are not listed here are simply not offered by this module.
 */

export const SYMBIOSIS_API = "https://api.symbiosis.finance/crosschain";
/** Symbiosis' host chain (where synthetic tokens are minted, swapped and burned). */
export const SYMBIOSIS_HOST_CHAIN_ID = 13863860;
export const SYMBIOSIS_HOST = Object.freeze({
  synthesis: "0x45CFd6FB7999328F189aaD2739Fba4Be6C45E5bf",
  bridge: "0x1a039cE63AE35a67Bf0E9F6DbFaE969639D59eC8",
  /** MulticallRouter: the only contract a route's host-chain pool swaps may call. */
  multicallRouter: "0xBbAD2fe9558e55EbfA04b3B5Bff0b6c4E2ffDD2C",
});
/**
 * The aggregator routers a route may swap on before or after the bridge. Together with the V2
 * routers below they are the only third-party contracts this module lets a route approve. Both are non-upgradable, deployed at the same address
 * on every EVM chain listed below, and source-verified there (Sourcify: AggregationRouterV6,
 * MetaAggregationRouterV2). Tron has neither, so a Tron leg never swaps.
 */
export const SYMBIOSIS_AGGREGATORS = Object.freeze({
  oneInchV6: "0x111111125421cA6dc452d289314280a0f8842A65",
  kyberV2: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
});
/**
 * Uniswap-V2-style routers a route may swap on (Symbiosis' own configuration names one per chain):
 * only the ones that are source-verified as a plain V2 `Router02` (Sourcify: PancakeRouter on
 * BNB Chain and Base, UniswapV2Router02 on Polygon) and non-upgradable. Their two exact-input
 * functions are fully decodable: path, receiver and minimum are plain arguments.
 */
export const SYMBIOSIS_V2_ROUTERS: Readonly<Record<number, string>> = Object.freeze({
  56: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  137: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  8453: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86",
});
/**
 * Symbiosis' Unwrapper per chain — `unwrap(amount, to)` pulls the wrapped native token from the
 * caller, unwraps it and sends the coin to `to` — and the wrapped token it is set to (`wrapper()`),
 * read on-chain. Source-verified (Sourcify: Unwrapper); its owner can repoint `wrapper`, which is
 * why the watch list re-reads it.
 */
export const SYMBIOSIS_UNWRAPPERS: Readonly<Record<number, {unwrapper: string; wrapped: string}>> = Object.freeze({
  1: {unwrapper: "0x5ad095DE83693ba063941f2f2C5A0dF02383B651", wrapped: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"},
  10: {unwrapper: "0x88139ad1199e8c78a0804d4bEBF4FbAD89EF9D89", wrapped: "0x4200000000000000000000000000000000000006"},
  42161: {unwrapper: "0x5Eb4ED9F745531221FAE41906e11d37642B15da6", wrapped: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"},
  8453: {unwrapper: "0x8e1d36F9da8CFe842bCf8670A12ACd51c26d195D", wrapped: "0x4200000000000000000000000000000000000006"},
});
/**
 * Symbiosis' own address the API writes as `revertableAddress` whenever a leg touches Tron or
 * TON, and as the default `fallbackReceiver`: their service that reverts a stuck swap. A request
 * cannot replace it on those routes — see the README ("What is still trusted").
 */
export const SYMBIOSIS_REVERTER = "0x67f9b3E561383493B3f874fEAE0c53c2cD23851D";
/** Symbiosis' Portal on TON: the only destination a TON-source jetton transfer may name. */
export const SYMBIOSIS_TON_PORTAL = "EQBZh9CpLZyNlwI7am0PHpVy8T8zdJxAhlG3m3xMi0BoVaUh";
export const SYMBIOSIS_TON_PORTAL_RAW = "0:5987d0a92d9c8d97023b6a6d0f1e9572f13f33749c408651b79b7c4c8b406855";

export const SYMBIOSIS_TRON_CHAIN_ID = 728126428;
export const SYMBIOSIS_TON_CHAIN_ID = 85918;
export const SYMBIOSIS_BTC_CHAIN_ID = 3652501241;

export type SymbiosisFamily = "evm" | "tron" | "ton" | "bitcoin";

export interface SymbiosisChain {
  /** Catalog CAIP-2 id. */
  caip2: string;
  family: SymbiosisFamily;
  /** The chain id Symbiosis' API and contracts use. */
  id: number;
  name: string;
  /** MetaRouterGateway (EVM form; Tron: the 20 bytes of the base58 address). */
  gateway?: string;
  /** MetaRouter the gateway forwards to — read from `gateway.metaRouterExecutorDontApprove()` on-chain, never approved by a user. */
  executor?: string;
  portal?: string;
  bridge?: string;
}

const evm = (id: number, name: string, gateway: string, executor: string, portal: string, bridge: string): SymbiosisChain =>
  Object.freeze({caip2: `eip155:${id}`, family: "evm" as const, id, name, gateway, executor, portal, bridge});

const LIST: readonly SymbiosisChain[] = [
  evm(1, "Ethereum", "0xB4769e9c5bE31199a25ecD1B0C6609183fa72521", "0xc227b3a439EE6ae3A22500757125f4dE91d8008E", "0xb8f275fBf7A959F4BCE59999A2EF122A099e81A8", "0x5523985926Aa12BA58DC5Ad00DDca99678D7227E"),
  evm(56, "BNB Chain", "0x851B43189de721dD94AbA767AAd9E6F6d6a95CCA", "0x980447DdcEf79A7499Da4538Da8FC59BAcAD6997", "0x5Aa5f7f84eD0E5db0a4a85C3947eA16B53352FD4", "0xb8f275fBf7A959F4BCE59999A2EF122A099e81A8"),
  evm(43114, "Avalanche", "0xfeC09BE39F82b13471D2e0E7d72e6ee589c631c6", "0x4494b8cBC69c794d82Bd2d820A6ff6f62D7D841A", "0xE75C7E85FE6ADd07077467064aD15847E6ba9877", "0x292fC50e4eB66C3f6514b9E402dBc25961824D62"),
  evm(137, "Polygon", "0x2eE9559387b806E88fd46b9DA160D64A29CE7Da0", "0x7a73a0bA4919778C5442f026bd01795b4f2A4cB8", "0xb8f275fBf7A959F4BCE59999A2EF122A099e81A8", "0x5523985926Aa12BA58DC5Ad00DDca99678D7227E"),
  evm(42161, "Arbitrum", "0x3743c756b64ECd0770f1d4f47696A73d2A46dcbe", "0xf37E321e1c275d249B7A9c825aE802A9f464Eb94", "0x01A3c8E513B758EBB011F7AFaf6C37616c9C24d9", "0x5523985926Aa12BA58DC5Ad00DDca99678D7227E"),
  evm(10, "Optimism", "0xA9A96Ee51dD54B9f51d46b1fbD2A19c1295Ec75b", "0x356d322BF762d4022D8c241428770565f236c2EA", "0x292fC50e4eB66C3f6514b9E402dBc25961824D62", "0x5523985926Aa12BA58DC5Ad00DDca99678D7227E"),
  evm(8453, "Base", "0xa18348e793E77239EC68CAa51b74c5Cdc82c8a9d", "0xCbFD5DcaD860f49D0BD2fDaD78d9d943CAeBedef", "0xEE981B2459331AD268cc63CE6167b446AF4161f8", "0x8097f0B9f06C27AF9579F75762F971D745bb222F"),
  Object.freeze({
    caip2: "tron:728126428", family: "tron" as const, id: SYMBIOSIS_TRON_CHAIN_ID, name: "Tron",
    gateway: "0x98e1df4e3200e1001610365e2eb133a953bbe3e0", // TPuaJ6gnYfE9gLUDFrbWbPx3tMnjG8max1
    executor: "0xd076ab0d4b74aef1aec7b1d4f106787e0d5f9163",
    portal: "0x21fb7f70b95d119f7594267a79e2897290a21caf", // TD4tamFrCq7KvQEB1LArNXr9sKFC6GaAmt
    bridge: "0x9c4C6918f9d4CfC4B7C9cF080ce3C4D50B948323",
  }),
  Object.freeze({caip2: "ton:-239", family: "ton" as const, id: SYMBIOSIS_TON_CHAIN_ID, name: "TON"}),
  Object.freeze({caip2: "bitcoin:mainnet", family: "bitcoin" as const, id: SYMBIOSIS_BTC_CHAIN_ID, name: "Bitcoin"}),
];

/** By catalog CAIP-2 id. */
export const SYMBIOSIS_CHAINS: Readonly<Record<string, SymbiosisChain>> = Object.freeze(Object.fromEntries(LIST.map((c) => [c.caip2, c])));
/** By Symbiosis chain id. */
export const SYMBIOSIS_BY_ID: Readonly<Record<number, SymbiosisChain>> = Object.freeze(Object.fromEntries(LIST.map((c) => [c.id, c])));

/** The chain entry for a CAIP-2 id an account or the catalog uses (`tron:0x2b6653dc` and `tron:728126428` are one chain). */
export function symbiosisChain(caip2: string): SymbiosisChain | undefined {
  return SYMBIOSIS_CHAINS[catalogChainId(caip2)];
}

// ── Addresses ────────────────────────────────────────────────────────────────

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A Tron base58check address (`T…`) as the 20-byte EVM form the contracts and the API use; null for anything else. */
export function tronToEvm(address: string): string | null {
  if (typeof address !== "string" || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return null;
  let b: Uint8Array;
  try { b = base58.decode(address); } catch { return null; }
  if (b.length !== 25 || b[0] !== 0x41) return null;
  const check = sha256(sha256(b.subarray(0, 21))).subarray(0, 4);
  if (hex(check) !== hex(b.subarray(21))) return null;
  return getAddress(`0x${hex(b.subarray(1, 21))}`);
}

/** The base58check spelling (`T…`) of a 20-byte address. */
export function evmToTron(address: string): string {
  if (!isAddress(address, {strict: false})) throw new Error(`symbiosis: not a 20-byte address: ${address}`);
  const body = new Uint8Array(21);
  body[0] = 0x41;
  const raw = address.slice(2);
  for (let i = 0; i < 20; i++) body[i + 1] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  const out = new Uint8Array(25);
  out.set(body);
  out.set(sha256(sha256(body)).subarray(0, 4), 21);
  return base58.encode(out);
}

/**
 * The 20 bytes an account or contract is named by inside Symbiosis calldata, lowercase hex with
 * `0x`: an EVM address as it is, a Tron address without its 0x41 prefix. Null for another family
 * or a malformed address.
 */
export function account20(chain: SymbiosisChain, address: string): string | null {
  if (chain.family === "evm") return typeof address === "string" && isAddress(address) ? address.toLowerCase() : null;
  if (chain.family === "tron") return tronToEvm(address)?.toLowerCase() ?? null;
  return null;
}

/** Whether `address` is a well-formed address of the chain's family (EVM hex with a valid checksum, Tron base58check, TON workchain 0). */
export function validAddress(chain: SymbiosisChain, address: string): boolean {
  if (typeof address !== "string" || address.length === 0 || address.length > 128) return false;
  if (chain.family === "evm") return isAddress(address) && !/^0x0{40}$/i.test(address);
  if (chain.family === "tron") return tronToEvm(address) !== null;
  if (chain.family === "ton") return (tonRawAddress(address) ?? "").startsWith("0:");
  // bech32 / bech32m / base58 — only the shape; a Bitcoin address is never a destination here.
  return /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address);
}

/**
 * How Symbiosis names a token: EVM contracts as they are, Tron contracts in 20-byte form, a TON
 * jetton by the last 20 bytes of its master's hash plus the master itself in `attributes.ton`
 * (the rule their token list follows for every TON entry), the native coin as an empty string.
 */
export function symbiosisToken(chain: SymbiosisChain, contract: string | null | undefined): {address: string; ton?: string} | null {
  if (!contract) return {address: ""};
  if (chain.family === "evm") return isAddress(contract) ? {address: getAddress(contract)} : null;
  if (chain.family === "tron") { const a = tronToEvm(contract); return a ? {address: a.toLowerCase()} : null; }
  if (chain.family === "ton") {
    const raw = tonRawAddress(contract);
    if (!raw || !raw.startsWith("0:")) return null;
    return {address: getAddress(`0x${raw.slice(-40)}`), ton: contract};
  }
  return null;
}

export const symbiosis = Object.freeze({
  /** A chain this module knows (as a source or a destination). */
  supportsChain: (caip2: string): boolean => symbiosisChain(caip2) !== undefined,
  /** Two different chains this module knows; Bitcoin is never a destination. */
  supports(fromChain: string, toChain: string): boolean {
    const a = symbiosisChain(fromChain);
    const b = symbiosisChain(toChain);
    return !!a && !!b && a !== b && b.family !== "bitcoin";
  },
});

/** The gateway of a chain in the spelling a wallet of that family uses (EVM checksum / Tron base58). */
export function gatewayAddress(chain: SymbiosisChain): string | null {
  if (!chain.gateway) return null;
  return chain.family === "tron" ? evmToTron(chain.gateway) : getAddress(chain.gateway);
}
