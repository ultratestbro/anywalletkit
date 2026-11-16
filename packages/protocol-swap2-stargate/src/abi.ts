import {parseAbi} from "viem";

// LayerZero-v2 592625b9e5967643853476445ffe0e777360b906: historical Executor/IExecutor.
export const EXECUTOR_ABI = parseAbi([
  "struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }",
  "struct NativeDropParams { address receiver; uint256 amount; }",
  "function endpoint() view returns (address)",
  "function localEid() view returns (uint32)",
  "event NativeDropApplied(Origin origin, uint32 dstEid, address oapp, NativeDropParams[] params, bool[] success)",
]);

export const ENDPOINT_ABI = parseAbi([
  "struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }",
  "function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) view returns (bytes32)",
  "function lzReceive(Origin origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable",
  "event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)",
  "event PacketDelivered(Origin origin, address receiver)",
]);

// SDK-322: checked against pinned upstream deployment ABI by abi.test.ts.
// Provenance: tests/fixtures/upstream.json. This is an interface, not a deployment allowlist.
export const STARGATE_ABI = parseAbi([
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }",
  "struct OFTLimit { uint256 minAmountLD; uint256 maxAmountLD; }",
  "struct OFTFeeDetail { int256 feeAmountLD; string description; }",
  "struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }",
  "struct Ticket { uint72 ticketId; bytes passengerBytes; }",
  "struct AddressConfig { address feeLib; address planner; address treasurer; address tokenMessaging; address creditMessaging; address lzToken; }",
  "function token() view returns (address)",
  "function sharedDecimals() view returns (uint8)",
  "function approvalRequired() pure returns (bool)",
  "function localEid() view returns (uint32)",
  "function endpoint() view returns (address)",
  "function status() view returns (uint8)",
  "function stargateType() pure returns (uint8)",
  "function paths(uint32 eid) view returns (uint64 credit)",
  "function getAddressConfig() view returns (AddressConfig)",
  "function quoteOFT(SendParam s) view returns (OFTLimit limit, OFTFeeDetail[] oftFeeDetails, OFTReceipt receipt)",
  "function quoteSend(SendParam s, bool payInLzToken) view returns (MessagingFee fee)",
  "function send(SendParam s, MessagingFee fee, address refundAddress) payable returns (MessagingReceipt msgReceipt, OFTReceipt oftReceipt)",
  "function sendToken(SendParam s, MessagingFee fee, address refundAddress) payable returns (MessagingReceipt msgReceipt, OFTReceipt oftReceipt, Ticket ticket)",
  "function unreceivedTokens(bytes32 guid, uint8 index) view returns (bytes32)",
  "function retryReceiveToken(bytes32 guid, uint8 index, uint32 srcEid, address receiver, uint256 amountLD, bytes composeMsg)",
  "event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)",
  "event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)",
  "event UnreceivedTokenCached(bytes32 guid, uint8 index, uint32 srcEid, address receiver, uint256 amountLD, bytes composeMsg)",
]);

export const TOKEN_MESSAGING_ABI = parseAbi([
  "error Bus_InvalidFare(bool nativeDrop)",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }",
  "function assetIds(address stargateImpl) view returns (uint16)",
  "function stargateImpls(uint16 assetId) view returns (address)",
  "function peers(uint32 eid) view returns (bytes32)",
  "function endpoint() view returns (address)",
  "function nativeDropAmounts(uint32 eid) view returns (uint128)",
  "function queueCapacity() view returns (uint16)",
  "function busQueues(uint32 eid) view returns (uint8 maxNumPassengers, uint80 busFare, uint80 busAndNativeDropFare, uint16 qLength, uint72 nextTicketId)",
  "function getPassengerHash(uint32 eid, uint16 index) view returns (bytes32)",
  "function quoteDriveBus(uint32 dstEid, bytes passengers) view returns (MessagingFee fee)",
  "function driveBus(uint32 dstEid, bytes passengers) payable returns (MessagingReceipt receipt)",
  "event BusRode(uint32 dstEid, uint72 ticketId, uint80 fare, bytes passenger)",
  "event BusDriven(uint32 dstEid, uint72 startTicketId, uint8 numPassengers, bytes32 guid)",
  "event NativeDropApplied(address receiver, uint128 amount)",
  "event NativeDropFailed(address receiver, uint128 amount)",
]);
