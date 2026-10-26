/**
 * What the LI.FI Diamond call really does, read from its calldata — not from the `action` /
 * `estimate` next to it (round 3, H9). The API (or an `apiUrl` proxy) could pair a reviewed
 * recipient and minimum with calldata that pays someone else, or accepts 1 wei.
 *
 * Same-chain swaps run through GenericSwapFacet(V3): receiver, minimum, the input token and amount,
 * and the output token are in the arguments. Bridges take `ILiFi.BridgeData` as their first
 * argument: its receiver, destination chain and bridged asset are checked; a destination call
 * (the final recipient sits in calldata for another chain) and a non-EVM destination (the receiver
 * sits in facet-specific data) cannot be checked here and are refused. Anything that does not
 * decode as one of these, canonically, is refused.
 */

const GENERIC_SWAPS: Readonly<Record<string, {single: boolean}>> = {
  "0x4630a0d8": {single: false}, // swapTokensGeneric
  "0x4666fc80": {single: true}, // swapTokensSingleV3ERC20ToERC20
  "0x733214a3": {single: true}, // swapTokensSingleV3ERC20ToNative
  "0xaf7060fd": {single: true}, // swapTokensSingleV3NativeToERC20
  "0x5fd9ae2e": {single: false}, // swapTokensMultipleV3ERC20ToERC20
  "0x2c57e884": {single: false}, // swapTokensMultipleV3ERC20ToNative
  "0x736eac0b": {single: false}, // swapTokensMultipleV3NativeToERC20
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

interface SwapStep {sendingAssetId: string; receivingAssetId: string; fromAmount: bigint}

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
  const step = {sendingAssetId: r.address(at + 64), receivingAssetId: r.address(at + 96), fromAmount: r.word(at + 128)};
  const bytesAt = at + r.small(at + 160);
  r.small(bytesAt); // length within the calldata
  r.bool(at + 192);
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

function checkSteps(steps: SwapStep[], e: DiamondExpectation, finalAsset: string): string | null {
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  if (!same(first.sendingAssetId, e.fromToken)) return `spends ${first.sendingAssetId}, not ${e.fromToken}`;
  if (first.fromAmount === 0n || first.fromAmount > e.amountIn) return `swaps ${first.fromAmount}, not the ${e.amountIn} spent`;
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
      return checkSteps(steps, e, e.toToken);
    }
    // Bridge facets: (BridgeData, [SwapData[],] FacetData). BridgeData is dynamic (it holds strings), so
    // its offset is the head size: a small multiple of 32. Bytes a packed facet would read instead put
    // that small number where its receiver goes — no address anyone controls.
    const head = r.small(4);
    if (head < 32 || head % 32 !== 0 || head > 32 * 32) return `unknown Diamond call ${selector}`;
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
    if (minAmount === 0n || minAmount > e.amountIn) return `bridges ${minAmount}, not the ${e.amountIn} spent`;
    if (!hasSourceSwaps) return same(sendingAssetId, e.fromToken) ? null : `bridges ${sendingAssetId}, not ${e.fromToken}`;
    if (head < 64) return `unknown Diamond call ${selector}`;
    return checkSteps(swapsAt(r, 4, 4 + 32), e, sendingAssetId);
  } catch (err) {
    return `the Diamond calldata does not decode (${err instanceof Error ? err.message : String(err)})`;
  }
}
