// EIP-2612 permits for the vault relayer: the typed data, its digest, the call that rides in the order's hook,
// and the on-chain proof a token must give before it is offered one.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, stringToHex, type Hex} from "viem";
import {GPV2_VAULT_RELAYER, EIP2612_PERMIT_FIELDS} from "@anywalletkit/protocol-swap2-core";
import {
  COW_PERMIT_HOOK_GAS,
  EIP2612_PERMIT_TYPEHASH,
  PERMIT_SELECTOR,
  canonicalSignature,
  detectPermit,
  encodePermitCall,
  permitDigest,
  permitDomainSeparator,
  permitTypedData,
  placeholderPermitCall,
  signedBy,
  simulatePermit,
  splitSignature,
  type PermitRequest,
} from "../src/permit.js";
import {COW_SETTLEMENT, COW_VAULT_RELAYER} from "../src/deployments.js";
import {cowRpc} from "../src/rpc.js";
import {ME, OTHER, RPC, USDC, signer, stub, world} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const REQUEST: PermitRequest = {chainId: 1, token: USDC, domain: {name: "USD Coin", version: "2"}, owner: ME, value: "25000000", nonce: "3", deadline: 1_800_000_000};
const PERMIT_ABI = parseAbi(["function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)"]);
const sign = (p: PermitRequest, by = signer) => {
  const td = permitTypedData(p);
  return by.signTypedData({domain: td.domain as never, types: {Permit: td.types.Permit}, primaryType: "Permit", message: td.message as never});
};

describe("permit typed data", () => {
  it("the type hash is EIP-2612's and the fields are the ones the engine pins", () => {
    expect(keccak256(stringToHex("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"))).toBe(EIP2612_PERMIT_TYPEHASH);
    expect(permitTypedData(REQUEST).types.Permit).toEqual(EIP2612_PERMIT_FIELDS);
    expect(COW_VAULT_RELAYER).toBe(GPV2_VAULT_RELAYER);
  });

  it("domain separators equal USDC's DOMAIN_SEPARATOR() on Ethereum, Base and Arbitrum", () => {
    const usdc = {name: "USD Coin", version: "2"};
    expect(permitDomainSeparator(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", usdc)).toBe("0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335");
    expect(permitDomainSeparator(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", usdc)).toBe("0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f");
    expect(permitDomainSeparator(42161, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", usdc)).toBe("0x08d11903f8419e68b1b8721bcbe2e9fc68569122a77ef18c216f10b3b5112c78");
    expect(permitDomainSeparator(1, USDC, {name: "USD Coin"})).not.toBe(permitDomainSeparator(1, USDC, usdc));
  });

  it("names this owner, the vault relayer as the spender, the value, the nonce and the deadline — nothing else", () => {
    const td = permitTypedData(REQUEST);
    expect(td).toEqual({
      domain: {name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC},
      types: {
        EIP712Domain: [{name: "name", type: "string"}, {name: "version", type: "string"}, {name: "chainId", type: "uint256"}, {name: "verifyingContract", type: "address"}],
        Permit: EIP2612_PERMIT_FIELDS,
      },
      primaryType: "Permit",
      message: {owner: ME, spender: COW_VAULT_RELAYER, value: "25000000", nonce: "3", deadline: "1800000000"},
    });
    const bare = permitTypedData({...REQUEST, domain: {name: "Token"}});
    expect(bare.domain).toEqual({name: "Token", chainId: 1, verifyingContract: USDC});
    expect(bare.types.EIP712Domain.map((f) => f.name)).toEqual(["name", "chainId", "verifyingContract"]);
  });

  it("the digest is 0x1901 ‖ the token's separator ‖ the Permit struct hash", () => {
    const struct = keccak256(encodeAbiParameters(
      [{type: "bytes32"}, {type: "address"}, {type: "address"}, {type: "uint256"}, {type: "uint256"}, {type: "uint256"}],
      [EIP2612_PERMIT_TYPEHASH, ME, COW_VAULT_RELAYER, 25_000_000n, 3n, 1_800_000_000n],
    ));
    const expected = (domain: PermitRequest["domain"]) => keccak256(`0x1901${permitDomainSeparator(1, USDC, domain).slice(2)}${struct.slice(2)}` as Hex);
    expect(permitDigest(REQUEST)).toBe(expected(REQUEST.domain));
    expect(permitDigest({...REQUEST, domain: {name: "Token"}})).toBe(expected({name: "Token"}));
    for (const change of [{value: "25000001"}, {nonce: "4"}, {deadline: 1_800_000_001}, {owner: OTHER}, {chainId: 8453}, {token: COW_SETTLEMENT}]) {
      expect(permitDigest({...REQUEST, ...change}), JSON.stringify(change)).not.toBe(permitDigest(REQUEST));
    }
  });

  it("refuses a malformed request", () => {
    expect(() => permitTypedData({...REQUEST, chainId: 0})).toThrow(/chain id/);
    expect(() => permitTypedData({...REQUEST, domain: {name: ""}})).toThrow(/domain is malformed/);
    expect(() => permitTypedData({...REQUEST, domain: {name: "a\nb"}})).toThrow(/domain is malformed/);
    expect(() => permitTypedData({...REQUEST, domain: {name: "x", version: "y".repeat(65)}})).toThrow(/domain is malformed/);
    expect(() => permitTypedData({...REQUEST, value: "0x10"})).toThrow(/decimals/);
    expect(() => permitTypedData({...REQUEST, nonce: "-1"})).toThrow(/decimals/);
    expect(() => permitTypedData({...REQUEST, deadline: 0xffffffff})).toThrow(/deadline/);
    expect(() => permitTypedData({...REQUEST, deadline: 0})).toThrow(/deadline/);
  });
});

describe("signatures", () => {
  it("an account's typed-data signature is the permit's; anyone else's is not", async () => {
    const signature = await sign(REQUEST);
    expect(await signedBy(permitDigest(REQUEST), signature, ME)).toBe(true);
    expect(await signedBy(permitDigest(REQUEST), signature, OTHER)).toBe(false);
    expect(await signedBy(permitDigest({...REQUEST, value: "25000001"}), signature, ME)).toBe(false);
    expect(await signedBy(permitDigest(REQUEST), await sign(REQUEST, (await import("./fixtures.js")).other), ME)).toBe(false);
  });

  it("splitSignature reads 65 bytes with v 27/28 or 0/1 and nothing else", async () => {
    const signature = await sign(REQUEST);
    const parts = splitSignature(signature)!;
    expect([27, 28]).toContain(parts.v);
    expect(`${parts.r}${parts.s.slice(2)}`).toBe(signature.slice(0, 130));
    const low = `${signature.slice(0, 130)}${(parts.v - 27).toString(16).padStart(2, "0")}`;
    expect(splitSignature(low)).toEqual(parts);
    expect(canonicalSignature(low)).toBe(signature.toLowerCase());
    expect(await signedBy(permitDigest(REQUEST), low, ME)).toBe(true);
    for (const bad of [`${signature.slice(0, 130)}1d`, signature.slice(0, 130), `${signature}00`, "0x", signature.slice(2)]) {
      expect(splitSignature(bad), bad).toBeNull();
      expect(canonicalSignature(bad)).toBeNull();
      expect(await signedBy(permitDigest(REQUEST), bad, ME)).toBe(false);
    }
  });
});

describe("the permit call", () => {
  it("is permit(owner, vaultRelayer, value, deadline, v, r, s) on the token", async () => {
    const signature = await sign(REQUEST);
    const data = encodePermitCall(REQUEST, signature);
    expect(data.slice(0, 10)).toBe(PERMIT_SELECTOR);
    const parts = splitSignature(signature)!;
    expect(decodeFunctionData({abi: PERMIT_ABI, data}).args).toEqual([ME, COW_VAULT_RELAYER, 25_000_000n, 1_800_000_000n, parts.v, parts.r, parts.s]);
    expect(() => encodePermitCall(REQUEST, "0x12")).toThrow(/65 bytes/);
    expect(() => encodePermitCall({...REQUEST, value: "1.5"}, signature)).toThrow(/decimal/);
  });

  it("the quote's placeholder has the same size and shape and authorises nothing", async () => {
    const real = encodePermitCall(REQUEST, await sign(REQUEST));
    const placeholder = placeholderPermitCall(REQUEST);
    expect(placeholder).toHaveLength(real.length);
    expect(placeholder.slice(0, 10 + 64 * 4)).toBe(real.slice(0, 10 + 64 * 4));
    const [, , , , v, r, s] = decodeFunctionData({abi: PERMIT_ABI, data: placeholder}).args;
    expect(await signedBy(permitDigest(REQUEST), `${r}${s.slice(2)}${v.toString(16)}`, ME)).toBe(false);
  });
});

describe("detectPermit", () => {
  const detect = (w = world()) => {
    vi.stubGlobal("fetch", stub(w));
    return detectPermit(cowRpc(RPC), 1, USDC, ME);
  };

  it("finds the domain whose separator the token reports, with the owner's nonce", async () => {
    expect(await detect(world({permitToken: {name: "USD Coin", version: "2", nonce: 7n}}))).toEqual({domain: {name: "USD Coin", version: "2"}, nonce: "7"});
  });
  it("a token without version() is matched against version 1, 2 and no version", async () => {
    const hidden = (version: string | undefined) => world({permitToken: {name: "Token", nonce: 0n, separator: permitDomainSeparator(1, USDC, version === undefined ? {name: "Token"} : {name: "Token", version})}});
    expect((await detect(hidden("1")))?.domain).toEqual({name: "Token", version: "1"});
    expect((await detect(hidden("2")))?.domain).toEqual({name: "Token", version: "2"});
    expect((await detect(hidden(undefined)))?.domain).toEqual({name: "Token"});
    expect(await detect(hidden("3"))).toBeNull();
  });
  it("refuses a token whose permit type is not EIP-2612's (DAI's form)", async () => {
    const dai = keccak256(stringToHex("Permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed)"));
    expect(await detect(world({permitToken: {name: "Dai Stablecoin", version: "1", nonce: 0n, typeHash: dai}}))).toBeNull();
  });
  it("refuses a separator of another domain, a zero separator, a token with no permit, an unreachable node, a chain with no RPC", async () => {
    expect(await detect(world({permitToken: {name: "USD Coin", version: "2", nonce: 0n, separator: permitDomainSeparator(8453, USDC, {name: "USD Coin", version: "2"})}}))).toBeNull();
    expect(await detect(world({permitToken: {name: "USD Coin", version: "2", nonce: 0n, separator: `0x${"00".repeat(32)}`}}))).toBeNull();
    expect(await detect(world({permitToken: null}))).toBeNull();
    expect(await detect(world({rpcDown: true}))).toBeNull();
    vi.stubGlobal("fetch", stub(world()));
    expect(await detectPermit(cowRpc({}), 1, USDC, ME)).toBeNull();
  });
});

describe("simulatePermit", () => {
  const run = async (w = world()) => {
    vi.stubGlobal("fetch", stub(w));
    await simulatePermit(cowRpc(RPC), 1, USDC, COW_SETTLEMENT, encodePermitCall(REQUEST, await sign(REQUEST)));
    return w;
  };
  it("estimates the exact call from the settlement contract", async () => {
    const w = await run();
    const call = w.rpcCalls.find((c) => c.method === "eth_estimateGas")!;
    expect(call.params[0]).toMatchObject({from: COW_SETTLEMENT, to: USDC});
    expect((call.params[0] as {data: string}).data.slice(0, 10)).toBe(PERMIT_SELECTOR);
  });
  it("refuses a permit the token reverts, one that needs more gas than the hook has, and one no RPC could check", async () => {
    await expect(run(world({permitGas: "revert"}))).rejects.toThrow("cow: the token refused the signed permit");
    await expect(run(world({permitGas: 21_000n + (COW_PERMIT_HOOK_GAS * 10n) / 11n + 2n}))).rejects.toThrow(/more than the 100000 the order's hook has/);
    await expect(run(world({permitGas: 21_000n + (COW_PERMIT_HOOK_GAS * 10n) / 11n}))).resolves.toBeDefined();
    await expect(run(world({rpcDown: true}))).rejects.toThrow("cow: the signed permit could not be checked (no RPC answered)");
  });
});
