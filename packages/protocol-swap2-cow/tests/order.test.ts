// The order's EIP-712 shape against the contracts and against orders that really settled: the type hash and the
// three domain separators are the values GPv2Settlement holds on-chain, the UIDs and the signature are those of
// public mainnet orders.
import {describe, expect, it} from "vitest";
import {hashTypedData, keccak256, stringToHex, type Hex} from "viem";
import {GPV2_CANCELLATIONS_FIELDS, GPV2_DOMAIN_NAME, GPV2_DOMAIN_VERSION, GPV2_ORDER_FIELDS, GPV2_SETTLEMENT} from "@anywalletkit/protocol-swap2-core";
import {
  COW_DOMAIN_NAME,
  COW_DOMAIN_VERSION,
  COW_ORDER_TYPE,
  COW_ORDER_TYPE_HASH,
  cancellationDigest,
  cancellationTypedData,
  cowDomain,
  cowDomainSeparator,
  isOrderUid,
  orderDigest,
  orderTypedData,
  orderUid,
  rawOrderDigest,
  splitOrderUid,
  type CowOrder,
} from "../src/order.js";
import {signedBy} from "../src/permit.js";
import {COW_SETTLEMENT} from "../src/deployments.js";
import {signer} from "./fixtures.js";

// Mainnet order 0x8c53cd3b…, a WETH → WBTC sell signed with EIP-712 (api.cow.fi/mainnet/api/v1/orders/<uid>).
const REAL: CowOrder = {
  sellToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  buyToken: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
  receiver: "0x479c9148a3a409694c309436eb9b1992c88b67cc",
  sellAmount: "199691156692397702",
  buyAmount: "567021",
  validTo: 1794266282,
  appData: "0xc7615b42274337b3360c10e8870527dac5e61844d70ac1d88022a0f8c2bb219b",
  feeAmount: "0",
  kind: "sell",
  partiallyFillable: false,
  sellTokenBalance: "erc20",
  buyTokenBalance: "erc20",
};
const REAL_OWNER = "0x479c9148a3a409694c309436eb9b1992c88b67cc";
const REAL_UID = "0x8c53cd3ba6afe1aa26753328f94c5e4aab9022a7272639d6d87dfe8e28e9c812479c9148a3a409694c309436eb9b1992c88b67cc6af254aa";
const REAL_SIGNATURE = "0xb193e19c4528f2e5286f4cb09aa1521faa53c8d366738f6ffdb6e602fbab013200c2a3a751683c97f17c7d11ce1e970a080ab9e4ff172574f404c14969baba1f1b";

describe("GPv2 order typed data", () => {
  it("the type string hashes to GPv2Order.TYPE_HASH", () => {
    const type = `Order(${COW_ORDER_TYPE.map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(keccak256(stringToHex(type))).toBe(COW_ORDER_TYPE_HASH);
    expect(type).toBe("Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)");
  });

  it("domain separators equal GPv2Settlement.domainSeparator() on Ethereum, Base and Arbitrum", () => {
    expect(cowDomainSeparator(1)).toBe("0xc078f884a2676e1345748b1feace7b0abee5d00ecadb6e574dcdd109a63e8943");
    expect(cowDomainSeparator(8453)).toBe("0xd72ffa789b6fae41254d0b5a13e6e1e92ed947ec6a251edf1cf0b6c02c257b4b");
    expect(cowDomainSeparator(42161)).toBe("0x69d78e7a7cafcaf924483f99f65e8f4e303a99a446db7ab319f9d40e940bced2");
    expect(cowDomain(8453)).toEqual({name: "Gnosis Protocol", version: "v2", chainId: 8453, verifyingContract: COW_SETTLEMENT});
    expect(() => cowDomain(0)).toThrow(/chain id/);
    expect(() => cowDomain(1.5)).toThrow(/chain id/);
  });

  it("a real mainnet order: the digest is the UID's, the UID is the orderbook's, the signature is its owner's", async () => {
    const digest = orderDigest(1, REAL);
    expect(orderUid(digest, REAL_OWNER, REAL.validTo)).toBe(REAL_UID);
    expect(splitOrderUid(REAL_UID)).toEqual({digest, owner: REAL_OWNER, validTo: REAL.validTo});
    expect(await signedBy(digest, REAL_SIGNATURE, REAL_OWNER)).toBe(true);
    expect(await signedBy(digest, REAL_SIGNATURE, signer.address)).toBe(false);
    // The same order on another chain is another order.
    expect(orderDigest(8453, REAL)).not.toBe(digest);
  });

  it("every field is in the digest", () => {
    const base = orderDigest(1, REAL);
    const changed: Partial<Record<keyof CowOrder, unknown>> = {
      sellToken: REAL.buyToken, buyToken: REAL.sellToken, receiver: signer.address, sellAmount: "199691156692397703", buyAmount: "567020",
      validTo: REAL.validTo + 1, appData: `0x${"11".repeat(32)}`,
    };
    for (const [field, value] of Object.entries(changed)) expect(orderDigest(1, {...REAL, [field]: value} as CowOrder), field).not.toBe(base);
    for (const [field, value] of Object.entries({feeAmount: "1", kind: "buy", partiallyFillable: true, sellTokenBalance: "external", buyTokenBalance: "internal"})) {
      expect(rawOrderDigest(1, {...REAL, [field]: value}), field).not.toBe(base);
    }
    // An absent receiver is the zero address in the struct.
    expect(rawOrderDigest(1, {...REAL, receiver: null})).toBe(rawOrderDigest(1, {...REAL, receiver: "0x0000000000000000000000000000000000000000"}));
  });

  it("the typed data an account is shown hashes to the same digest, and it is the shape the engine pins", () => {
    const td = orderTypedData(1, REAL);
    expect(td.primaryType).toBe("Order");
    expect(Object.keys(td.types).sort()).toEqual(["EIP712Domain", "Order"]);
    expect(td.types.Order).toEqual(GPV2_ORDER_FIELDS);
    expect(td.domain).toEqual({name: GPV2_DOMAIN_NAME, version: GPV2_DOMAIN_VERSION, chainId: 1, verifyingContract: GPV2_SETTLEMENT});
    expect([COW_DOMAIN_NAME, COW_DOMAIN_VERSION]).toEqual([GPV2_DOMAIN_NAME, GPV2_DOMAIN_VERSION]);
    expect(Object.keys(td.message)).toEqual(COW_ORDER_TYPE.map((f) => f.name));
    const digest = hashTypedData({domain: td.domain, types: {Order: td.types.Order!}, primaryType: "Order", message: td.message} as never);
    expect(digest).toBe(orderDigest(1, REAL));
    // What wallets do with it: sign the typed data, never a bare digest.
    expect(JSON.parse(JSON.stringify(td))).toEqual(td);
  });

  it("an account's signature over the typed data is the order's signature", async () => {
    const order: CowOrder = {...REAL, receiver: signer.address};
    const td = orderTypedData(42161, order);
    const signature = await signer.signTypedData({domain: td.domain as never, types: {Order: COW_ORDER_TYPE}, primaryType: "Order", message: td.message as never});
    expect(await signedBy(orderDigest(42161, order), signature, signer.address)).toBe(true);
    expect(await signedBy(orderDigest(1, order), signature, signer.address)).toBe(false);
  });
});

describe("order UID", () => {
  const digest = `0x${"ab".repeat(32)}`;
  it("is digest ‖ owner ‖ validTo (4 bytes, big-endian), lowercase", () => {
    const uid = orderUid(digest.toUpperCase().replace("0X", "0x"), signer.address, 0x01020304);
    expect(uid).toBe(`${digest}${signer.address.slice(2).toLowerCase()}01020304`);
    expect(uid).toHaveLength(2 + 112);
    expect(orderUid(digest, signer.address, 0xffffffff).endsWith("ffffffff")).toBe(true);
    expect(orderUid(digest, signer.address, 0).endsWith("00000000")).toBe(true);
  });
  it("refuses a digest that is not 32 bytes and a validTo outside uint32", () => {
    expect(() => orderUid("0x1234", signer.address, 1)).toThrow(/32 bytes/);
    expect(() => orderUid(digest, signer.address, 2 ** 32)).toThrow(/uint32/);
    expect(() => orderUid(digest, signer.address, -1)).toThrow(/uint32/);
    expect(() => orderUid(digest, signer.address, 1.5)).toThrow(/uint32/);
  });
  it("isOrderUid / splitOrderUid take 56 bytes and nothing else", () => {
    expect(isOrderUid(REAL_UID)).toBe(true);
    for (const bad of [REAL_UID.slice(0, -2), `${REAL_UID}00`, REAL_UID.slice(2), 5, null, undefined]) expect(isOrderUid(bad)).toBe(false);
    expect(() => splitOrderUid("0x00")).toThrow(/56 bytes/);
  });
});

describe("off-chain cancellation message", () => {
  it("is OrderCancellations(bytes[] orderUids) under the settlement domain — the shape the engine pins", () => {
    const td = cancellationTypedData(8453, [REAL_UID.toUpperCase().replace("0X", "0x")]);
    expect(td.primaryType).toBe("OrderCancellations");
    expect(td.types.OrderCancellations).toEqual(GPV2_CANCELLATIONS_FIELDS);
    expect(td.domain).toEqual(cowDomain(8453));
    expect(td.message.orderUids).toEqual([REAL_UID]);
  });
  it("the digest is the EIP-712 hash: 0x1901 ‖ separator ‖ keccak(typeHash ‖ keccak(keccak(uid)…))", () => {
    const typeHash = keccak256(stringToHex("OrderCancellations(bytes[] orderUids)"));
    const struct = keccak256(`${typeHash}${keccak256(keccak256(REAL_UID as Hex)).slice(2)}` as Hex);
    expect(cancellationDigest(1, [REAL_UID])).toBe(keccak256(`0x1901${cowDomainSeparator(1).slice(2)}${struct.slice(2)}` as Hex));
  });
  it("an account's signature over it verifies; another chain's does not", async () => {
    const td = cancellationTypedData(1, [REAL_UID]);
    const signature = await signer.signTypedData({domain: td.domain as never, types: {OrderCancellations: GPV2_CANCELLATIONS_FIELDS}, primaryType: "OrderCancellations", message: td.message as never});
    expect(await signedBy(cancellationDigest(1, [REAL_UID]), signature, signer.address)).toBe(true);
    expect(await signedBy(cancellationDigest(8453, [REAL_UID]), signature, signer.address)).toBe(false);
  });
  it("names at least one well-formed UID", () => {
    expect(() => cancellationTypedData(1, [])).toThrow(/at least one/);
    expect(() => cancellationTypedData(1, ["0x12"])).toThrow(/at least one/);
  });
});
