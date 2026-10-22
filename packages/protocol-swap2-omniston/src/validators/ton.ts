import "../buffer-global.js";
import {Buffer} from "buffer";
import {Address, Cell} from "@ton/core";
import type {OmnistonProviderOptions} from "../provider.js";
import type {TonSwapLeg} from "../ton-swap.js";

const JETTON_TRANSFER_OP = 0x0f8a7ea5;
const ESCROW_CREATE_OP = 0xc0a5f0d9;
const ESCROW_CONFIG_OP = 0xf2c6fa63;
const ESCROW_EXECUTION_KECCAK_OP = 0xc8d4b428;
const MAX_FORWARD_NANO = 2_000_000_000n;

/** Audited from the active mainnet Escrow builder on 2026-08-13. These are
 * immutable TVM code cells, not resolver-controlled addresses. A contract
 * upgrade must deliberately update these hashes after reviewing its schema.
 *
 * `authorityKeys` is the optional 256-bit public key in the escrow config: the
 * escrow code checks `CHKSIGNU` against it for its signature-gated operations
 * (disassembly of code 9e77cb9e…, 2026-10-11). It has been the same key since
 * the August audit, so it stays pinned. */
export const DEFAULT_OMNISTON_TON_CODE_HASHES = {
  escrow: ["9e77cb9e8fd7406d4e85e5f57378eb51e51b862424cf988306c783d50ade697a"],
  execution: ["f6edbc76e6fbcd6bac573cb942401a3d9198ee9605f9403b0f5c8081259210e5"],
  authorityKeys: ["ed210da12aa96ea42de4f2f61dc172bbaa3da86051a1b2a6f342f69a777d2770"],
  /** EVM→TON output position: the contract the factory deploys for the
   *  resolver's jetton lock (observed on every resolver-created position,
   *  2026-10-15/16), and the escrow code cell it carries in its state. */
  position: ["e4d5115a321ade7b827e38fb522c20d2f2cd46e4c6b0b5f7dd8b6b096792d77b"],
  outputEscrow: ["d30423575384773abaad8d3c6f763898afa3d57a5693005904b7c61e95cee630"],
} as const;

/** The factory's message that installs a position's state (op of the deploy
 *  message every resolver-created output position received, 2026-10-15). */
const POSITION_DEPLOY_OP = "0xf240cd30";
/** Position timelocks after deploy: withdrawal, public withdrawal, cancellation
 *  (the EVM extension's dst timelocks 1/120/180; the position stores absolute
 *  timestamps = deploy time + stage, with the first one rounded 1 s later). */
const POSITION_STAGES = {publicWithdrawalAfterWithdrawal: 119n, cancellationAfterWithdrawal: 179n};
/** Disclosure is refused this close to the position's cancellation boundary:
 *  after it the resolver can take the jettons back while it already holds the
 *  secret for the EVM source escrow. */
const OUTPUT_DISCLOSURE_MARGIN_SECONDS = 45;

/** Upper bound on the exclusivity window the escrow config may carry. It is
 * how long the trader's input stays locked when no resolver reserves the
 * position (SDK: "at the end of this period trader's position becomes
 * available for manual withdrawal"); the live value is 300 s. */
export const MAX_OMNISTON_EXCLUSIVITY_SECONDS = 3_600;

// `exclusivityTimeout` optional: the parked web path still runs a module build
// that predates it (validatePayload refuses when it is absent).
type PayloadInput = Omit<Parameters<NonNullable<OmnistonProviderOptions["validateTonEscrowPayload"]>>[0], "exclusivityTimeout"> & {
  exclusivityTimeout?: number;
};

/** Code interfaces (tonapi's by-code-hash labels) a same-chain swap message
 *  may pay into. The resolver picks the pool/vault per route, so the check is
 *  "a STON.fi or DeDust contract by code", not a fixed address list — seen
 *  live: native GRAM → DeDust CPMM v2 pool, jettons → STON.fi router v2. */
export const DEFAULT_OMNISTON_TON_SWAP_INTERFACES = [
  "stonfi_router",
  "stonfi_router_v2",
  "stonfi_pool",
  "stonfi_pool_v2",
  "dedust_vault",
  "dedust_v2_cpmm",
  "dedust_pool",
] as const;

/** Proxy-TON (pTON) jetton masters STON.fi routes native TON through. A
 *  native-input swap pays the ROUTER'S pTON wallet — a plain `jetton_wallet`
 *  to tonapi, no DEX code interface — so such a target is accepted only when
 *  its jetton master is pTON AND its owner carries a DEX router interface.
 *  Seen live 2026-09-05: GRAM → USDT on StonFiV2 targeted the router's pTON
 *  v2 wallet and the code-interface check alone refused it. */
export const DEFAULT_OMNISTON_TON_PROXY_TON_MASTERS = [
  "EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsBc_DhVfRRtOEffLez", // pTON v1
  "EQBnGWMCf3-FZZq1W4IWcWiGAc3PHuZ0_H-7sad2oY00o83S", // pTON v2
] as const;

export interface OmnistonTonValidationOptions {
  fetch?: typeof fetch;
  /** Diagnostics hook: every refusal of validateTonOutputPosition names its check (never a secret). */
  onRefusal?: (reason: string, details?: Record<string, unknown>) => void;
  tonApiUrl?: string;
  tonApiKey?: string;
  /** Code interfaces accepted as swap targets (default: the STON.fi / DeDust set above). */
  swapTargetInterfaces?: readonly string[];
  /** Proxy-TON masters whose router-owned wallets may receive native input (default: pTON v1/v2). */
  proxyTonMasters?: readonly string[];
  escrowCodeHashes?: readonly string[];
  executionCodeHashes?: readonly string[];
  /** Pinned escrow authority public keys (hex, 32 bytes). */
  authorityKeys?: readonly string[];
  /** EVM→TON output position code hashes (default: the observed factory position). */
  positionCodeHashes?: readonly string[];
  /** Escrow code cells an output position may carry (default: the observed one). */
  outputEscrowCodeHashes?: readonly string[];
  now?: () => number;
}

export type TonOutputPositionInput = Parameters<NonNullable<OmnistonProviderOptions["validateTonOutputPosition"]>>[0];

function cellFromApi(value: string): Cell {
  const roots = Cell.fromBoc(Buffer.from(value, /^b5ee9c/i.test(value) ? "hex" : "base64"));
  if (roots.length !== 1) throw new Error("omniston TON validator: account cell must have one root");
  return roots[0]!;
}

/**
 * EVM→TON output position, as the factory writes it (decoded from live
 * resolver-created positions, 2026-10-15/16 — every field is checked in its
 * slot, nothing is located by search):
 *
 *   data: phase:uint8 quoteId:bits256 factory:MsgAddressStd
 *         jettonWallet:MsgAddressStd (the factory's wallet of the output
 *         jetton — custody stays there) flags:bits5
 *     ref0: owner:MsgAddressStd (resolver) jettonMaster:MsgAddressStd bits6
 *       ref0: fee profile (constant, not security-relevant)
 *       ref1: jettonWallet, gas, owner
 *     ref1: hashlock:bits256 amount:Coins withdrawalAt:uint64
 *           publicWithdrawalAt:uint64 cancellationAt:uint64
 *       ref0: recipient:MsgAddressStd resolver:MsgAddressStd deposit:Coins
 *       ref1: authority:(Maybe bits256) recipient:MsgAddressStd
 *     ref2: escrow code cell
 */
let lastStateRefusal: string | null = null;
function validateOutputPositionState(
  data: Cell,
  input: TonOutputPositionInput,
  expected: {jettonWallet: string; trusted: {outputEscrow: ReadonlySet<string>; authorityKeys: ReadonlySet<string>}; nowSeconds: number},
): {withdrawalAt: bigint} | null {
  if (!/^[0-9a-fA-F]{48,64}$/.test(input.quoteId) || input.secretHash.length !== 32) { lastStateRefusal = "state#1: if (!/^[0-9a-fA-F]{48,64}$/.test(input.quoteId) || input.secretHash.length !== 32) return null;"; return null; }
  if (!/^\d+$/.test(input.resolverSendsUnits) || !/^\d+$/.test(input.outputUnits) || !/^\d+$/.test(input.dstSecurityDepositUnits)) { lastStateRefusal = "state#2: if (!/^\\d+$/.test(input.resolverSendsUnits) || !/^\\d+$/.test(input.outputUnits) || !/^\\d+$/.test(inp"; return null; }
  if (data.refs.length !== 3) { lastStateRefusal = "state#3: if (data.refs.length !== 3) return null;"; return null; }
  const root = data.beginParse();
  root.loadUint(8); // phase — not trusted for custody; the factory deploy + timelocks are
  if (!sameHex(root.loadBuffer(32), input.quoteId.padStart(64, "0"))) { lastStateRefusal = "state#4: if (!sameHex(root.loadBuffer(32), input.quoteId.padStart(64, \"0\"))) return null;"; return null; }
  if (!sameAddress(root.loadAddressAny(), input.protocolAddress)) { lastStateRefusal = "state#5: if (!sameAddress(root.loadAddressAny(), input.protocolAddress)) return null;"; return null; }
  if (!sameAddress(root.loadAddressAny(), expected.jettonWallet)) { lastStateRefusal = "state#6: if (!sameAddress(root.loadAddressAny(), expected.jettonWallet)) return null;"; return null; }
  // Root tail: 5 bits once the position is settled or rolled back (tag 2 / 3 — the shape the
  // fixtures were cut from), 29 bits while it is live and awaiting completion (tag 1, live
  // 2026-10-20 on every Base → TON position; the 24 extra bits are not fund-critical — every
  // binding field is checked in the refs below). Any other width is a foreign layout.
  if ((root.remainingBits !== 5 && root.remainingBits !== 29) || root.remainingRefs !== 3) { lastStateRefusal = `state#7: root tail ${root.remainingBits} bits / ${root.remainingRefs} refs`; return null; }

  const parties = data.refs[0]!;
  if (parties.refs.length !== 2) { lastStateRefusal = "state#8: if (parties.refs.length !== 2) return null;"; return null; }
  const partySlice = parties.beginParse();
  if (!(partySlice.loadAddressAny() instanceof Address)) { lastStateRefusal = "state#9: if (!(partySlice.loadAddressAny() instanceof Address)) return null; // owner (resolver) — any"; return null; } // owner (resolver) — any
  if (!sameAddress(partySlice.loadAddressAny(), input.outputJettonMasterAddress)) { lastStateRefusal = "state#10: if (!sameAddress(partySlice.loadAddressAny(), input.outputJettonMasterAddress)) return null;"; return null; }
  if (partySlice.remainingBits !== 6) { lastStateRefusal = "state#11: if (partySlice.remainingBits !== 6) return null;"; return null; }

  const lock = data.refs[1]!;
  if (lock.refs.length !== 2) { lastStateRefusal = "state#12: if (lock.refs.length !== 2) return null;"; return null; }
  const lockSlice = lock.beginParse();
  if (!Buffer.from(lockSlice.loadBuffer(32)).equals(Buffer.from(input.secretHash))) { lastStateRefusal = "state#13: if (!Buffer.from(lockSlice.loadBuffer(32)).equals(Buffer.from(input.secretHash))) return null;"; return null; }
  if (lockSlice.loadCoins() < BigInt(input.resolverSendsUnits)) { lastStateRefusal = "state#14: if (lockSlice.loadCoins() < BigInt(input.resolverSendsUnits)) return null;"; return null; }
  const withdrawalAt = lockSlice.loadUintBig(64);
  const publicWithdrawalAt = lockSlice.loadUintBig(64);
  const cancellationAt = lockSlice.loadUintBig(64);
  if (lockSlice.remainingBits !== 0) { lastStateRefusal = "state#15: if (lockSlice.remainingBits !== 0) return null; // its two refs are the terms and authority cells be"; return null; } // its two refs are the terms and authority cells below
  if (publicWithdrawalAt - withdrawalAt !== POSITION_STAGES.publicWithdrawalAfterWithdrawal) { lastStateRefusal = "state#16: if (publicWithdrawalAt - withdrawalAt !== POSITION_STAGES.publicWithdrawalAfterWithdrawal) return nu"; return null; }
  if (cancellationAt - withdrawalAt !== POSITION_STAGES.cancellationAfterWithdrawal) { lastStateRefusal = "state#17: if (cancellationAt - withdrawalAt !== POSITION_STAGES.cancellationAfterWithdrawal) return null;"; return null; }
  // Deployed after the quote (resolvers lock within minutes of the fill) and
  // still far enough from cancellation to be completed.
  if (withdrawalAt < BigInt(input.quoteTimestamp) - 120n || withdrawalAt > BigInt(input.quoteTimestamp) + 900n) { lastStateRefusal = "state#18: if (withdrawalAt < BigInt(input.quoteTimestamp) - 120n || withdrawalAt > BigInt(input.quoteTimestamp"; return null; }
  if (BigInt(expected.nowSeconds + OUTPUT_DISCLOSURE_MARGIN_SECONDS) >= cancellationAt) { lastStateRefusal = "state#19: if (BigInt(expected.nowSeconds + OUTPUT_DISCLOSURE_MARGIN_SECONDS) >= cancellationAt) return null;"; return null; }

  const terms = lock.refs[0]!.beginParse();
  if (!sameAddress(terms.loadAddressAny(), input.recipientAddress)) { lastStateRefusal = "state#20: if (!sameAddress(terms.loadAddressAny(), input.recipientAddress)) return null;"; return null; }
  if (!(terms.loadAddressAny() instanceof Address)) { lastStateRefusal = "state#21: if (!(terms.loadAddressAny() instanceof Address)) return null; // resolver — any"; return null; } // resolver — any
  if (terms.loadCoins() !== BigInt(input.dstSecurityDepositUnits) || !exactCellEnd(terms)) { lastStateRefusal = "state#22: if (terms.loadCoins() !== BigInt(input.dstSecurityDepositUnits) || !exactCellEnd(terms)) return null"; return null; }

  const authority = lock.refs[1]!.beginParse();
  if (!authority.loadBit() || !expected.trusted.authorityKeys.has(Buffer.from(authority.loadBuffer(32)).toString("hex"))) { lastStateRefusal = "state#23: if (!authority.loadBit() || !expected.trusted.authorityKeys.has(Buffer.from(authority.loadBuffer(32)"; return null; }
  // Authority address: the trader's TON address on TON-source positions; `addr_none` on EVM-source
  // positions (live 2026-10-20, every Base → TON order) — the payout target is bound in the terms cell
  // above, and the pinned authority key is what the public path checks. Anything else is foreign.
  const authorityAddress = authority.loadAddressAny();
  if ((authorityAddress !== null && !sameAddress(authorityAddress, input.recipientAddress)) || !exactCellEnd(authority)) { lastStateRefusal = "state#24: if ((authorityAddress !== null && !sameAddress(authorityAddress, input.recipientAddress)) || !exactC"; return null; }

  if (!expected.trusted.outputEscrow.has(data.refs[2]!.hash().toString("hex"))) { lastStateRefusal = "state#25: if (!expected.trusted.outputEscrow.has(data.refs[2]!.hash().toString(\"hex\"))) return null;"; return null; }
  return {withdrawalAt};
}

function oneRoot(hex: string, label: string): Cell {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error(`omniston TON validator: malformed ${label} hex`);
  const roots = Cell.fromBoc(Buffer.from(hex, "hex"));
  if (roots.length !== 1) throw new Error(`omniston TON validator: ${label} must have one root`);
  return roots[0]!;
}

function sameAddress(actual: unknown, expected: string): boolean {
  try {
    return actual instanceof Address && actual.equals(Address.parse(expected));
  } catch {
    return false;
  }
}

function sameHex(actual: Uint8Array, expected: string): boolean {
  const clean = expected.replace(/^0x/, "").toLowerCase();
  return clean.length === actual.length * 2 && Buffer.from(actual).toString("hex") === clean;
}

function exactCellEnd(slice: {remainingBits: number; remainingRefs: number}): boolean {
  return slice.remainingBits === 0 && slice.remainingRefs === 0;
}

function destinationChainId(chain: string): bigint | null {
  const ids: Record<string, bigint> = {
    ethereum: 1n,
    bnb: 56n,
    polygon: 137n,
    robinhood: 4663n,
    base: 8453n,
    arbitrum: 42161n,
    avalanche: 43114n,
    xlayer: 196n,
    hyperevm: 999n,
    plasma: 9745n,
  };
  return ids[chain] ?? null;
}

function validatePayload(input: PayloadInput, trusted: {
  escrow: ReadonlySet<string>;
  execution: ReadonlySet<string>;
  authorityKeys: ReadonlySet<string>;
}): boolean {
  // Read structurally so this stays type-compatible with module builds that
  // predate the field; absent → refused below.
  const exclusivityTimeout = (input as {exclusivityTimeout?: unknown}).exclusivityTimeout;
  if (
    typeof exclusivityTimeout !== "number" || !Number.isSafeInteger(exclusivityTimeout) ||
    exclusivityTimeout < 1 || exclusivityTimeout > MAX_OMNISTON_EXCLUSIVITY_SECONDS
  ) return false;
  if (
    !/^\d+$/.test(input.inputUnits) || !/^\d+$/.test(input.resolverSendsUnits) ||
    !/^\d+$/.test(input.srcHtlcSecurityDepositUnits) || !/^[0-9a-fA-F]{48,64}$/.test(input.quoteId) ||
    input.secretHashes.length !== 1 || input.secretHashes[0]?.length !== 32 ||
    input.hashingFunction !== "HASHING_FUNCTION_KECCAK256"
  ) return false;

  const payload = oneRoot(input.payloadBocHex, "payload");
  const outer = payload.beginParse();
  if (outer.loadUint(32) !== JETTON_TRANSFER_OP) return false;
  outer.loadUintBig(64); // query id is intentionally wallet/resolver-selected
  if (outer.loadCoins() !== BigInt(input.inputUnits)) return false;
  if (!sameAddress(outer.loadAddressAny(), input.protocolAddress)) return false;
  if (!sameAddress(outer.loadAddressAny(), input.ownerAddress)) return false;
  if (outer.loadMaybeRef() !== null) return false;
  const forwardNano = outer.loadCoins();
  if (forwardNano <= 0n || forwardNano > MAX_FORWARD_NANO || !outer.loadBit()) return false;
  if (outer.remainingBits !== 0 || outer.remainingRefs !== 1) return false;
  const embeddedForward = outer.loadRef();
  const forward = oneRoot(input.forwardPayloadBocHex, "forward payload");
  if (!embeddedForward.hash().equals(forward.hash())) return false;

  const root = forward.beginParse();
  if (root.loadUint(32) !== ESCROW_CREATE_OP || !sameHex(root.loadBuffer(32), input.quoteId.padStart(64, "0"))) return false;
  if (root.loadBit() || !sameAddress(root.loadAddressAny(), input.ownerAddress)) return false;
  const escrowForwardNano = root.loadCoins();
  if (escrowForwardNano <= 0n || escrowForwardNano > MAX_FORWARD_NANO || root.loadBit()) return false;
  if (root.remainingBits !== 0 || root.remainingRefs !== 4) return false;
  const [config, escrowCode, auxiliary, flags] = [root.loadRef(), root.loadRef(), root.loadRef(), root.loadRef()];
  if (!trusted.escrow.has(escrowCode.hash().toString("hex"))) return false;

  // Escrow config, as the escrow code's deploy handler parses it (disassembly
  // of 9e77cb9e…, 2026-10-11):
  //   op:uint32 resolver:MsgAddressStd authority:(Maybe uint256)
  //   exclusivity:uint64 postExclusivity:uint64 state:^Cell
  //   destination:(Maybe ^Cell) parts:uint16
  // On deploy the escrow stores now+exclusivity and now+exclusivity+postExclusivity
  // as its phase boundaries. Every field is checked in its slot; nothing is
  // compared as an opaque blob, so a protocol-side timing change shows up as a
  // named field instead of a silent refusal.
  const configSlice = config.beginParse();
  if (configSlice.loadUint(32) !== ESCROW_CONFIG_OP || !sameAddress(configSlice.loadAddressAny(), input.initialResolverAddress)) return false;
  if (!configSlice.loadBit() || !trusted.authorityKeys.has(Buffer.from(configSlice.loadBuffer(32)).toString("hex"))) return false;
  // Bound to the quote the user accepted: the resolver cannot lengthen the
  // window the trader's funds are locked for without a reservation.
  if (configSlice.loadUintBig(64) !== BigInt(exclusivityTimeout)) return false;
  // A non-zero window after exclusivity is the Dutch-auction phase ("Dutch
  // auction starts if specified by escrow condition"); its price curve is not
  // part of the trader quote, so only the no-auction profile is accepted.
  if (configSlice.loadUintBig(64) !== 0n) return false;
  if (configSlice.remainingRefs !== 2) return false;
  const state = configSlice.loadRef();
  if (!configSlice.loadBit()) return false; // destination is mandatory
  const destination = configSlice.loadRef();
  // 0 = single full fill, which is what the one-hash execution below commits to.
  if (configSlice.loadUint(16) !== 0 || !exactCellEnd(configSlice)) return false;
  if (state.bits.length !== 0 || state.refs.length !== 2) return false;
  if (!trusted.execution.has(state.refs[0]!.hash().toString("hex"))) return false;

  const execution = state.refs[1]!.beginParse();
  if (
    execution.loadUint(32) !== ESCROW_EXECUTION_KECCAK_OP ||
    !Buffer.from(execution.loadBuffer(32)).equals(Buffer.from(input.secretHashes[0]!)) ||
    !sameAddress(execution.loadAddressAny(), input.initialResolverAddress)
  ) return false;
  // Current audited escrow policy: one execution, then 120/240/300-second
  // exclusivity, cancellation and refund boundaries.
  if ([1n, 120n, 240n, 300n].some((expected) => execution.loadUintBig(64) !== expected)) return false;
  if (execution.remainingBits !== 0 || execution.remainingRefs !== 1) return false;
  const ownerData = execution.loadRef().beginParse();
  if (!sameAddress(ownerData.loadAddressAny(), input.ownerAddress) || ownerData.loadBit()) return false;
  if (ownerData.loadCoins() !== BigInt(input.srcHtlcSecurityDepositUnits) || !exactCellEnd(ownerData)) return false;

  const destinationSlice = destination.beginParse();
  const chainId = destinationChainId(input.destinationChain);
  if (chainId === null || destinationSlice.loadUintBig(64) !== chainId) return false;
  if (!sameHex(destinationSlice.loadBuffer(20), input.outputTokenAddress)) return false;
  if (!sameHex(destinationSlice.loadBuffer(20), input.destinationAddress)) return false;
  if (destinationSlice.loadCoins() !== BigInt(input.resolverSendsUnits) || !exactCellEnd(destinationSlice)) return false;

  // These cells contain optional escrow bookkeeping. Their exact shapes and
  // reference counts are part of the reviewed ABI; fund destinations above
  // are never located by byte search.
  if (auxiliary.bits.length !== 537 || auxiliary.refs.length !== 1) return false;
  if (flags.bits.length !== 98 || flags.refs.length !== 0) return false;
  return true;
}

export function createOmnistonTonValidators(options: OmnistonTonValidationOptions = {}): Pick<
  OmnistonProviderOptions,
  "validateTonJettonWallet" | "validateTonSwapTarget" | "validateTonOutputPosition" | "validateTonSwapLeg"
> & {validateTonEscrowPayload: (input: PayloadInput) => boolean | Promise<boolean>} {
  const now = options.now ?? Date.now;
  const swapInterfaces = new Set(options.swapTargetInterfaces ?? DEFAULT_OMNISTON_TON_SWAP_INTERFACES);
  const proxyTonMasters = new Set(
    (options.proxyTonMasters ?? DEFAULT_OMNISTON_TON_PROXY_TON_MASTERS).map((value) => Address.parse(value).toRawString()),
  );
  const request = options.fetch ?? fetch;
  const base = (options.tonApiUrl ?? "https://tonapi.io").replace(/\/$/, "");
  const headers = options.tonApiKey ? {Authorization: `Bearer ${options.tonApiKey}`} : undefined;
  const get = (path: string) => request(`${base}${path}`, {...(headers ? {headers} : {}), signal: AbortSignal.timeout(5_000)});
  /** Same, retrying tonapi's rate limit (keyless: ~1 rps) — the swap-leg
   *  checks run a few reads back to back right after the target checks. */
  const getRetry = async (path: string): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const response = await get(path);
      if (response.status !== 429 || attempt >= 3) return response;
      await new Promise((resolve) => setTimeout(resolve, 1_100 * (attempt + 1)));
    }
  };
  /** A get-method's stack (tonapi), or null when the call failed. */
  const runGet = async (address: string, method: string, args: readonly string[] = []): Promise<{type: string; cell?: string}[] | null> => {
    const query = args.length ? `?${args.map((arg) => `args=${encodeURIComponent(arg)}`).join("&")}` : "";
    const response = await getRetry(`/v2/blockchain/accounts/${encodeURIComponent(address)}/methods/${method}${query}`);
    if (!response.ok) return null;
    const body = await response.json() as {success?: boolean; exit_code?: number; stack?: {type: string; cell?: string}[]};
    return body.success === true && (body.exit_code ?? 0) === 0 && Array.isArray(body.stack) ? body.stack : null;
  };
  const stackCell = (entry: {type: string; cell?: string} | undefined): Cell | null =>
    entry && (entry.type === "cell" || entry.type === "slice") && entry.cell ? cellFromApi(entry.cell) : null;
  /** The jetton wallet a master derives for an owner — computed by the master, not looked up. */
  const derivedWallet = async (master: string, owner: string): Promise<Address | null> => {
    const cell = stackCell((await runGet(master, "get_wallet_address", [Address.parse(owner).toRawString()]))?.[0]);
    return cell ? cell.beginParse().loadAddress() : null;
  };
  /** get_wallet_data of a jetton wallet: owner + master, read from the wallet itself. */
  const walletData = async (wallet: string): Promise<{owner: Address; master: Address} | null> => {
    const stack = await runGet(wallet, "get_wallet_data");
    const owner = stackCell(stack?.[1]);
    const master = stackCell(stack?.[2]);
    return owner && master ? {owner: owner.beginParse().loadAddress(), master: master.beginParse().loadAddress()} : null;
  };
  const accountHas = async (address: string, iface: string): Promise<boolean> => {
    const response = await getRetry(`/v2/accounts/${encodeURIComponent(address)}`);
    if (!response.ok) return false;
    const body = await response.json() as {address?: string; interfaces?: string[]; is_wallet?: boolean};
    return !!body.address && sameAddress(Address.parse(body.address), address) && body.is_wallet !== true && (body.interfaces ?? []).includes(iface);
  };
  /** Unordered pair equality of jetton masters (null = native GRAM). */
  const samePair = (pool: readonly (string | null)[], leg: readonly (string | null)[]): boolean => {
    const key = (value: string | null) => value === null ? "native" : Address.parse(value).toRawString();
    const a = pool.map(key).sort();
    const b = leg.map(key).sort();
    return a.length === 2 && a[0] === b[0] && a[1] === b[1] && a[0] !== a[1];
  };
  /** tonapi's view of a contract: null when unreachable or not the address asked for. */
  const readAccount = async (address: string): Promise<{interfaces: string[]; isWallet: boolean} | null> => {
    const response = await get(`/v2/accounts/${encodeURIComponent(address)}`);
    if (!response.ok) return null;
    const body = await response.json() as {address?: string; interfaces?: string[]; is_wallet?: boolean};
    if (!body.address || !sameAddress(Address.parse(body.address), address)) return null;
    return {interfaces: body.interfaces ?? [], isWallet: body.is_wallet === true};
  };
  const isDexContract = (account: {interfaces: string[]; isWallet: boolean}): boolean =>
    !account.isWallet && account.interfaces.some((name) => swapInterfaces.has(name));
  const trusted = {
    escrow: new Set((options.escrowCodeHashes ?? DEFAULT_OMNISTON_TON_CODE_HASHES.escrow).map((value) => value.toLowerCase())),
    execution: new Set((options.executionCodeHashes ?? DEFAULT_OMNISTON_TON_CODE_HASHES.execution).map((value) => value.toLowerCase())),
    authorityKeys: new Set((options.authorityKeys ?? DEFAULT_OMNISTON_TON_CODE_HASHES.authorityKeys).map((value) => value.toLowerCase())),
    position: new Set((options.positionCodeHashes ?? DEFAULT_OMNISTON_TON_CODE_HASHES.position).map((value) => value.toLowerCase())),
    outputEscrow: new Set((options.outputEscrowCodeHashes ?? DEFAULT_OMNISTON_TON_CODE_HASHES.outputEscrow).map((value) => value.toLowerCase())),
  };
  /** The factory's jetton wallet for a master, from the indexer — the same
   *  lookup the TON-source path uses for the trader's wallet. */
  const jettonWalletOf = async (ownerAddress: string, jettonMasterAddress: string): Promise<string | null> => {
    const response = await get(`/v2/accounts/${encodeURIComponent(ownerAddress)}/jettons/${encodeURIComponent(jettonMasterAddress)}`);
    if (!response.ok) return null;
    const body = await response.json() as {wallet_address?: {address?: string}; jetton?: {address?: string}};
    const wallet = body.wallet_address?.address;
    if (!wallet || (body.jetton?.address !== undefined && !sameAddress(Address.parse(body.jetton.address), jettonMasterAddress))) return null;
    return Address.parse(wallet).toString();
  };

  return {
    async validateTonJettonWallet({ownerAddress, jettonMasterAddress, walletAddress}) {
      try {
        const url = `${base}/v2/accounts/${encodeURIComponent(ownerAddress)}/jettons/${encodeURIComponent(jettonMasterAddress)}`;
        const response = await request(url, {
          ...(headers ? {headers} : {}),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return false;
        const body = await response.json() as {
          wallet_address?: {address?: string};
          jetton?: {address?: string};
        };
        if (!sameAddress(body.wallet_address?.address ? Address.parse(body.wallet_address.address) : null, walletAddress)) return false;
        return body.jetton?.address === undefined || sameAddress(Address.parse(body.jetton.address), jettonMasterAddress);
      } catch {
        return false;
      }
    },
    validateTonEscrowPayload(input: PayloadInput) {
      try {
        return validatePayload(input, trusted);
      } catch {
        return false;
      }
    },
    /**
     * EVM→TON: the position the tracking feed named must be (1) an active
     * contract with the pinned position code, (2) carrying state that binds
     * this quote, hashlock, recipient, output jetton, amount, deposit and the
     * pinned timelocks — still inside the completion window — with jetton
     * custody at the factory's own wallet, and (3) deployed by the trusted
     * factory itself (its deploy message is only sent after the factory's
     * jetton wallet notified it of the resolver's transfer). Nothing here
     * trusts the feed beyond the address it suggested.
     */
    async validateTonOutputPosition(input) {
      const refuse = (reason: string, details?: Record<string, unknown>): false => { try { options.onRefusal?.(reason, details); } catch { /* diagnostics never break validation */ } return false; };
      lastStateRefusal = null;
      try {
        Address.parse(input.positionAddress);
        Address.parse(input.recipientAddress);
        const nowSeconds = Math.floor(now() / 1000);
        if (!Number.isInteger(input.quoteTimestamp) || input.quoteTimestamp > nowSeconds + 120 || nowSeconds - input.quoteTimestamp > 6 * 60 * 60) return refuse("quote-age");
        const accountResponse = await get(`/v2/blockchain/accounts/${encodeURIComponent(input.positionAddress)}`);
        if (!accountResponse.ok) return refuse("account-fetch", {status: accountResponse.status});
        const account = await accountResponse.json() as {address?: string; status?: string; code?: string; data?: string};
        if (!account.address || !sameAddress(Address.parse(account.address), input.positionAddress) || account.status !== "active" || !account.code || !account.data) return refuse("account-state", {status: account.status, hasCode: !!account.code, hasData: !!account.data});
        if (!trusted.position.has(cellFromApi(account.code).hash().toString("hex"))) return refuse("position-code-hash", {hash: cellFromApi(account.code).hash().toString("hex")});
        const jettonWallet = await jettonWalletOf(input.protocolAddress, input.outputJettonMasterAddress);
        if (!jettonWallet) return refuse("jetton-wallet");
        const state = validateOutputPositionState(cellFromApi(account.data), input, {jettonWallet, trusted, nowSeconds});
        if (!state) return refuse("state", {check: lastStateRefusal});
        const txResponse = await get(`/v2/blockchain/accounts/${encodeURIComponent(input.positionAddress)}/transactions?limit=25`);
        if (!txResponse.ok) return refuse("transactions-fetch", {status: txResponse.status});
        const body = await txResponse.json() as {transactions?: {success?: boolean; aborted?: boolean; utime?: number; in_msg?: {source?: {address?: string}; op_code?: string}}[]};
        const deployedByFactory = (body.transactions ?? []).some((tx) =>
          tx.success === true && tx.aborted !== true && tx.in_msg?.op_code?.toLowerCase() === POSITION_DEPLOY_OP &&
          !!tx.in_msg.source?.address && sameAddress(Address.parse(tx.in_msg.source.address), input.protocolAddress) &&
          typeof tx.utime === "number" && Math.abs(Number(state.withdrawalAt) - 1 - tx.utime) <= 5);
        return deployedByFactory || refuse("deploy-transaction", {transactions: (body.transactions ?? []).length});
      } catch (error) {
        return refuse("error", {message: error instanceof Error ? error.message : String(error)});
      }
    },
    /**
     * Scan F11: one chain fact a decoded TON swap body depends on.
     *  - STON.fi hop: the router carries the STON.fi router interface of its
     *    version; for native input the pTON wallet the message pays is a
     *    proxy-TON wallet OWNED BY that router; the hop's ask wallet is the
     *    router's own wallet of the hop's output (of a proxy-TON master for
     *    native output), as the output's master derives it.
     *  - DeDust pool: the pool carries the DeDust pool interface of its version
     *    and trades exactly the hop's pair.
     */
    async validateTonSwapLeg(leg: TonSwapLeg) {
      try {
        if (leg.kind === "stonfi-router") {
          let router = leg.router ? Address.parse(leg.router) : null;
          if (leg.proxyTonWallet) {
            const data = await walletData(leg.proxyTonWallet);
            if (!data || !proxyTonMasters.has(data.master.toRawString())) return false;
            if (router && !router.equals(data.owner)) return false;
            router = data.owner;
          }
          if (!router) return false;
          if (!await accountHas(router.toString(), leg.version === 1 ? "stonfi_router" : "stonfi_router_v2")) return false;
          const masters = leg.outputJetton ? [leg.outputJetton] : [...proxyTonMasters];
          for (const master of masters) {
            const wallet = await derivedWallet(master, router.toString());
            if (wallet && wallet.equals(Address.parse(leg.askWallet))) return true;
          }
          return false;
        }
        if (leg.version === 1) {
          if (!await accountHas(leg.pool, "dedust_pool")) return false;
          const stack = await runGet(leg.pool, "get_assets");
          const assets = [stackCell(stack?.[0]), stackCell(stack?.[1])].map((cell) => {
            if (!cell) return undefined;
            const slice = cell.beginParse();
            const tag = slice.loadUint(4);
            if (tag === 0) return null;
            if (tag !== 1) return undefined;
            return new Address(slice.loadInt(8), slice.loadBuffer(32)).toString();
          });
          if (assets.some((asset) => asset === undefined)) return false;
          return samePair(assets as (string | null)[], [leg.inputJetton, leg.outputJetton]);
        }
        if (!await accountHas(leg.pool, "dedust_v2_cpmm")) return false;
        const stack = await runGet(leg.pool, "get_pool_data");
        const assets = [stackCell(stack?.[3]), stackCell(stack?.[4])].map((cell) => {
          if (!cell) return undefined;
          const address = cell.beginParse().loadAddressAny();
          if (address === null) return null;
          return address instanceof Address ? address.toString() : undefined;
        });
        if (assets.some((asset) => asset === undefined)) return false;
        return samePair(assets as (string | null)[], [leg.inputJetton, leg.outputJetton]);
      } catch {
        return false;
      }
    },
    /** The contract a swap pays into must carry a recognised DEX code
     *  interface on the indexer — an EOA, an unknown contract or a fresh
     *  resolver-deployed proxy is refused. */
    async validateTonSwapTarget({address}) {
      try {
        Address.parse(address);
        const account = await readAccount(address);
        if (!account || account.isWallet) return false;
        if (isDexContract(account)) return true;
        // Native input on STON.fi: the target is the router's proxy-TON jetton
        // wallet. Accept it only as "pTON wallet owned by a DEX router" —
        // both facts read from the chain, never from the quote.
        if (!account.interfaces.includes("jetton_wallet")) return false;
        const data = await get(`/v2/blockchain/accounts/${encodeURIComponent(address)}/methods/get_wallet_data`);
        if (!data.ok) return false;
        const body = await data.json() as {success?: boolean; decoded?: {owner?: string; jetton?: string}};
        const owner = body.decoded?.owner;
        const master = body.decoded?.jetton;
        if (!body.success || !owner || !master || !proxyTonMasters.has(Address.parse(master).toRawString())) return false;
        const ownerAccount = await readAccount(owner);
        return ownerAccount !== null && isDexContract(ownerAccount);
      } catch {
        return false;
      }
    },
  };
}

// ── EVM → TON delivery ───────────────────────────────────────────────────────

export interface OmnistonTonDeliveryLocatorOptions {
  fetch?: typeof fetch;
  tonApiUrl?: string;
  tonApiKey?: string;
  /** Recipient events scanned per call (newest first; the delivery is recent by construction). */
  limit?: number;
}

export interface OmnistonTonDeliveryInput {
  /** The output position that paid out; when absent any sender of a matching transfer counts (backfills). */
  positionAddress?: string;
  recipientAddress: string;
  jettonMasterAddress: string;
  minUnits: string;
  /** Unix seconds; events before it are not this delivery (backfills). With it set, the EARLIEST match wins — the one closest to the order, not a later swap's payout. */
  afterTimestamp?: number;
  /** Unix seconds; events after it are not this delivery (backfills: the row's completion time plus slack). */
  beforeTimestamp?: number;
}

interface TonapiDeliveryEvent {
  event_id?: string;
  timestamp?: number;
  in_progress?: boolean;
  actions?: Array<{
    type?: string;
    status?: string;
    JettonTransfer?: {
      sender?: {address?: string};
      recipient?: {address?: string};
      jetton?: {address?: string};
      amount?: string | number;
    };
  }>;
}

/**
 * Finds an Omniston TON delivery: the jetton transfer from the output position
 * to the recipient of at least `minUnits`, in the recipient's tonapi events.
 * Returns tonapi's `event_id` — the hash `@forgewallet/wallet-ton`'s history
 * source gives the same event as a row, so a wallet can pair the TON receive
 * with the swap. Feeds `omnistonProvider({locateTonDelivery})`; a server may
 * also call it with no position to backfill rows completed before the locator
 * existed. Never throws: null when nothing matched or tonapi did not answer.
 */
export function createOmnistonTonDeliveryLocator(options: OmnistonTonDeliveryLocatorOptions = {}) {
  const request = options.fetch ?? fetch;
  const base = (options.tonApiUrl ?? "https://tonapi.io").replace(/\/$/, "");
  const headers = options.tonApiKey ? {Authorization: `Bearer ${options.tonApiKey}`} : undefined;
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));
  return async (input: OmnistonTonDeliveryInput): Promise<string | null> => {
    try {
      const recipient = Address.parse(input.recipientAddress);
      const master = Address.parse(input.jettonMasterAddress);
      const position = input.positionAddress ? Address.parse(input.positionAddress) : null;
      const min = BigInt(input.minUnits);
      if (min <= 0n) return null;
      const since = Number.isFinite(input.afterTimestamp) ? `&start_date=${Math.max(0, Math.floor(input.afterTimestamp!))}` : "";
      const until = Number.isFinite(input.beforeTimestamp) ? `&end_date=${Math.max(0, Math.floor(input.beforeTimestamp!))}` : "";
      const url = `${base}/v2/accounts/${encodeURIComponent(recipient.toString())}/events?limit=${limit}${since}${until}`;
      const response = await request(url, {...(headers ? {headers} : {}), signal: AbortSignal.timeout(8_000)});
      if (!response.ok) return null;
      const body = await response.json() as {events?: TonapiDeliveryEvent[]};
      // tonapi lists newest first. With a position the newest match is the delivery; a
      // windowed backfill wants the earliest match instead (a later swap's payout to the
      // same recipient would otherwise be taken for this one).
      const events = [...(body.events ?? [])];
      if (input.afterTimestamp !== undefined) events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      for (const event of events) {
        if (!event.event_id || event.in_progress === true) continue;
        if (input.afterTimestamp !== undefined && typeof event.timestamp === "number" && event.timestamp < input.afterTimestamp) continue;
        if (input.beforeTimestamp !== undefined && typeof event.timestamp === "number" && event.timestamp > input.beforeTimestamp) continue;
        for (const action of event.actions ?? []) {
          if (action.type !== "JettonTransfer" || action.status !== "ok") continue;
          const t = action.JettonTransfer;
          if (!t?.jetton?.address || !t.recipient?.address || t.amount === undefined) continue;
          if (!sameAddress(Address.parse(t.jetton.address), master.toString())) continue;
          if (!sameAddress(Address.parse(t.recipient.address), recipient.toString())) continue;
          if (position && (!t.sender?.address || !sameAddress(Address.parse(t.sender.address), position.toString()))) continue;
          let amount: bigint;
          try {
            amount = BigInt(t.amount);
          } catch {
            continue;
          }
          if (amount < min) continue;
          return event.event_id.toLowerCase();
        }
      }
      return null;
    } catch {
      return null;
    }
  };
}
