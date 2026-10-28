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
 * Not checked here: a bridge's OUTPUT. The destination minimum (and for some bridges, e.g. Relay
 * and Across, what the receiver finally gets) lives in facet-specific data, so for bridges the
 * reviewed minimum still relies on LI.FI's API answering honestly.
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
 * facet sources in lifinance/contracts (86c3729, 2026-10-26). Packed facets and `*Min` variants read
 * raw calldata, not BridgeData, and are not listed: any other selector is refused.
 */
const BRIDGE_CALLS: Readonly<Record<string, {sourceSwaps: boolean}>> = {
  "0x1fd8010c": {sourceSwaps: false}, // startBridgeTokensViaAcross (AcrossFacet)
  "0x3a3f7332": {sourceSwaps: true}, // swapAndStartBridgeTokensViaAcross (AcrossFacet)
  "0xa1f1ce43": {sourceSwaps: false}, // startBridgeTokensViaAcrossV4 (AcrossFacetV4)
  "0x1794958f": {sourceSwaps: true}, // swapAndStartBridgeTokensViaAcrossV4 (AcrossFacetV4)
  "0x6a90d66e": {sourceSwaps: false}, // startBridgeTokensViaAcrossV4Swap (AcrossV4SwapFacet)
  "0x9b054bc4": {sourceSwaps: true}, // swapAndStartBridgeTokensViaAcrossV4Swap (AcrossV4SwapFacet)
  "0x6a51e9a9": {sourceSwaps: false}, // startBridgeTokensViaAllBridge (AllBridgeFacet)
  "0x63267469": {sourceSwaps: true}, // swapAndStartBridgeTokensViaAllBridge (AllBridgeFacet)
  "0xc9851d0b": {sourceSwaps: false}, // startBridgeTokensViaArbitrumBridge (ArbitrumBridgeFacet)
  "0x3cc9517b": {sourceSwaps: true}, // swapAndStartBridgeTokensViaArbitrumBridge (ArbitrumBridgeFacet)
  "0xe0a4201c": {sourceSwaps: false}, // startBridgeTokensViaCelerCircleBridge (CelerCircleBridgeFacet)
  "0x4f3b0759": {sourceSwaps: true}, // swapAndStartBridgeTokensViaCelerCircleBridge (CelerCircleBridgeFacet)
  "0x0315138f": {sourceSwaps: false}, // startBridgeTokensViaCentrifuge (CentrifugeFacet)
  "0x8fd4d4dd": {sourceSwaps: true}, // swapAndStartBridgeTokensViaCentrifuge (CentrifugeFacet)
  "0x0ad553b3": {sourceSwaps: false}, // startBridgeTokensViaChainflip (ChainflipFacet)
  "0xee3314a1": {sourceSwaps: true}, // swapAndStartBridgeTokensViaChainflip (ChainflipFacet)
  "0x4004633e": {sourceSwaps: false}, // startBridgeTokensViaDeBridgeDln (DeBridgeDlnFacet)
  "0x2c7d2db0": {sourceSwaps: true}, // swapAndStartBridgeTokensViaDeBridgeDln (DeBridgeDlnFacet)
  "0xbff90b61": {sourceSwaps: false}, // startBridgeTokensViaEco (EcoFacet)
  "0x762aea18": {sourceSwaps: true}, // swapAndStartBridgeTokensViaEco (EcoFacet)
  "0x678786ea": {sourceSwaps: false}, // startBridgeTokensViaFrax (FraxFacet)
  "0x07b8e4c7": {sourceSwaps: true}, // swapAndStartBridgeTokensViaFrax (FraxFacet)
  "0x5f9af35d": {sourceSwaps: false}, // startBridgeTokensViaGarden (GardenFacet)
  "0x76ad76fe": {sourceSwaps: true}, // swapAndStartBridgeTokensViaGarden (GardenFacet)
  "0xfc5f1003": {sourceSwaps: false}, // startBridgeTokensViaGasZip (GasZipFacet)
  "0x606326ff": {sourceSwaps: true}, // swapAndStartBridgeTokensViaGasZip (GasZipFacet)
  "0x6f9206ba": {sourceSwaps: false}, // startBridgeTokensViaGlacis (GlacisFacet)
  "0x9c4b6dd9": {sourceSwaps: true}, // swapAndStartBridgeTokensViaGlacis (GlacisFacet)
  "0xf66fe519": {sourceSwaps: false}, // startBridgeTokensViaGnosisBridge (GnosisBridgeFacet)
  "0x7bf96e0a": {sourceSwaps: true}, // swapAndStartBridgeTokensViaGnosisBridge (GnosisBridgeFacet)
  "0xee9e98e0": {sourceSwaps: false}, // startBridgeTokensViaLayerSwap (LayerSwapFacet)
  "0x4c279d6b": {sourceSwaps: true}, // swapAndStartBridgeTokensViaLayerSwap (LayerSwapFacet)
  "0x7dbcf1d9": {sourceSwaps: false}, // startBridgeTokensViaLiFiIntentEscrowV2 (LiFiIntentEscrowFacetV2)
  "0x6d21c5df": {sourceSwaps: true}, // swapAndStartBridgeTokensViaLiFiIntentEscrowV2 (LiFiIntentEscrowFacetV2)
  "0x65782c4b": {sourceSwaps: false}, // startBridgeTokensViaM0 (M0Facet)
  "0xb9eaf86d": {sourceSwaps: true}, // swapAndStartBridgeTokensViaM0 (M0Facet)
  "0xb4875292": {sourceSwaps: false}, // startBridgeTokensViaMayan (MayanFacet)
  "0x80c65808": {sourceSwaps: true}, // swapAndStartBridgeTokensViaMayan (MayanFacet)
  "0x4213dfff": {sourceSwaps: false}, // startBridgeTokensViaMegaETHBridge (MegaETHBridgeFacet)
  "0x22256e89": {sourceSwaps: true}, // swapAndStartBridgeTokensViaMegaETHBridge (MegaETHBridgeFacet)
  "0x4698f032": {sourceSwaps: false}, // startBridgeTokensViaNEARIntents (NEARIntentsFacet)
  "0x02631b09": {sourceSwaps: true}, // swapAndStartBridgeTokensViaNEARIntents (NEARIntentsFacet)
  "0x782621d8": {sourceSwaps: false}, // startBridgeTokensViaOmniBridge (OmniBridgeFacet)
  "0x95726782": {sourceSwaps: true}, // swapAndStartBridgeTokensViaOmniBridge (OmniBridgeFacet)
  "0xce8a97a5": {sourceSwaps: false}, // startBridgeTokensViaOptimismBridge (OptimismBridgeFacet)
  "0x5bb5d448": {sourceSwaps: true}, // swapAndStartBridgeTokensViaOptimismBridge (OptimismBridgeFacet)
  "0xaf62c7d6": {sourceSwaps: false}, // startBridgeTokensViaPolygonBridge (PolygonBridgeFacet)
  "0xb4f37581": {sourceSwaps: true}, // swapAndStartBridgeTokensViaPolygonBridge (PolygonBridgeFacet)
  "0xf434d6ca": {sourceSwaps: false}, // startBridgeTokensViaPolymerCCTP (PolymerCCTPFacet)
  "0x17917a4e": {sourceSwaps: true}, // swapAndStartBridgeTokensViaPolymerCCTP (PolymerCCTPFacet)
  "0x092e8fa4": {sourceSwaps: false}, // startBridgeTokensViaRelayDepository (RelayDepositoryFacet)
  "0xa3443faa": {sourceSwaps: true}, // swapAndStartBridgeTokensViaRelayDepository (RelayDepositoryFacet)
  "0x3f313808": {sourceSwaps: false}, // startBridgeTokensViaSquid (SquidFacet)
  "0xa8f66666": {sourceSwaps: true}, // swapAndStartBridgeTokensViaSquid (SquidFacet)
  "0x14d53077": {sourceSwaps: false}, // startBridgeTokensViaStargate (StargateFacetV2)
  "0xa6010a66": {sourceSwaps: true}, // swapAndStartBridgeTokensViaStargate (StargateFacetV2)
  "0x0691ff78": {sourceSwaps: false}, // startBridgeTokensViaSuperset (SupersetFacet)
  "0xf26e657f": {sourceSwaps: true}, // swapAndStartBridgeTokensViaSuperset (SupersetFacet)
  "0xe23b7a08": {sourceSwaps: false}, // startBridgeTokensViaSymbiosis (SymbiosisFacet)
  "0xc46059b2": {sourceSwaps: true}, // swapAndStartBridgeTokensViaSymbiosis (SymbiosisFacet)
  "0x2541ec57": {sourceSwaps: false}, // startBridgeTokensViaThorSwap (ThorSwapFacet)
  "0xad673d88": {sourceSwaps: true}, // swapAndStartBridgeTokensViaThorSwap (ThorSwapFacet)
  "0x64261d58": {sourceSwaps: false}, // startBridgeTokensViaUnit (UnitFacet)
  "0x21a3af52": {sourceSwaps: true}, // swapAndStartBridgeTokensViaUnit (UnitFacet)
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
  constructor(hex: string) {
    if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error("not hex");
    this.b = Uint8Array.from(hex.slice(2).match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  }
  get length() { return this.b.length; }
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
