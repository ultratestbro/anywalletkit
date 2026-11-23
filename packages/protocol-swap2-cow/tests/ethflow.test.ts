// CoWSwapEthFlow calls and the order behind them, against a mainnet order that really settled and against digests
// the deployed contracts returned for fixed data on each chain.
import {describe, expect, it} from "vitest";
import {decodeFunctionData, getAddress, keccak256, stringToHex, toFunctionSelector} from "viem";
import {
  ETH_FLOW_ABI,
  ETH_FLOW_CREATE_SELECTOR,
  ETH_FLOW_GPV2_VALID_TO,
  ETH_FLOW_INVALIDATE_SELECTOR,
  decodeEthFlowCall,
  encodeCreateOrder,
  encodeInvalidateOrder,
  encodeOrdersRead,
  ethFlowGpv2Order,
  ethFlowOrderId,
  packEthFlowData,
  unpackEthFlowData,
  type EthFlowData,
} from "../src/ethflow.js";
import {D1, D42161, D8453, ME, USDC, USDT, ZERO} from "./fixtures.js";

// Mainnet eth-flow order 0x353efa4f… (api.cow.fi/mainnet/api/v1/orders/<uid>): the user's validTo lives in
// `ethflowData.userValidTo`, the GPv2 order itself never expires.
const REAL: EthFlowData = {
  buyToken: "0x02e7f808990638e9e67e1f00313037ede2362361",
  receiver: "0x2301c916a55e82ae401706ea847e616cdd3bfa6c",
  sellAmount: "222569239751968",
  buyAmount: "250637802716696422686907",
  appData: "0x9976c29708859db876eb50e59ae073dfab1ed881d41ab861c710aa6d2260d7bd",
  validTo: 1794264544,
  quoteId: 1,
};
const REAL_UID = "0x353efa4fa575984529953793ff53ab901d5df9ef922902fce2a2d9848fa7c124ba3cb449bd2b4adddbc894d8697f5170800eadecffffffff";

const FIXED: EthFlowData = {buyToken: USDT, receiver: "0x479c9148a3a409694c309436eb9b1992c88b67cc", sellAmount: "10000000000000000", buyAmount: "12345", appData: keccak256(stringToHex("x")), validTo: 1_800_000_000, quoteId: 42};

const RECEIVER = getAddress(FIXED.receiver);

describe("eth-flow order identity", () => {
  it("a real mainnet order: the UID is the orderbook's (owner = the eth-flow contract, validTo = max)", () => {
    const {uid, digest} = ethFlowOrderId(D1, REAL);
    expect(uid).toBe(REAL_UID);
    expect(uid.slice(0, 66)).toBe(digest);
    // Neither the user's validTo nor the quote id is in the GPv2 order.
    expect(ethFlowOrderId(D1, {...REAL, validTo: 1_700_000_000, quoteId: 999}).uid).toBe(REAL_UID);
  });

  it("digests equal what createOrder returned on each chain's deployed contract for the same data", () => {
    expect(ethFlowOrderId(D1, FIXED).digest).toBe("0x90f363e64dce5cad1224657194c4286416757c243bef7ef13a77558ba10ac5ef");
    expect(ethFlowOrderId(D8453, FIXED).digest).toBe("0x6c8eea7cea7fb9103bc30f9e850c8260097ed91977a106aea19bdae27f3bdd4e");
    expect(ethFlowOrderId(D42161, FIXED).digest).toBe("0x65921cc2936cac620c9f08ff9b058674b7b603d7fefa4f0f9979a56bc30045ac");
  });

  it("the GPv2 order sells the chain's wrapped native, fill-or-kill, no fee, erc20 balances", () => {
    expect(ethFlowGpv2Order(D8453, FIXED)).toEqual({
      sellToken: D8453.wrappedNative, buyToken: USDT, receiver: RECEIVER, sellAmount: FIXED.sellAmount, buyAmount: FIXED.buyAmount,
      validTo: ETH_FLOW_GPV2_VALID_TO, appData: FIXED.appData, feeAmount: "0", kind: "sell", partiallyFillable: false, sellTokenBalance: "erc20", buyTokenBalance: "erc20",
    });
    for (const change of [{buyToken: USDC}, {receiver: ME}, {sellAmount: "10000000000000001"}, {buyAmount: "12346"}, {appData: keccak256(stringToHex("y"))}]) {
      expect(ethFlowOrderId(D1, {...FIXED, ...change}).digest, JSON.stringify(change)).not.toBe(ethFlowOrderId(D1, FIXED).digest);
    }
  });
});

describe("eth-flow calldata", () => {
  const TUPLE = "(address,address,uint256,uint256,bytes32,uint256,uint32,bool,int64)";
  it("selectors are the contract's", () => {
    expect(toFunctionSelector(`createOrder(${TUPLE})`)).toBe(ETH_FLOW_CREATE_SELECTOR);
    expect(toFunctionSelector(`invalidateOrder(${TUPLE})`)).toBe(ETH_FLOW_INVALIDATE_SELECTOR);
    expect(encodeOrdersRead(`0x${"ab".repeat(32)}`)).toBe(`0x9c3f1e90${"ab".repeat(32)}`);
  });

  it("createOrder carries the nine fields in the contract's order, fee 0 and no partial fill", () => {
    const data = encodeCreateOrder(FIXED);
    expect(data.slice(0, 10)).toBe(ETH_FLOW_CREATE_SELECTOR);
    expect(data).toHaveLength(10 + 9 * 64);
    const call = decodeFunctionData({abi: ETH_FLOW_ABI, data});
    expect(call.functionName).toBe("createOrder");
    expect(call.args![0]).toEqual({
      buyToken: USDT, receiver: RECEIVER, sellAmount: 10n ** 16n, buyAmount: 12345n, appData: FIXED.appData,
      feeAmount: 0n, validTo: 1_800_000_000, partiallyFillable: false, quoteId: 42n,
    });
  });

  it("invalidateOrder carries the same data under its own selector", () => {
    const data = encodeInvalidateOrder(FIXED);
    expect(data.slice(0, 10)).toBe(ETH_FLOW_INVALIDATE_SELECTOR);
    expect(data.slice(10)).toBe(encodeCreateOrder(FIXED).slice(10));
  });

  it("decodeEthFlowCall round-trips both calls and reads nothing else", () => {
    const checksummed = {...FIXED, receiver: RECEIVER};
    expect(decodeEthFlowCall(encodeCreateOrder(FIXED))).toEqual({method: "createOrder", order: checksummed});
    expect(decodeEthFlowCall(encodeInvalidateOrder(FIXED))).toEqual({method: "invalidateOrder", order: checksummed});
    expect(decodeEthFlowCall(encodeOrdersRead(`0x${"ab".repeat(32)}`))).toBeNull();
    expect(decodeEthFlowCall("0x")).toBeNull();
    expect(decodeEthFlowCall(`${encodeCreateOrder(FIXED)}00`)).not.toBeUndefined();
    // A fee or a partial fill is not an order this module writes.
    const words = encodeCreateOrder(FIXED).slice(10).match(/.{64}/g)!;
    const withFee = [...words]; withFee[5] = "1".padStart(64, "0");
    const partial = [...words]; partial[7] = "1".padStart(64, "0");
    expect(decodeEthFlowCall(`${ETH_FLOW_CREATE_SELECTOR}${withFee.join("")}`)).toBeNull();
    expect(decodeEthFlowCall(`${ETH_FLOW_CREATE_SELECTOR}${partial.join("")}`)).toBeNull();
  });

  it("refuses malformed order data", () => {
    expect(() => encodeCreateOrder({...FIXED, receiver: ZERO})).toThrow("cow: an eth-flow order must name its receiver");
    expect(() => encodeCreateOrder({...FIXED, buyToken: "0x12"})).toThrow(/addresses are malformed/);
    expect(() => encodeCreateOrder({...FIXED, sellAmount: "0"})).toThrow(/positive decimals/);
    expect(() => encodeCreateOrder({...FIXED, buyAmount: "1.5"})).toThrow(/positive decimals/);
    expect(() => encodeCreateOrder({...FIXED, appData: "0x12"})).toThrow(/appData/);
    expect(() => encodeCreateOrder({...FIXED, validTo: ETH_FLOW_GPV2_VALID_TO})).toThrow(/validTo/);
    expect(() => encodeInvalidateOrder({...FIXED, validTo: 0})).toThrow(/validTo/);
    expect(() => encodeCreateOrder({...FIXED, quoteId: -1})).toThrow(/quote id/);
    expect(() => ethFlowOrderId(D1, {...FIXED, receiver: ZERO})).toThrow(/receiver/);
  });
});

describe("eth-flow data in a status id", () => {
  it("packs to 148 bytes of lowercase hex and back", () => {
    const packed = packEthFlowData(FIXED);
    expect(packed).toMatch(/^[0-9a-f]{296}$/);
    expect(unpackEthFlowData(packed)).toEqual({...FIXED, receiver: RECEIVER});
    expect(encodeCreateOrder(unpackEthFlowData(packed)!)).toBe(encodeCreateOrder(FIXED));
    expect(unpackEthFlowData(packEthFlowData(REAL))).toEqual({...REAL, buyToken: expect.any(String), receiver: expect.any(String)});
  });
  it("reads nothing that is not one", () => {
    const packed = packEthFlowData(FIXED);
    for (const bad of [packed.slice(2), `${packed}00`, packed.toUpperCase(), `0x${packed}`.slice(0, 296), ""]) expect(unpackEthFlowData(bad), bad.slice(0, 12)).toBeNull();
    // A zero receiver, a zero amount, a validTo of 0 or max: not an order.
    expect(unpackEthFlowData(packed.slice(0, 40) + "0".repeat(40) + packed.slice(80))).toBeNull();
    expect(unpackEthFlowData(packed.slice(0, 80) + "0".repeat(64) + packed.slice(144))).toBeNull();
    expect(unpackEthFlowData(packed.slice(0, 272) + "ffffffff" + packed.slice(280))).toBeNull();
    expect(unpackEthFlowData(packed.slice(0, 280) + "f".repeat(16))).toBeNull();
  });
});
