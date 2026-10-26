// Recorded-shape LI.FI /quote responses shared by the provider and behaviour tests.
import {encodeFunctionData, parseAbi, type Hex} from "viem";
export const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
export const FROM_TOKEN = "0xdAC17F958D2ee523A2206206994597C13D831ec7";
export const TO_TOKEN = "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9";
export const SENDER = "0x4444444444444444444444444444444444444444";
export const RECIPIENT = "0x3333333333333333333333333333333333333333";
export const PARAMS = {
  sourceChain: "eip155:1",
  sourceToken: "USDT",
  destChain: "eip155:42161",
  destToken: TO_TOKEN,
  amountIn: "1000000",
  destAddress: RECIPIENT,
  refundAddress: SENDER,
  slippageBps: 50,
};

export function response(overrides: Record<string, unknown> = {}) {
  const base = {
    type: "lifi",
    id: "quote-1",
    action: {
      fromToken: {address: FROM_TOKEN, chainId: 1},
      toToken: {address: TO_TOKEN, chainId: 42161},
      fromAmount: "1000000",
      fromChainId: 1,
      toChainId: 42161,
      slippage: 0.005,
      fromAddress: SENDER,
      toAddress: RECIPIENT,
    },
    estimate: {
      fromAmount: "1000000",
      toAmount: "990000",
      toAmountMin: "985050",
      approvalAddress: DIAMOND,
      executionDuration: 20,
    },
    transactionRequest: {
      from: SENDER,
      to: DIAMOND,
      data: AUTO,
      value: "0x0",
      chainId: 1,
      gasLimit: "0x5208",
    },
    ...overrides,
  };
  // Calldata this fixture generated (also when a test spreads `response().transactionRequest`)
  // follows the final action; calldata a test wrote itself stays as written.
  const tr = (base as {transactionRequest?: {data?: string}}).transactionRequest;
  if (tr?.data === AUTO || (tr?.data !== undefined && GENERATED.has(tr.data))) {
    const data = diamondCall(base.action as never, base.estimate as never);
    GENERATED.add(data);
    (base as {transactionRequest?: unknown}).transactionRequest = {...tr, data};
  }
  return base;
}
const GENERATED = new Set<string>();

/** `transactionRequest.data` placeholder: the fixture encodes Diamond calldata that does what its `action` says. */
export const AUTO = "auto";

export const DIAMOND_ABI = parseAbi([
  "function swapTokensSingleV3ERC20ToERC20(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, (address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit) _swapData)",
  "function startBridgeTokensViaRelay((bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall) _bridgeData, (bytes32 requestId, bytes32 nonEVMReceiver, bytes32 receivingAssetId, bytes signature) _relayData)",
]);
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const DEX = "0x2222222222222222222222222222222222222222";

/** Diamond calldata for a quote: a GenericSwapFacetV3 swap on one chain, a Relay bridge across two. */
export function diamondCall(
  action: {fromToken: {address: string}; toToken: {address: string}; fromAmount: string; fromChainId: number; toChainId: number; toAddress: string},
  estimate: {fromAmount: string; toAmountMin?: string},
  over: {receiver?: string; minOut?: bigint; destChainId?: bigint; sendingAssetId?: string; hasDestinationCall?: boolean} = {},
): Hex {
  const lower = (a: string) => a.toLowerCase() as Hex;
  const receiver = lower(over.receiver ?? action.toAddress);
  if (action.fromChainId === action.toChainId) {
    return encodeFunctionData({abi: DIAMOND_ABI, functionName: "swapTokensSingleV3ERC20ToERC20", args: [ZERO32, "awk", "", receiver, over.minOut ?? BigInt(estimate.toAmountMin ?? "0"), {
      callTo: DEX, approveTo: DEX, sendingAssetId: lower(action.fromToken.address), receivingAssetId: lower(action.toToken.address), fromAmount: BigInt(action.fromAmount), callData: "0x", requiresDeposit: true,
    }]});
  }
  return encodeFunctionData({abi: DIAMOND_ABI, functionName: "startBridgeTokensViaRelay", args: [{
    transactionId: ZERO32, bridge: "relay", integrator: "awk", referrer: "0x0000000000000000000000000000000000000000",
    sendingAssetId: lower(over.sendingAssetId ?? action.fromToken.address), receiver, minAmount: BigInt(estimate.fromAmount),
    destinationChainId: over.destChainId ?? BigInt(action.toChainId), hasSourceSwaps: false, hasDestinationCall: over.hasDestinationCall ?? false,
  }, {requestId: ZERO32, nonEVMReceiver: ZERO32, receivingAssetId: ZERO32, signature: "0x"}]});
}
