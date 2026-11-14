import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {encodeAbiParameters, parseAbiParameters, toFunctionSelector} from "viem";
import {ZEROEX_CHAINS, ZEROEX_NATIVE, ZEROEX_PERMIT2, ZEROEX_SETTLER_MAX_NONCE, ZEROEX_SETTLER_REGISTRY, zeroExChain, zeroExChainId, zeroExChains} from "../src/chains.js";
import {
  REGISTRY_OWNER_OF_SELECTOR, REGISTRY_PREV_SELECTOR, SETTLER_EXECUTE_SELECTOR, SETTLER_NATIVE_CHECK_SELECTOR, SETTLER_PERMIT_ACTIONS,
  ZeroExTransactionError, checkZeroExTransaction, createSettlerResolver, decodeSettlerExecute, zeroExSettlerAddress, zeroExSettlerNonce,
} from "../src/settler.js";
import {ME, NONCE, OLDER_SETTLER, PREV_SETTLER, RPC, SETTLER, USDC, WETH, executeData, opaqueAction, stub, transferFromAction, word} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("selectors and the action table", () => {
  it("execute, ownerOf and prev are the selectors of their signatures", () => {
    expect(toFunctionSelector("execute((address,address,uint256),bytes[],bytes32)")).toBe(SETTLER_EXECUTE_SELECTOR);
    expect(toFunctionSelector("ownerOf(uint256)")).toBe(REGISTRY_OWNER_OF_SELECTOR);
    expect(toFunctionSelector("prev(uint128)")).toBe(REGISTRY_PREV_SELECTOR);
  });

  it("every Permit2 action is keyed by the selector of its signature, and RFQ_VIP is not among them", () => {
    expect(Object.keys(SETTLER_PERMIT_ACTIONS)).toHaveLength(7);
    for (const [selector, action] of Object.entries(SETTLER_PERMIT_ACTIONS)) {
      expect(toFunctionSelector(action.signature), action.name).toBe(selector);
      expect(action.signature.startsWith(`${action.name}(address,((address,uint256),uint256,uint256),`)).toBe(true);
    }
    expect(Object.values(SETTLER_PERMIT_ACTIONS).map((a) => a.name)).not.toContain("RFQ_VIP");
  });

  it("sigWord is where the ABI puts the offset of each action's signature (its last bytes argument)", () => {
    const sig = `0x${"cd".repeat(65)}` as const;
    for (const action of Object.values(SETTLER_PERMIT_ACTIONS)) {
      const inner = action.signature.slice(action.name.length + 1, -1);
      const params = parseAbiParameters(inner);
      const lastBytes = params.map((p) => p.type).lastIndexOf("bytes");
      const values = params.map((p, i) => (p.type === "address" ? ME : p.type === "tuple" ? [[USDC, 1n], 2n, 3n] : p.type === "bool" ? false : p.type === "bytes" ? (i === lastBytes ? sig : "0x1234") : 0n));
      const encoded = encodeAbiParameters(params, values as never).slice(2);
      const offset = parseInt(encoded.slice(64 * action.sigWord, 64 * action.sigWord + 64), 16);
      expect(encoded.slice(offset * 2, offset * 2 + 64), action.name).toBe(word(65));
      expect(encoded.slice(offset * 2 + 64, offset * 2 + 64 + 130), action.name).toBe("cd".repeat(65));
    }
  });
});

describe("chain table", () => {
  it("serves the seven ticket chains, each with the one registry and a wrapped native", () => {
    expect(Object.keys(ZEROEX_CHAINS).map(Number).sort((a, b) => a - b)).toEqual([1, 10, 56, 137, 8453, 42161, 43114]);
    for (const c of Object.values(ZEROEX_CHAINS)) {
      expect(c.registry).toBe(ZEROEX_SETTLER_REGISTRY);
      expect(c.wrappedNative).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
  it("is config: an entry adds or replaces a chain, null removes one, a bad entry throws", () => {
    const t = zeroExChains({130: {name: "Unichain", registry: ZEROEX_SETTLER_REGISTRY, maxSettlerNonce: 4}, 56: null});
    expect(zeroExChain(t, 130)?.name).toBe("Unichain");
    expect(zeroExChain(t, 56)).toBeUndefined();
    expect(zeroExChain(t, 8453)?.name).toBe("Base");
    expect(() => zeroExChains({130: {name: "Unichain", registry: "0x1234", maxSettlerNonce: 4}})).toThrow(/names no Settler registry address/);
    expect(() => zeroExChains({130: {name: "", registry: ZEROEX_SETTLER_REGISTRY, maxSettlerNonce: 4}})).toThrow(/has no name/);
    expect(() => zeroExChains({130: {name: "U", registry: ZEROEX_SETTLER_REGISTRY, maxSettlerNonce: 4, wrappedNative: "weth"}})).toThrow(/wrapped native is not an address/);
  });
  it("reads only eip155 chain ids, and only own table entries", () => {
    expect(zeroExChainId("eip155:8453")).toBe(8453);
    expect(zeroExChainId("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBeNaN();
    expect(zeroExChainId("eip155:0")).toBeNaN();
    expect(zeroExChain(ZEROEX_CHAINS, "constructor" as never)).toBeUndefined();
  });
});

describe("which addresses are 0x Settlers (CREATE3 from the registry, offline)", () => {
  it("NATIVE_CHECK is the selector of its signature", () => {
    expect(toFunctionSelector("NATIVE_CHECK(uint256,uint256)")).toBe(SETTLER_NATIVE_CHECK_SELECTOR);
  });
  // ownerOf(2) / prev(2) as the registry answered them on 2026-11-15 (live acceptance run), every chain of the table.
  const live: [number, string, number][] = [
    [1, "0xaddC26a3854feaBFd20d6BF658254088D83a425A", 21], [1, "0x0cEf320d0c5793ade37964E2661a033771e53cd5", 20],
    [10, "0x11B9a527DFD522888A366C511A7bfd08C7d54Df0", 21], [10, "0x454BDc06b3d5a9968abf2709421D746249d871AD", 20],
    [56, "0xd52E8e422A352ac1AfDC2bd6EC533D41B20ACB7b", 23], [56, "0x5Be10189f009334aaCAe23d7102D64527E32BbDb", 22],
    [137, "0x73Dae2FdF839AF5f6BC62890f65A4357937cCf04", 20], [137, "0x1cA8dd7e4B0F8162ff899162cD3B1025f02C177b", 19],
    [8453, "0x103502909141F7025a94b7b99A276dCD128e21a8", 22], [8453, "0x7d6839415693801E94cDC4A7d732C9a3FDBbd1D7", 21],
    [42161, "0xf41429fc96ff446B8118359Ba16854e07c393591", 20], [42161, "0x93Ea5E32E9c2bE78a279be03F86b74917537dF51", 19],
    [43114, "0x584A4e93F11331D318165B04099e53708b1FA915", 20], [43114, "0x5fD781C190Aa767F97298cf3F53f9Aa9823d9599", 19],
  ];
  it.each(live)("chain %i: %s is deployment %i of the taker feature", (chainId, address, nonce) => {
    expect(zeroExSettlerAddress(chainId, nonce)).toBe(address);
    expect(zeroExSettlerNonce(chainId, address)).toBe(nonce);
    expect(zeroExSettlerNonce(chainId, address.toLowerCase())).toBe(nonce);
  });
  it("is chain-bound, and never an EOA, Permit2, AllowanceHolder or a malformed value", () => {
    expect(zeroExSettlerNonce(1, "0x103502909141F7025a94b7b99A276dCD128e21a8")).toBeNull(); // Base's Settler, asked on Ethereum
    for (const a of ["0x9999999999999999999999999999999999999999", ZEROEX_PERMIT2, "0x0000000000001fF3684f28c67538d4D072C22734", "0x12", ""]) expect(zeroExSettlerNonce(8453, a)).toBeNull();
    expect(zeroExSettlerNonce(0, SETTLER)).toBeNull();
    expect(() => zeroExSettlerAddress(8453, 0)).toThrow(/positive chain id and nonce/);
    expect(ZEROEX_SETTLER_MAX_NONCE).toBe(1024);
  });
});

describe("createSettlerResolver", () => {
  const resolver = (o: Parameters<typeof stub>[0] = {}, config: Partial<Parameters<typeof createSettlerResolver>[0]> = {}) => {
    const calls: NonNullable<Parameters<typeof stub>[0]>["calls"] = [];
    vi.stubGlobal("fetch", stub({...o, calls}));
    return {calls, r: createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC, ...config})};
  };

  it("reads ownerOf(2) and prev(2) on the pinned registry, checks code at each Settler, and answers current first", async () => {
    const {r, calls} = resolver();
    expect(r.known(8453)).toEqual([]);
    expect(await r.resolve(8453)).toEqual([SETTLER, PREV_SETTLER]);
    expect(calls.map((c) => (c.body as {params: [{to: string; data: string}]}).params[0])).toEqual([
      {to: ZEROEX_SETTLER_REGISTRY, data: `${REGISTRY_OWNER_OF_SELECTOR}${word(2)}`},
      SETTLER,
      {to: ZEROEX_SETTLER_REGISTRY, data: `${REGISTRY_PREV_SELECTOR}${word(2)}`},
      PREV_SETTLER,
    ]);
    expect(calls.map((c) => (c.body as {method: string}).method)).toEqual(["eth_call", "eth_getCode", "eth_call", "eth_getCode"]);
    expect(r.known(8453)).toEqual([SETTLER, PREV_SETTLER]);
  });

  it("reuses a read while it is fresh, reads again when asked to or when it has aged", async () => {
    let now = 1_000_000;
    const {r, calls} = resolver({}, {now: () => now, maxAgeMs: 60_000});
    await r.resolve(8453);
    await r.resolve(8453);
    expect(calls).toHaveLength(4);
    // a fresh read asks the registry again; the code of a Settler already seen is not read twice
    await r.resolve(8453, {fresh: true});
    expect(calls).toHaveLength(6);
    now += 60_001;
    expect(r.known(8453)).toEqual([]);
    await r.resolve(8453);
    expect(calls).toHaveLength(8);
  });

  it("shares one read between concurrent callers", async () => {
    const {r, calls} = resolver();
    await Promise.all([r.resolve(8453), r.resolve(8453), r.resolve(8453)]);
    expect(calls).toHaveLength(4);
  });

  it("a registry without a previous instance answers the current Settler alone", async () => {
    expect(await resolver({registry: {prev: null}}).r.resolve(8453)).toEqual([SETTLER]);
    expect(await resolver({registry: {prev: SETTLER}}).r.resolve(8453)).toEqual([SETTLER]);
  });

  it("follows a rotation on the next fresh read", async () => {
    const {r} = resolver({onRegistryRead: (n) => (n === 1 ? {current: PREV_SETTLER, prev: OLDER_SETTLER} : {current: SETTLER, prev: PREV_SETTLER})});
    expect(await r.resolve(8453)).toEqual([PREV_SETTLER, OLDER_SETTLER]);
    expect(await r.resolve(8453, {fresh: true})).toEqual([SETTLER, PREV_SETTLER]);
  });

  it("refuses a paused feature, a non-address answer, a silent RPC, a missing RPC and an unknown chain", async () => {
    await expect(resolver({registry: {current: null}}).r.resolve(8453)).rejects.toThrow(/reports no taker Settler in force \(paused or removed\)/);
    await expect(resolver({registry: {current: `0x${"ff".repeat(32)}`}}).r.resolve(8453)).rejects.toThrow(/answered something that is not an address/);
    await expect(resolver({registry: {current: "0x0000000000000000000000000000000000000000"}}).r.resolve(8453)).rejects.toThrow(/not an address/);
    await expect(resolver({rpcDown: true}).r.resolve(8453)).rejects.toThrow(/no RPC answered on chain 8453/);
    await expect(resolver().r.resolve(1)).rejects.toThrow(/no RPC is configured for chain 1/);
    await expect(resolver().r.resolve(5)).rejects.toThrow(/chain 5 is not in the 0x chain table/);
    await expect(resolver({registry: {current: null}}).r.resolve(8453)).rejects.toBeInstanceOf(ZeroExTransactionError);
  });

  it("refuses an answer that is not an address the registry deploys Settlers to, and drops such a previous one", async () => {
    const r = resolver({registry: {current: "0x9999999999999999999999999999999999999999"}}).r;
    await expect(r.resolve(8453)).rejects.toThrow("zeroex: the RPC on chain 8453 names 0x9999999999999999999999999999999999999999 as the 0x Settler, which is not an address the 0x registry deploys Settlers to");
    expect(await resolver({registry: {prev: "0x9999999999999999999999999999999999999999"}}).r.resolve(8453)).toEqual([SETTLER]);
    // Base's deployment 22 is not a Settler on Ethereum
    await expect(resolver({}, {rpcUrls: {1: ["https://rpc.test"]}}).r.resolve(1)).rejects.toThrow(/is not an address the 0x registry deploys Settlers to/);
  });

  it("a failed read is not cached", async () => {
    let down = true;
    const inner = stub();
    vi.stubGlobal("fetch", (async (...a: Parameters<typeof fetch>) => (down ? new Response("x", {status: 502}) : inner(...a))) as typeof fetch);
    const r = createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC});
    await expect(r.resolve(8453)).rejects.toThrow(/no RPC answered/);
    down = false;
    expect(await r.resolve(8453)).toEqual([SETTLER, PREV_SETTLER]);
  });
});

describe("decodeSettlerExecute", () => {
  const permit = {token: USDC, amount: 1_000_000n, nonce: NONCE, deadline: 1_800_000_000n};

  it("reads the slippage tuple, the tag and every action of 0x's layout (action 0 last, open-ended)", () => {
    const data = executeData({recipient: ME, buyToken: ZEROEX_NATIVE, min: 398n, first: transferFromAction(permit), firstLength: 0xffff, later: [opaqueAction("0x38c9c147", 4), opaqueAction("0x103b48be", 2)], zid: "77".repeat(32)});
    const e = decodeSettlerExecute(data);
    expect(e).toMatchObject({recipient: ME, buyToken: ZEROEX_NATIVE, minAmountOut: 398n, zidAndAffiliate: `0x${"77".repeat(32)}`});
    expect(e.actions.map((a) => a.selector)).toEqual(["0xc1fb425e", "0x38c9c147", "0x103b48be"]);
    expect(e.actions[0]!.declaredLength).toBe(0xffff);
    expect(e.actions[1]!.declaredLength).toBe(4 + 32 * 4);
    expect(e.bodyLength).toBe((data.length - 10) / 2);
    // the first action's arguments end exactly where the data does
    expect(e.actions[0]!.argsStart + 0xc0).toBe(e.bodyLength);
    expect(e.word(e.actions[0]!.argsStart + 32)).toBe(word(USDC));
    expect(() => e.word(e.bodyLength)).toThrow(/cut short/);
  });

  it("reads a real Permit2-flow swap from Base (public transaction, signature tail removed)", () => {
    const fixture = JSON.parse(read("../fixtures/activity/base-permit2-transfer-from.json")) as {tx: {from: string; to: string; call: {data: string}}};
    const sent = fixture.tx.call.data;
    // what the taker appended: uint256(65) and the 65-byte signature
    expect(sent.slice(-(64 + 130), -130)).toBe(word(65));
    const unsigned = sent.slice(0, -(64 + 130));
    const e = decodeSettlerExecute(unsigned);
    expect(e.recipient.toLowerCase()).toBe(fixture.tx.from);
    expect(e.buyToken.toLowerCase()).toBe("0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196");
    expect(e.minAmountOut).toBe(0x05b9081f6e70def4n);
    expect(e.actions).toHaveLength(4);
    expect(e.actions[0]).toMatchObject({selector: "0xc1fb425e", declaredLength: 0xffff});

    const deadline = 0x6af249cfn;
    const nonce = BigInt(`0x${e.word(e.actions[0]!.argsStart + 96)}`);
    const typed = {
      domain: {name: "Permit2", chainId: 8453, verifyingContract: ZEROEX_PERMIT2},
      types: {
        PermitTransferFrom: [{name: "permitted", type: "TokenPermissions"}, {name: "spender", type: "address"}, {name: "nonce", type: "uint256"}, {name: "deadline", type: "uint256"}],
        TokenPermissions: [{name: "token", type: "address"}, {name: "amount", type: "uint256"}],
      },
      primaryType: "PermitTransferFrom",
      message: {permitted: {token: USDC, amount: "4429071"}, spender: fixture.tx.to, nonce: nonce.toString(), deadline: deadline.toString()},
    };
    const checked = checkZeroExTransaction(
      {to: fixture.tx.to, data: unsigned, value: "0", chainId: 8453, approvalAddress: ZEROEX_PERMIT2, permit2Transfer: JSON.stringify(typed)},
      {chainId: 8453, settlers: [fixture.tx.to], sellToken: USDC, buyToken: "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196", sellAmount: 4_429_071n, recipient: fixture.tx.from, minBuyAmount: 0x05b9081f6e70def4n, nowMs: Number(deadline - 300n) * 1000},
    );
    expect(checked.permitAction).toBe("TRANSFER_FROM");
    expect(checked.permit2?.nonce).toBe(nonce);
    // the signed transaction as it went out no longer ends at the signature slot: only the unsigned form is accepted
    expect(() => checkZeroExTransaction(
      {to: fixture.tx.to, data: sent, value: "0", chainId: 8453, approvalAddress: ZEROEX_PERMIT2, permit2Transfer: JSON.stringify(typed)},
      {chainId: 8453, settlers: [fixture.tx.to], sellToken: USDC, buyToken: "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196", sellAmount: 4_429_071n, recipient: fixture.tx.from, minBuyAmount: 0x05b9081f6e70def4n, nowMs: Number(deadline - 300n) * 1000},
    )).toThrow(/does not read its signature from the end of the data/);
  });

  it("the older inline-signature layout of the API reference example decodes, but is not a transaction this module signs", () => {
    const data = read("./data/docs-inline-signature.txt").trim();
    const e = decodeSettlerExecute(data);
    expect(e.recipient).toBe("0x70A9f34F9b34C64957b9c401A97BfeD35b95049e");
    expect(e.buyToken).toBe("0xdAC17F958D2ee523a2206206994597C13D831ec7");
    const first = e.actions[0]!;
    // its first action does not leave the signature slot at the end of the data
    const sigWords = Object.prototype.hasOwnProperty.call(SETTLER_PERMIT_ACTIONS, first.selector) ? SETTLER_PERMIT_ACTIONS[first.selector]!.sigWord : -1;
    const atEnd = sigWords >= 0 && first.argsStart + parseInt(e.word(first.argsStart + 32 * sigWords).slice(56), 16) === e.bodyLength;
    expect(atEnd).toBe(false);
  });

  const good = executeData({recipient: ME, buyToken: WETH, min: 5n, first: transferFromAction(permit), firstLength: 0xffff});
  const body = good.slice(10);
  const patch = (wordIndex: number, value: string) => `${SETTLER_EXECUTE_SELECTOR}${body.slice(0, 64 * wordIndex)}${value}${body.slice(64 * (wordIndex + 1))}`;
  const refusals: [string, string, RegExp][] = [
    ["what is not hex", "0x1fff991fzz", /not hex bytes/],
    ["an odd number of nibbles", `${good}0`, /not hex bytes/],
    ["another method", `0x12345678${body}`, /does not call Settler\.execute/],
    ["an empty call", "0x", /does not call Settler\.execute/],
    ["data cut inside the head", good.slice(0, 10 + 64 * 3), /cut short/],
    ["a recipient that is not an address", patch(0, "f".repeat(64)), /recipient is not an address/],
    ["a buy token that is not an address", patch(1, `01${"0".repeat(62)}`), /buy token is not an address/],
    ["an action array somewhere else", patch(3, word(0xc0)), /does not place its actions where the ABI does/],
    ["no actions", patch(5, word(0)), /carries 0 actions/],
    ["too many actions", patch(5, word(257)), /carries 257 actions/],
    ["an action offset into the offset table", patch(6, word(0x20)), /action 0 of the Settler call lies outside the data/],
    ["an action offset past the data", patch(7, word(0x4000)), /action 1 of the Settler call lies outside the data/],
    ["an offset that is not small", patch(6, `01${"0".repeat(62)}`), /action offset is out of range/],
    ["a later action that runs past the data", patch(8, word(0x4000)), /action 1 of the Settler call runs past the data/],
    ["an action without a selector", patch(8, word(3)), /action 1 of the Settler call has no selector/],
    ["oversized data", `${SETTLER_EXECUTE_SELECTOR}${"00".repeat(65_540)}`, /larger than any 0x swap/],
  ];
  for (const [name, data, why] of refusals) {
    it(`refuses ${name}`, () => {
      expect(() => decodeSettlerExecute(data)).toThrow(ZeroExTransactionError);
      expect(() => decodeSettlerExecute(data)).toThrow(why);
    });
  }
});
