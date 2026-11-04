/**
 * What the LI.FI Diamond call really does, read from its calldata — not from the `action` /
 * `estimate` next to it (round 3, H9). The API (or an `apiUrl` proxy) could pair a reviewed
 * recipient and minimum with calldata that pays someone else, or accepts 1 wei.
 *
 * Same-chain swaps run through GenericSwapFacet(V3): receiver, minimum, the input token and amount,
 * and the output token are in the arguments. Bridges take `ILiFi.BridgeData` as their first
 * argument: its receiver, destination chain and bridged asset are checked, for the listed bridge
 * entry points only; a destination call (the final recipient sits in calldata for another chain)
 * and a non-EVM destination (the receiver sits in facet-specific data) are refused.
 *
 * A facet's own data also names who gets money back — unused native fee, swap leftovers, the whole input when an
 * order expires unfilled, a fallback when delivery fails ({@link FACET_DATA}); each such address must be the sender or
 * the recipient.
 *
 * Mostly not checked here: a bridge's OUTPUT. The destination minimum (and for some bridges, e.g.
 * Across, what the receiver finally gets) lives in facet-specific data, so for most bridges the
 * reviewed minimum still relies on LI.FI's API answering honestly. Eco and M0 are the exceptions
 * ({@link FacetData.delivery}): their facet data names the destination token, amount and (Eco) recipient
 * outright, and those are held to the quote.
 *
 * The receiver is only worth checking where the facet itself holds the bridge to it. Most do on
 * chain (Across V4, Mayan, Stargate, Chainflip, LI.FI Intents, GasZip, Glacis, AllBridge, M0, Polymer
 * CCTP) or through LI.FI's backend signature over BridgeData plus the off-chain order (NEAR Intents,
 * LayerSwap, Unit, the Across Swap API). Eco v3 binds its route to BridgeData.receiver by that signature
 * only, so the route itself is read here ({@link ecoDelivery}). The facets in {@link UNBOUND_BRIDGES} do
 * neither and are refused.
 */

/**
 * The V3 entry points move one asset kind in and one out, and check the minimum against THAT kind's balance: a
 * `*ToNative` call measures the Diamond's native balance, so a minimum written in USDC units is enforced in wei
 * (scan 2026-10-27 modules, F20). Each selector is bound to the kinds it moves; `swapTokensGeneric` moves any.
 */
type Kind = "native" | "erc20";
const GENERIC_SWAPS: Readonly<Record<string, {single: boolean; from?: Kind; to?: Kind}>> = {
  "0x4630a0d8": {single: false}, // swapTokensGeneric
  "0x4666fc80": {single: true, from: "erc20", to: "erc20"}, // swapTokensSingleV3ERC20ToERC20
  "0x733214a3": {single: true, from: "erc20", to: "native"}, // swapTokensSingleV3ERC20ToNative
  "0xaf7060fd": {single: true, from: "native", to: "erc20"}, // swapTokensSingleV3NativeToERC20
  "0x5fd9ae2e": {single: false, from: "erc20", to: "erc20"}, // swapTokensMultipleV3ERC20ToERC20
  "0x2c57e884": {single: false, from: "erc20", to: "native"}, // swapTokensMultipleV3ERC20ToNative
  "0x736eac0b": {single: false, from: "native", to: "erc20"}, // swapTokensMultipleV3NativeToERC20
};
/** The most a bridge may keep from the input as its own fee when there are no source swaps, in basis points. */
const BRIDGE_INPUT_FEE_MAX_BPS = 100n;
const kindOf = (asset: string): Kind => (/^0x0{40}$/i.test(asset) ? "native" : "erc20");

/**
 * The ABI-encoded bridge entry points of the LI.FI Diamond — `startBridgeTokensVia*` and
 * `swapAndStartBridgeTokensVia*`, whose first argument is `ILiFi.BridgeData` — computed from the
 * facet sources in lifinance/contracts (86c3729, 2026-10-26; EcoFacet v3.0.0 from 9001792, 2026-11-01, whose
 * EcoData gained `intentDestination` — the v2 selectors 0xbff90b61 / 0x762aea18 are gone from the Diamonds). Packed
 * facets and `*Min` variants read raw calldata, not BridgeData, and are not listed: any other selector is refused.
 */
const BRIDGE_CALLS: Readonly<Record<string, {sourceSwaps: boolean; facet: string}>> = {
  "0x1fd8010c": {sourceSwaps: false, facet: "Across"}, // startBridgeTokensViaAcross (AcrossFacet)
  "0x3a3f7332": {sourceSwaps: true, facet: "Across"}, // swapAndStartBridgeTokensViaAcross (AcrossFacet)
  "0xa1f1ce43": {sourceSwaps: false, facet: "AcrossV4"}, // startBridgeTokensViaAcrossV4 (AcrossFacetV4)
  "0x1794958f": {sourceSwaps: true, facet: "AcrossV4"}, // swapAndStartBridgeTokensViaAcrossV4 (AcrossFacetV4)
  "0x6a90d66e": {sourceSwaps: false, facet: "AcrossV4Swap"}, // startBridgeTokensViaAcrossV4Swap (AcrossV4SwapFacet)
  "0x9b054bc4": {sourceSwaps: true, facet: "AcrossV4Swap"}, // swapAndStartBridgeTokensViaAcrossV4Swap (AcrossV4SwapFacet)
  "0x6a51e9a9": {sourceSwaps: false, facet: "AllBridge"}, // startBridgeTokensViaAllBridge (AllBridgeFacet)
  "0x63267469": {sourceSwaps: true, facet: "AllBridge"}, // swapAndStartBridgeTokensViaAllBridge (AllBridgeFacet)
  "0xc9851d0b": {sourceSwaps: false, facet: "ArbitrumBridge"}, // startBridgeTokensViaArbitrumBridge (ArbitrumBridgeFacet)
  "0x3cc9517b": {sourceSwaps: true, facet: "ArbitrumBridge"}, // swapAndStartBridgeTokensViaArbitrumBridge (ArbitrumBridgeFacet)
  "0xe0a4201c": {sourceSwaps: false, facet: "CelerCircleBridge"}, // startBridgeTokensViaCelerCircleBridge (CelerCircleBridgeFacet)
  "0x4f3b0759": {sourceSwaps: true, facet: "CelerCircleBridge"}, // swapAndStartBridgeTokensViaCelerCircleBridge (CelerCircleBridgeFacet)
  "0x0315138f": {sourceSwaps: false, facet: "Centrifuge"}, // startBridgeTokensViaCentrifuge (CentrifugeFacet)
  "0x8fd4d4dd": {sourceSwaps: true, facet: "Centrifuge"}, // swapAndStartBridgeTokensViaCentrifuge (CentrifugeFacet)
  "0x0ad553b3": {sourceSwaps: false, facet: "Chainflip"}, // startBridgeTokensViaChainflip (ChainflipFacet)
  "0xee3314a1": {sourceSwaps: true, facet: "Chainflip"}, // swapAndStartBridgeTokensViaChainflip (ChainflipFacet)
  "0x05c54990": {sourceSwaps: false, facet: "Eco"}, // startBridgeTokensViaEco (EcoFacet v3.0.0, 9001792)
  "0x8352664c": {sourceSwaps: true, facet: "Eco"}, // swapAndStartBridgeTokensViaEco (EcoFacet v3.0.0, 9001792)
  "0x678786ea": {sourceSwaps: false, facet: "Frax"}, // startBridgeTokensViaFrax (FraxFacet)
  "0x07b8e4c7": {sourceSwaps: true, facet: "Frax"}, // swapAndStartBridgeTokensViaFrax (FraxFacet)
  "0xfc5f1003": {sourceSwaps: false, facet: "GasZip"}, // startBridgeTokensViaGasZip (GasZipFacet)
  "0x606326ff": {sourceSwaps: true, facet: "GasZip"}, // swapAndStartBridgeTokensViaGasZip (GasZipFacet)
  "0x6f9206ba": {sourceSwaps: false, facet: "Glacis"}, // startBridgeTokensViaGlacis (GlacisFacet)
  "0x9c4b6dd9": {sourceSwaps: true, facet: "Glacis"}, // swapAndStartBridgeTokensViaGlacis (GlacisFacet)
  "0xf66fe519": {sourceSwaps: false, facet: "GnosisBridge"}, // startBridgeTokensViaGnosisBridge (GnosisBridgeFacet)
  "0x7bf96e0a": {sourceSwaps: true, facet: "GnosisBridge"}, // swapAndStartBridgeTokensViaGnosisBridge (GnosisBridgeFacet)
  "0xee9e98e0": {sourceSwaps: false, facet: "LayerSwap"}, // startBridgeTokensViaLayerSwap (LayerSwapFacet)
  "0x4c279d6b": {sourceSwaps: true, facet: "LayerSwap"}, // swapAndStartBridgeTokensViaLayerSwap (LayerSwapFacet)
  "0x7dbcf1d9": {sourceSwaps: false, facet: "LiFiIntentEscrowV2"}, // startBridgeTokensViaLiFiIntentEscrowV2 (LiFiIntentEscrowFacetV2)
  "0x6d21c5df": {sourceSwaps: true, facet: "LiFiIntentEscrowV2"}, // swapAndStartBridgeTokensViaLiFiIntentEscrowV2 (LiFiIntentEscrowFacetV2)
  "0x65782c4b": {sourceSwaps: false, facet: "M0"}, // startBridgeTokensViaM0 (M0Facet)
  "0xb9eaf86d": {sourceSwaps: true, facet: "M0"}, // swapAndStartBridgeTokensViaM0 (M0Facet)
  "0xb4875292": {sourceSwaps: false, facet: "Mayan"}, // startBridgeTokensViaMayan (MayanFacet)
  "0x80c65808": {sourceSwaps: true, facet: "Mayan"}, // swapAndStartBridgeTokensViaMayan (MayanFacet)
  "0x4213dfff": {sourceSwaps: false, facet: "MegaETHBridge"}, // startBridgeTokensViaMegaETHBridge (MegaETHBridgeFacet)
  "0x22256e89": {sourceSwaps: true, facet: "MegaETHBridge"}, // swapAndStartBridgeTokensViaMegaETHBridge (MegaETHBridgeFacet)
  "0x4698f032": {sourceSwaps: false, facet: "NEARIntents"}, // startBridgeTokensViaNEARIntents (NEARIntentsFacet)
  "0x02631b09": {sourceSwaps: true, facet: "NEARIntents"}, // swapAndStartBridgeTokensViaNEARIntents (NEARIntentsFacet)
  "0x782621d8": {sourceSwaps: false, facet: "OmniBridge"}, // startBridgeTokensViaOmniBridge (OmniBridgeFacet)
  "0x95726782": {sourceSwaps: true, facet: "OmniBridge"}, // swapAndStartBridgeTokensViaOmniBridge (OmniBridgeFacet)
  "0xce8a97a5": {sourceSwaps: false, facet: "OptimismBridge"}, // startBridgeTokensViaOptimismBridge (OptimismBridgeFacet)
  "0x5bb5d448": {sourceSwaps: true, facet: "OptimismBridge"}, // swapAndStartBridgeTokensViaOptimismBridge (OptimismBridgeFacet)
  "0xaf62c7d6": {sourceSwaps: false, facet: "PolygonBridge"}, // startBridgeTokensViaPolygonBridge (PolygonBridgeFacet)
  "0xb4f37581": {sourceSwaps: true, facet: "PolygonBridge"}, // swapAndStartBridgeTokensViaPolygonBridge (PolygonBridgeFacet)
  "0xf434d6ca": {sourceSwaps: false, facet: "PolymerCCTP"}, // startBridgeTokensViaPolymerCCTP (PolymerCCTPFacet)
  "0x17917a4e": {sourceSwaps: true, facet: "PolymerCCTP"}, // swapAndStartBridgeTokensViaPolymerCCTP (PolymerCCTPFacet)
  "0x14d53077": {sourceSwaps: false, facet: "Stargate"}, // startBridgeTokensViaStargate (StargateFacetV2)
  "0xa6010a66": {sourceSwaps: true, facet: "Stargate"}, // swapAndStartBridgeTokensViaStargate (StargateFacetV2)
  "0x0691ff78": {sourceSwaps: false, facet: "Superset"}, // startBridgeTokensViaSuperset (SupersetFacet)
  "0xf26e657f": {sourceSwaps: true, facet: "Superset"}, // swapAndStartBridgeTokensViaSuperset (SupersetFacet)
  "0x64261d58": {sourceSwaps: false, facet: "Unit"}, // startBridgeTokensViaUnit (UnitFacet)
  "0x21a3af52": {sourceSwaps: true, facet: "Unit"}, // swapAndStartBridgeTokensViaUnit (UnitFacet)
};

/**
 * Bridge entry points that do not tie where the funds go to BridgeData.receiver (lifinance/contracts, main 2026-11-02):
 * Relay deposits against an `orderId` whose off-chain order names the recipient ("We cannot validate / guarantee that the
 * off-chain-data associated with the provided orderId corresponds to the _bridgeData"); Garden locks the funds for a
 * `redeemer` named in facet data, with the transfer details in an off-chain order; deBridge DLN passes its own
 * `receiver` and order authority through unchecked; ThorSwap pays a `vault` named in facet data with the destination in
 * a memo; Squid runs `sourceCalls` of any target on its multicall, which holds the funds, and bridges what is left
 * (only CallBridge bridges to BridgeData.receiver at all; LI.FI's live Squid quotes are BridgeCall, a destination
 * call); Symbiosis's MetaRouter path forwards `callTo` / `callData` verbatim and names the final recipient and the
 * revert address there (the facet: the emitted receiver "is therefore descriptive, not an on-chain guarantee"; its
 * other path bridges to Bitcoin only). A matching BridgeData.receiver proves nothing for these, so they are refused
 * by name. Neither Relay nor
 * any other party publishes an unauthenticated lookup of an unfunded Relay order (2026-11-02: `/intents/status` says
 * "unknown", `/requests/v2` lists only indexed deposits, `/requests/v3` needs an API key), so there is nothing to check
 * the orderId against on the device.
 */
const UNBOUND_BRIDGES: Readonly<Record<string, string>> = {
  "0x092e8fa4": "Relay", // startBridgeTokensViaRelayDepository
  "0xa3443faa": "Relay", // swapAndStartBridgeTokensViaRelayDepository
  "0x5f9af35d": "Garden", // startBridgeTokensViaGarden
  "0x76ad76fe": "Garden", // swapAndStartBridgeTokensViaGarden
  "0x4004633e": "deBridge DLN", // startBridgeTokensViaDeBridgeDln
  "0x2c7d2db0": "deBridge DLN", // swapAndStartBridgeTokensViaDeBridgeDln
  "0x2541ec57": "ThorSwap", // startBridgeTokensViaThorSwap
  "0xad673d88": "ThorSwap", // swapAndStartBridgeTokensViaThorSwap
  "0x3f313808": "Squid", // startBridgeTokensViaSquid
  "0xa8f66666": "Squid", // swapAndStartBridgeTokensViaSquid
  "0xe23b7a08": "Symbiosis", // startBridgeTokensViaSymbiosis
  "0xc46059b2": "Symbiosis", // swapAndStartBridgeTokensViaSymbiosis
};

/** What the quote promised, in the forms the calldata carries. */
export interface DiamondExpectation {
  /** Source token (EVM address; the zero address for the native coin). */
  fromToken: string;
  /** Destination token as LI.FI names it (the zero address for an EVM native coin). */
  toToken: string;
  /** Input, base units. */
  amountIn: bigint;
  /** The recipient (an EVM address, or another chain's address for a non-EVM destination). */
  receiver: string;
  /** The sender the quote was asked for (its `fromAddress`): where a bridge's refunds may go, besides the recipient. */
  sender: string;
  /** The floor the review shows. */
  minOut: bigint;
  /** LI.FI's id of the destination chain; equal to the source's for a swap. */
  destChainId: bigint;
  sameChain: boolean;
  /** The destination is an EVM chain (its receiver is a 20-byte address). */
  evmDestination: boolean;
}

interface SwapStep {sendingAssetId: string; receivingAssetId: string; fromAmount: bigint; requiresDeposit: boolean}

class Reader {
  private readonly b: Uint8Array;
  constructor(src: string | Uint8Array) {
    if (typeof src !== "string") { this.b = src; return; }
    if (!/^0x([0-9a-fA-F]{2})*$/.test(src)) throw new Error("not hex");
    this.b = Uint8Array.from(src.slice(2).match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  }
  get length() { return this.b.length; }
  /** `n` raw bytes at `at`, as 0x-hex. */
  raw(at: number, n: number): string {
    if (at < 0 || at + n > this.b.length) throw new Error("out of bounds");
    return `0x${Array.from(this.b.subarray(at, at + n), (x) => x.toString(16).padStart(2, "0")).join("")}`;
  }
  /** The `bytes` whose offset word sits at `head` (relative to `base`), as a reader over its contents only. */
  bytes(base: number, head: number): Reader {
    const at = base + this.small(head);
    const n = this.small(at);
    if (at + 32 + n > this.b.length) throw new Error("bytes out of bounds");
    return new Reader(this.b.subarray(at + 32, at + 32 + n));
  }
  word(at: number): bigint {
    if (at < 0 || at + 32 > this.b.length) throw new Error("out of bounds");
    let v = 0n;
    for (let i = at; i < at + 32; i++) v = (v << 8n) | BigInt(this.b[i]!);
    return v;
  }
  /** A word that must fit a JS offset / length (bounded by the calldata). */
  small(at: number): number {
    const v = this.word(at);
    if (v > BigInt(this.b.length)) throw new Error("offset out of bounds");
    return Number(v.toString()); // ≤ the calldata length
  }
  address(at: number): string {
    const v = this.word(at);
    if (v >> 160n !== 0n) throw new Error("not an address");
    return `0x${v.toString(16).padStart(40, "0")}`;
  }
  bool(at: number): boolean {
    const v = this.word(at);
    if (v > 1n) throw new Error("not a bool");
    return v === 1n;
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** SwapData tuple at `at`: (callTo, approveTo, sendingAssetId, receivingAssetId, fromAmount, callData, requiresDeposit). */
function swapAt(r: Reader, at: number): SwapStep {
  r.address(at); r.address(at + 32);
  const step = {sendingAssetId: r.address(at + 64), receivingAssetId: r.address(at + 96), fromAmount: r.word(at + 128), requiresDeposit: false};
  const bytesAt = at + r.small(at + 160);
  r.small(bytesAt); // length within the calldata
  // The Diamond pulls `fromAmount` of `sendingAssetId` from the user for every step that requires a deposit.
  step.requiresDeposit = r.bool(at + 192);
  return step;
}

/** SwapData[] whose offset word sits at `head`, relative to `base`. */
function swapsAt(r: Reader, base: number, head: number): SwapStep[] {
  const array = base + r.small(head);
  const n = r.small(array);
  if (n === 0 || n > 16) throw new Error("bad swap count");
  const items = array + 32;
  return Array.from({length: n}, (_, i) => swapAt(r, items + r.small(items + 32 * i)));
}

/**
 * Every step, not only the ends (scan 2026-10-27 modules, F21–F23): the Diamond pulls `fromAmount` from the user for
 * each step that requires a deposit, so only steps that spend the source token may, and together at most the input —
 * a middle step depositing DAI under a leftover allowance is refused. The steps chain: each spends what the one before
 * delivered (a fee step on the input sends and receives the same asset).
 */
function checkSteps(steps: SwapStep[], e: DiamondExpectation, finalAsset: string): string | null {
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  if (!same(first.sendingAssetId, e.fromToken)) return `spends ${first.sendingAssetId}, not ${e.fromToken}`;
  if (first.fromAmount === 0n || first.fromAmount > e.amountIn) return `swaps ${first.fromAmount}, not the ${e.amountIn} spent`;
  let deposited = 0n;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (i > 0 && !same(step.sendingAssetId, steps[i - 1]!.receivingAssetId)) return `step ${i} spends ${step.sendingAssetId}, which step ${i - 1} does not deliver`;
    if (!step.requiresDeposit) continue;
    if (!same(step.sendingAssetId, e.fromToken)) return `step ${i} pulls ${step.sendingAssetId} from the wallet, not the input ${e.fromToken}`;
    deposited += step.fromAmount;
  }
  if (deposited > e.amountIn) return `the steps pull ${deposited} from the wallet, more than the ${e.amountIn} spent`;
  if (!same(last.receivingAssetId, finalAsset)) return `delivers ${last.receivingAssetId}, not ${finalAsset}`;
  return null;
}

/** A Mayan Swift order refunds its input to `trader` when it is not filled, a Wormhole swap to `refundAddr`: their byte
 * offset in `protocolData` (Mayan's swap-sdk, src/evm; selectors as the facet lists them). MCTP and FastMCTP orders and
 * the HyperCore deposits carry no refund address: what they do not deliver settles to the destination address the facet
 * already checks against BridgeData.receiver. */
const MAYAN_REFUND_AT: Readonly<Record<string, number>> = {
  "0xa3a30834": 4 + 32 * 3, // Swift v2 createOrderWithToken(tokenIn, amountIn, (payloadType, trader, destAddr, …), customPayload)
  "0x6147435b": 4 + 32 * 3, // Swift v2 createOrderWithSig: the same order tuple
  "0xb866e173": 4, // Swift createOrderWithEth((trader, tokenOut, …))
  "0x8e8d142b": 4 + 32 * 2, // Swift createOrderWithToken(tokenIn, amountIn, (trader, tokenOut, …))
  "0x6111ad25": 4 + 32 * 9, // MayanSwap swap(relayerFees, (mayanAddr, mayanChainId, auctionAddr, destAddr, destChainId, referrer, refundAddr), …)
  "0x1eb1cff0": 4 + 32 * 9, // MayanSwap wrapAndSwapETH: the same recipient tuple
};
function mayanRefunds(r: Reader, at: number): Refund[] {
  const p = r.bytes(at, at + 32 * 2);
  const pos = MAYAN_REFUND_AT[p.raw(0, 4)];
  return pos === undefined ? [] : [["the Mayan order's refund address", p.address(pos)]];
}
/** Chainflip refunds the whole input to the address in `cfParameters` when the swap misses its minimum price:
 * VersionedCfParameters V1 (SCALE) — version, retry duration (u32), then the refund address, 20 bytes from an EVM chain. */
function chainflipRefunds(r: Reader, at: number): Refund[] {
  const p = r.bytes(at, at + 32 * 5);
  if (p.length < 25 || p.raw(0, 1) !== "0x01") throw new Error("unknown Chainflip parameters");
  return [["the Chainflip refund address", p.raw(5, 20)]];
}
/** The Across Swap API call, by target: the SpokePool deposit's depositor (DepositParams, depositor first) and the
 * periphery's `depositData.depositor` get an expired deposit back (and the periphery's positive slippage); the
 * sponsored OFT and CCTP flows refund to an unsigned `refundRecipient`. */
function acrossSwapRefunds(r: Reader, at: number): Refund[] {
  const target = r.word(at);
  const c = r.bytes(at, at + 32);
  // The facet refuses a zero depositor / refundRecipient on every target.
  if (target === 0n) return [["the Across deposit's depositor", c.address(c.small(0)), true]];
  if (target === 1n) {
    const swap = c.small(0); // SwapAndDepositData: (submissionFees.amount, submissionFees.recipient, depositData, …)
    return [["the Across deposit's depositor", c.address(swap + c.small(swap + 64) + 96), true]]; // BaseDepositData word 3
  }
  if (target === 2n) return [["the sponsored OFT refund recipient", c.address(c.small(0) + 32), true]]; // (Quote(signed, unsigned), signature)
  if (target === 3n) return [["the sponsored CCTP refund recipient", c.address(64), true]]; // (quote, signature, refundRecipient)
  throw new Error("unknown Across Swap API target");
}

/** The EVM native-token placeholder (the zero address) in the quote's destination token. */
/** ERC-20 `transfer(address,uint256)`. */
const ERC20_TRANSFER = "0xa9059cbb";
/**
 * Eco v3 (EcoFacet 3.0.0, lifinance/contracts 9001792): EcoData is (nonEVMReceiver, prover, rewardDeadline,
 * intentDestination, encodedRoute, solanaATA, refundRecipient, deadline, signature), a dynamic struct. v2 decoded the
 * route on chain and required its final `transfer` to pay BridgeData.receiver; v3 dropped that check ("for EVM
 * destinations the receiver is therefore enforced only by the backend signature, not on-chain") and lets the route
 * run on another chain than the destination (`intentDestination`: the source chain for a CCTP burn, HyperEVM for a
 * HyperCore deposit, a second intent), with calls the facet does not interpret. So the device checks what v2 did, and
 * more: the intent runs on the destination chain itself, and the route — abi.encode(Route(salt, deadline, portal,
 * nativeAmount, tokens, calls)), Call = (target, data, value) — ends in the destination token's `transfer` of at least
 * the reviewed minimum to the recipient. Whatever runs before it, the solver's fill either pays that or does not
 * happen, and the reward (the input) then goes back to refundRecipient, checked above.
 */
function ecoDelivery(r: Reader, at: number, e: DiamondExpectation): string | null {
  // A native delivery has no token `transfer` to read (it would be a value call to the recipient), so it is refused
  // outright — not left to the token comparison below, where a `transfer` "of" the zero address would match.
  if (kindOf(e.toToken) === "native") return "an Eco route to the native token cannot be checked here";
  const destination = r.word(at + 32 * 3);
  if (destination !== e.destChainId) return `the Eco intent executes on chain ${destination}, not the destination ${e.destChainId} — a route whose delivery cannot be checked here`;
  const route = r.bytes(at, at + 32 * 4);
  const tuple = route.small(0);
  const calls = tuple + route.small(tuple + 32 * 5);
  const n = route.small(calls);
  if (n === 0) return "the Eco route makes no calls on the destination chain";
  if (n > 16) return `the Eco route makes ${n} calls on the destination chain, more than the 16 read here`;
  const last = calls + 32 + route.small(calls + 32 + 32 * (n - 1));
  const target = route.address(last);
  const data = route.bytes(last, last + 32);
  if (route.word(last + 64) !== 0n || data.length !== 68 || data.raw(0, 4) !== ERC20_TRANSFER) return "the Eco route does not end in a token transfer";
  const to = data.address(4);
  const amount = data.word(36);
  if (!same(target, e.toToken)) return `the Eco route delivers ${target}, not ${e.toToken}`;
  if (!same(to, e.receiver)) return `the Eco route pays ${to}, not ${e.receiver}`;
  if (amount < e.minOut) return `the Eco route delivers ${amount}, below the ${e.minOut} shown`;
  return null;
}
/**
 * M0 (M0Facet 1.0.0): an order on the M0 OrderBook asks a solver for `amountOut` of `tokenOut` on the destination
 * (M0Data words 3 and 5); the facet ties only the receiver to BridgeData. Both must be the quote's: the destination
 * token, and at least the reviewed minimum. On the swap entry point the facet scales amountOut by the swap's realised
 * output over the quoted input (never below 1×), so the calldata's value is a lower bound there too.
 */
function m0Delivery(r: Reader, at: number, e: DiamondExpectation): string | null {
  // M0Facet refuses a zero tokenOut (the OrderBook would escrow the input with nothing to fill): no native delivery.
  if (kindOf(e.toToken) === "native") return "an M0 order cannot deliver the native token";
  const tokenOut = r.address(at + 32 * 3);
  const amountOut = r.word(at + 32 * 5);
  if (!same(tokenOut, e.toToken)) return `the M0 order asks for ${tokenOut}, not ${e.toToken}`;
  if (amountOut < e.minOut) return `the M0 order asks for ${amountOut}, below the ${e.minOut} shown`;
  return null;
}

/**
 * Where a bridge facet's data names who gets money back: an unused native fee, swap leftovers or positive slippage, the
 * whole input when a deposit, intent or order expires unfilled, or a fallback when delivery fails. The facets only
 * require these to be non-zero (NEAR Intents, LayerSwap and Eco also sign them on LI.FI's backend, which an `apiUrl`
 * proxy cannot forge but LI.FI's API itself writes), so each must be the sender or the recipient; LI.FI's live quotes
 * set them to the sender. `refunds` are [field, word] in the facet data (lifinance/contracts, the same structs at
 * 86c3729 and on main 2026-11-02; Eco as at v3.0.0, 9001792, whose entry points are the listed ones); `inline` marks a static
 * struct, which is encoded in place among the arguments rather than behind an offset (its word count). A zero is
 * accepted where the facet itself refuses a zero in every field it uses (`zeroRefused`; Polymer CCTP reads its
 * refundRecipient on the swap entry point only): it pays no one. Stargate passes a zero to LayerZero, and Mayan and
 * Chainflip carry theirs into the protocol, so there a zero is refused like any other address.
 */
interface FacetData {
  inline?: number;
  refunds?: readonly (readonly [string, number])[];
  zeroRefused?: true;
  nested?: (r: Reader, at: number) => Refund[];
  /** What the facet data says the destination receives, held to the quote: a reason it does not match, or null. */
  delivery?: (r: Reader, at: number, e: DiamondExpectation) => string | null;
}
/** [what, address, a zero there is refused by the facet]. */
type Refund = [string, string, boolean?];
const FACET_DATA: Readonly<Record<string, FacetData>> = {
  AcrossV4: {refunds: [["refundAddress", 1]], zeroRefused: true}, // the SpokePool depositor: an expired deposit refunds the input there
  AcrossV4Swap: {nested: acrossSwapRefunds},
  Centrifuge: {inline: 2, refunds: [["refundRecipient", 1]], zeroRefused: true},
  Chainflip: {nested: chainflipRefunds},
  Eco: {refunds: [["refundRecipient", 6]], zeroRefused: true, delivery: ecoDelivery}, // the intent's creator, refunded its reward (the input) on expiry
  Frax: {inline: 5, refunds: [["refundRecipient", 3]], zeroRefused: true},
  Glacis: {inline: 4, refunds: [["refundAddress", 1]], zeroRefused: true},
  LayerSwap: {refunds: [["refundRecipient", 2]], zeroRefused: true},
  LiFiIntentEscrowV2: {refunds: [["depositAndRefundAddress", 2]], zeroRefused: true}, // the escrow order's user
  M0: {inline: 7, refunds: [["refundRecipient", 1], ["orderOwner", 2]], zeroRefused: true, delivery: m0Delivery}, // orderOwner gets a cancelled order back
  Mayan: {refunds: [["refundRecipient", 7]], nested: mayanRefunds, zeroRefused: true},
  NEARIntents: {refunds: [["refundRecipient", 6]], zeroRefused: true}, // also the 1Click quote's refundTo
  PolymerCCTP: {refunds: [["refundRecipient", 5]], zeroRefused: true},
  Stargate: {refunds: [["refundAddress", 4]]}, // (assetId, sendParams, fee.nativeFee, fee.lzTokenFee, refundAddress): LayerZero's fee refund
  Superset: {refunds: [["refundAddress", 2], ["fallbackEoA", 3]], zeroRefused: true},
};
/**
 * Facets whose data names no one to pay back: Across (the SpokePool's depositor is the Diamond), AllBridge, Celer
 * Circle, GasZip, MegaETH and Optimism (no address but the receiver the facet checks), Arbitrum (its retryable's
 * refunds go to BridgeData.receiver), Gnosis, Omni and Polygon (no facet data) and Unit (its own deposit address,
 * signed). Their excess native and swap leftovers go to the caller.
 */
const NO_REFUND_FIELDS = new Set(["Across", "AllBridge", "ArbitrumBridge", "CelerCircleBridge", "GasZip", "GnosisBridge", "MegaETHBridge", "OmniBridge", "OptimismBridge", "PolygonBridge", "Unit"]);

/** Where the facet data starts: the last argument, after BridgeData's offset word (and the SwapData[]'s). */
function facetDataAt(r: Reader, bridge: {sourceSwaps: boolean}, spec: FacetData): number {
  const slot = 4 + (bridge.sourceSwaps ? 64 : 32);
  return spec.inline ? slot : 4 + r.small(slot);
}

/** A refund or fallback in the bridge's facet data that pays neither the sender nor the recipient, or null. */
function refundMismatch(r: Reader, bridge: {sourceSwaps: boolean; facet: string}, e: DiamondExpectation): string | null {
  const spec = FACET_DATA[bridge.facet];
  if (!spec) return NO_REFUND_FIELDS.has(bridge.facet) ? null : `no known refund layout for ${bridge.facet}`;
  const at = facetDataAt(r, bridge, spec);
  const paid: Refund[] = (spec.refunds ?? []).map(([field, word]) => [`${bridge.facet} ${field}`, r.address(at + 32 * word), spec.zeroRefused === true]);
  paid.push(...(spec.nested?.(r, at) ?? []));
  for (const [what, to, zeroRefused] of paid) {
    if (zeroRefused && /^0x0{40}$/.test(to)) continue;
    if (!same(to, e.sender) && !same(to, e.receiver)) return `${what} pays ${to}, neither the sender ${e.sender} nor the recipient`;
  }
  return null;
}

/** Why the Diamond calldata does not do what the quote says, or null when it does. */
export function diamondCallMismatch(data: string, e: DiamondExpectation): string | null {
  let r: Reader;
  try { r = new Reader(data); } catch { return "the calldata is not hex"; }
  if (r.length < 4 + 32 * 2) return "the calldata is too short";
  const selector = data.slice(0, 10).toLowerCase();
  const generic = GENERIC_SWAPS[selector];
  try {
    if (generic) {
      if (!e.sameChain) return "a same-chain swap call on a cross-chain route";
      // (bytes32 txId, string integrator, string referrer, address receiver, uint256 minAmount, SwapData | SwapData[])
      const receiver = r.address(4 + 96);
      const minAmount = r.word(4 + 128);
      const steps = generic.single ? [swapAt(r, 4 + r.small(4 + 160))] : swapsAt(r, 4, 4 + 160);
      if (!e.evmDestination || !same(receiver, e.receiver)) return `pays ${receiver}, not ${e.receiver}`;
      if (minAmount < e.minOut) return `accepts ${minAmount}, below the ${e.minOut} shown`;
      if (generic.from && kindOf(e.fromToken) !== generic.from) return `${selector} swaps from ${generic.from === "native" ? "the native coin" : "a token"}, but the input is ${kindOf(e.fromToken) === "native" ? "the native coin" : "a token"}`;
      if (generic.to && (kindOf(e.toToken) !== generic.to || kindOf(steps[steps.length - 1]!.receivingAssetId) !== generic.to)) {
        return `${selector} delivers ${generic.to === "native" ? "the native coin" : "a token"}, but the output is ${kindOf(e.toToken) === "native" ? "the native coin" : "a token"} — its minimum would be counted in the wrong asset`;
      }
      return checkSteps(steps, e, e.toToken);
    }
    // Bridge facets: (BridgeData, [SwapData[],] FacetData), only the listed ABI entry points.
    // BridgeData is dynamic (it holds strings), so its offset is the head size.
    const unbound = UNBOUND_BRIDGES[selector];
    if (unbound) return `${unbound} delivers to a recipient the transaction does not bind (an off-chain order or unchecked facet data)`;
    const bridge = BRIDGE_CALLS[selector];
    if (!bridge) return `unknown Diamond call ${selector}`;
    const head = r.small(4);
    if (head < (bridge.sourceSwaps ? 96 : 64) || head % 32 !== 0 || head > 32 * 32) return `unknown Diamond call ${selector}`;
    const at = 4 + head;
    // BridgeData: (txId, string bridge, string integrator, referrer, sendingAssetId, receiver, minAmount, destinationChainId, hasSourceSwaps, hasDestinationCall)
    if (r.small(at + 32) !== 320) return `unknown Diamond call ${selector}`;
    const sendingAssetId = r.address(at + 128);
    const receiver = r.address(at + 160);
    const minAmount = r.word(at + 192);
    const destinationChainId = r.word(at + 224);
    const hasSourceSwaps = r.bool(at + 256);
    const hasDestinationCall = r.bool(at + 288);
    if (e.sameChain) return "a bridge call on a same-chain route";
    if (destinationChainId !== e.destChainId) return `bridges to chain ${destinationChainId}, not ${e.destChainId}`;
    if (hasDestinationCall) return "the route runs a call on the destination chain, whose recipient cannot be checked here";
    if (!e.evmDestination) return "the recipient on a non-EVM destination sits in bridge-specific data and cannot be checked here";
    if (!same(receiver, e.receiver)) return `pays ${receiver}, not ${e.receiver}`;
    if (hasSourceSwaps !== bridge.sourceSwaps) return `unknown Diamond call ${selector}`;
    const refund = refundMismatch(r, bridge, e);
    if (refund) return refund;
    const spec = FACET_DATA[bridge.facet];
    const delivery = spec?.delivery?.(r, facetDataAt(r, bridge, spec), e);
    if (delivery) return delivery;
    // After source swaps the bridged amount is in the swapped token's units: only the swaps' input is comparable.
    if (hasSourceSwaps) {
      // The swapped amount is the facet's own (it replaces minAmount after the swaps); a zero is a route that bridges nothing.
      if (minAmount === 0n) return "bridges nothing after the source swaps";
      return checkSteps(swapsAt(r, 4, 4 + 32), e, sendingAssetId);
    }
    // Without source swaps the Diamond pulls minAmount: the input, or the input less a bridge's own fee (Glacis takes
    // 0.25 %, matrix v7). Anything further below leaves the rest of the allowance behind for the next call to take
    // (scan 2026-10-27 modules, F22): a minAmount of 1 is refused.
    if (minAmount > e.amountIn || minAmount * 10_000n < e.amountIn * (10_000n - BRIDGE_INPUT_FEE_MAX_BPS)) return `bridges ${minAmount}, not the ${e.amountIn} spent`;
    return same(sendingAssetId, e.fromToken) ? null : `bridges ${sendingAssetId}, not ${e.fromToken}`;
  } catch (err) {
    return `the Diamond calldata does not decode (${err instanceof Error ? err.message : String(err)})`;
  }
}
