// USDT0 Legacy Mesh (2026-11-12): USDT from Ethereum / Arbitrum / Celo into Tron and TON. A fake JSON-RPC per mesh source,
// a fake LayerZero Scan and a fake tonapi behind one fetch (mesh-fixtures.ts). The recipient vectors are real: the bytes32
// `to` of delivered mesh packets on LayerZero Scan and the address the destination paid (TronGrid, toncenter), 2026-11-12.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, pad, toHex, type Hex} from "viem";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import {tonRawAddress} from "@anywalletkit/protocol-swap2-core/util";
import type {CrossChainProvider, Quote} from "@anywalletkit/protocol-swap2-core/types";
import {usdt0Provider} from "../src/provider.js";
import {Usdt0Swap2Protocol} from "../src/protocol.js";
import {describeUsdt0Activity} from "../src/activity.js";
import {
  USDT0_CHAINS, USDT0_MESH_DESTINATIONS, USDT0_MESH_PLACEHOLDER, USDT0_MESH_SOURCES, meshDestTokenMatches, meshDestTxHash, meshRecipientBytes32,
  meshRecipientMatches, tonAccount, tronAccountBytes, tronAddressOf, usdt0, usdt0Pins, usdt0VerifyQuote,
} from "../src/config.js";
import {
  ABI, ARB, ATTACKER, CELO, DST_TX, ETH, FEE_TON, FEE_TRON, RPC, SENDER, SRC_TX, TO_TON, TO_TRON, TON, TON_TO, TON_TO_B32, TON_TO_RAW, TRON, TRON_TO,
  TRON_TO_B32, make, quote, sealedOf, type MeshWorld,
} from "./mesh-fixtures.js";

/** Re-encode one field of a quote's send. */
function edit(q: Quote, f: (sp: Record<string, unknown>, rest: {fee: {nativeFee: bigint; lzTokenFee: bigint}; refund: string}) => void): Quote {
  const d = decodeFunctionData({abi: ABI, data: q.txRequest!.data as Hex});
  const [sp0, fee, refund] = d.args as unknown as [Record<string, unknown>, {nativeFee: bigint; lzTokenFee: bigint}, string];
  const sp = {...sp0};
  const rest = {fee: {...fee}, refund};
  f(sp, rest);
  return {...q, txRequest: {...q.txRequest!, data: encodeFunctionData({abi: ABI, functionName: "send", args: [sp as never, rest.fee, rest.refund as Hex]})}};
}

afterEach(() => vi.unstubAllGlobals());

describe("Legacy Mesh pins", () => {
  it("3 EVM sources, Tron and TON destinations; each peer is the destination OFT's own spelling as bytes32", () => {
    expect(Object.values(USDT0_MESH_SOURCES).map((s) => [s.chainId, s.eid])).toEqual([[1, 30101], [42161, 30110], [42220, 30125]]);
    expect(Object.values(USDT0_MESH_DESTINATIONS).map((d) => [d.caip2, d.eid])).toEqual([["tron:728126428", 30420], ["ton:-239", 30343]]);
    expect(TRON.peer).toBe(pad(toHex(tronAccountBytes(TRON.oft)!), {size: 32}));
    expect(`0:${TON.peer.slice(2)}`).toBe(tonRawAddress(TON.oft));
    // The Arbitrum mesh pool holds the same USDT0 the Arbitrum OFT burns; Ethereum's holds plain USDT.
    expect(ARB.token).toBe(USDT0_CHAINS["eip155:42161"]!.token);
    expect(ETH.token).toBe(USDT0_CHAINS["eip155:1"]!.token);
    // Dry placeholders are the zero account of each family.
    expect(meshRecipientBytes32(TRON, USDT0_MESH_PLACEHOLDER.tron)).toEqual({to: "0x" + "00".repeat(32)});
    expect(meshRecipientBytes32(TON, USDT0_MESH_PLACEHOLDER.ton)).toEqual({to: "0x" + "00".repeat(32)});
  });
});

describe("recipient encoding", () => {
  it("reproduces the `to` of real delivered packets from the address the destination paid", () => {
    expect(meshRecipientBytes32(TRON, TRON_TO)).toEqual({to: TRON_TO_B32});
    expect(meshRecipientBytes32(TON, TON_TO)).toEqual({to: TON_TO_B32});
    expect(meshRecipientBytes32(TON, TON_TO_RAW)).toEqual({to: TON_TO_B32});
    // Read back the way the destination OFT reads it.
    expect(tronAddressOf(tronAccountBytes(TRON_TO)!)).toBe(TRON_TO);
    expect(meshRecipientMatches(TRON, TRON_TO_B32, TRON_TO)).toBe(true);
    expect(meshRecipientMatches(TON, TON_TO_B32, TON_TO)).toBe(true);
    expect(meshRecipientMatches(TON, TON_TO_B32, TON_TO_RAW)).toBe(true);
    // The bounceable spelling of the same account is the same recipient.
    const bounceable = "EQAQskXMoOIlwQZWQaqDmfRsNQaYsyTE5ImQoZ2QMCMqzsOU";
    expect(tonRawAddress(bounceable)).toBe(TON_TO_RAW);
    expect(meshRecipientBytes32(TON, bounceable)).toEqual({to: TON_TO_B32});
  });

  it("refuses a garbled, foreign-family, other-workchain or testnet recipient", () => {
    const garbled = TRON_TO.slice(0, 10) + (TRON_TO[10] === "A" ? "B" : "A") + TRON_TO.slice(11);
    expect(meshRecipientBytes32(TRON, garbled)).toEqual({refusal: "destination must be a Tron address (base58check T…)"});
    expect(meshRecipientBytes32(TRON, SENDER)).toEqual({refusal: "destination must be a Tron address (base58check T…)"});
    expect(meshRecipientBytes32(TRON, TON_TO)).toEqual({refusal: "destination must be a Tron address (base58check T…)"});
    expect(meshRecipientBytes32(TRON, "41ace3e3286b7692028204857bd539c82517372727")).toMatchObject({refusal: expect.stringContaining("Tron address")});
    expect(meshRecipientBytes32(TON, TRON_TO)).toEqual({refusal: "destination must be a TON address (raw 0:… or user-friendly EQ…/UQ…)"});
    expect(meshRecipientBytes32(TON, SENDER)).toMatchObject({refusal: expect.stringContaining("TON address")});
    const tonGarbled = TON_TO.slice(0, 20) + (TON_TO[20] === "A" ? "B" : "A") + TON_TO.slice(21);
    expect(meshRecipientBytes32(TON, tonGarbled)).toMatchObject({refusal: expect.stringContaining("TON address")});
    expect(meshRecipientBytes32(TON, `-1:${TON_TO_RAW.slice(2)}`)).toEqual({refusal: "destination must be a TON workchain 0 address — the USDT0 Legacy Mesh pays on the basechain only, not workchain -1"});
    // The masterchain spelling of a user-friendly address (wc byte 0xff) and a testnet-flagged one.
    const friendly = (tag: number, wc: number) => {
      const b = new Uint8Array(36);
      b[0] = tag; b[1] = wc & 0xff; b.set(Uint8Array.from(TON_TO_B32.slice(2).match(/../g)!.map((h) => parseInt(h, 16))), 2);
      let crc = 0;
      for (const x of b.subarray(0, 34)) { crc ^= x << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
      b[34] = crc >> 8; b[35] = crc & 0xff;
      return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_");
    };
    expect(friendly(0x51, 0)).toBe(TON_TO);
    expect(meshRecipientBytes32(TON, friendly(0x11, -1))).toMatchObject({refusal: expect.stringContaining("not workchain -1")});
    expect(meshRecipientBytes32(TON, friendly(0xd1, 0))).toEqual({refusal: "destination is a testnet-only TON address"});
    expect(tonAccount(friendly(0x22, 0))).toMatchObject({refusal: expect.stringContaining("TON address")});
  });

  it("a swapped recipient never reads back as the requested one", () => {
    const other = tronAddressOf(new Uint8Array(20).fill(7));
    expect(meshRecipientMatches(TRON, TRON_TO_B32, other)).toBe(false);
    expect(meshRecipientMatches(TRON, "0x" + "11".repeat(12) + TRON_TO_B32.slice(26), TRON_TO)).toBe(false); // high bytes set
    expect(meshRecipientMatches(TON, TON_TO_B32, `0:${"22".repeat(32)}`)).toBe(false);
    expect(meshRecipientMatches(TON, TON_TO_B32, `-1:${TON_TO_RAW.slice(2)}`)).toBe(false);
    expect(meshRecipientMatches(TON, "0x1234", TON_TO)).toBe(false);
  });

  it("destination token: USDT by symbol, contract or any TON spelling; nothing else", () => {
    expect(meshDestTokenMatches(TRON, "USDT")).toBe(true);
    expect(meshDestTokenMatches(TRON, "USD₮")).toBe(true);
    expect(meshDestTokenMatches(TRON, TRON.token)).toBe(true);
    expect(meshDestTokenMatches(TRON, "TRX")).toBe(false);
    expect(meshDestTokenMatches(TRON, "USDT0")).toBe(false);
    expect(meshDestTokenMatches(TRON, "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj")).toBe(false);
    expect(meshDestTokenMatches(TON, TON.token)).toBe(true);
    expect(meshDestTokenMatches(TON, tonRawAddress(TON.token)!)).toBe(true);
    expect(meshDestTokenMatches(TON, "USDT")).toBe(true);
    expect(meshDestTokenMatches(TON, "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f")).toBe(false); // USDe
    expect(meshDestTokenMatches(TON, "GRAM")).toBe(false);
    expect(meshDestTxHash("0x" + "AB".repeat(32))).toBe("ab".repeat(32));
  });
});

describe("routes", () => {
  it("EVM sources into Tron / TON only; Tron and TON never as a source", () => {
    const {p} = make();
    expect(p.supportsChain?.("tron:728126428")).toBe(true);
    expect(p.supportsChain?.("tron:0x2b6653dc")).toBe(true);
    expect(p.supportsChain?.("ton:-239")).toBe(true);
    expect(p.supportsChain?.("eip155:42220")).toBe(true);
    expect(p.supportsChainPair?.("eip155:42161", "tron:728126428")).toBe(true);
    expect(p.supportsChainPair?.("eip155:1", "ton:-239")).toBe(true);
    expect(p.supportsChainPair?.("tron:728126428", "eip155:42161")).toBe(false);
    expect(p.supportsChainPair?.("ton:-239", "eip155:1")).toBe(false);
    expect(p.supportsChainPair?.("tron:728126428", "ton:-239")).toBe(false);
    expect(p.supportsChainPair?.("eip155:42220", "eip155:42161")).toBe(false); // Celo is a mesh source, not a USDT0 deployment
    expect(p.supportsChainPair?.("eip155:999", "tron:728126428")).toBe(false); // HyperEVM has no mesh OFT
    expect(p.supportsRoute({chain: "eip155:42161", token: "USDT0"}, {chain: "tron:728126428", token: "USDT"})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:1", token: "USDT"}, {chain: "ton:-239", token: TON.token})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:42220", token: CELO.token}, {chain: "tron:728126428", token: TRON.token})).toBe(true);
    // Celo's catalog "USDT" is a bridged token, not the one the mesh pool takes.
    expect(p.supportsRoute({chain: "eip155:42220", token: "USDT"}, {chain: "tron:728126428", token: "USDT"})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:42161", token: "USDC"}, {chain: "tron:728126428", token: "USDT"})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:42161", token: "USDT0"}, {chain: "tron:728126428", token: "TRX"})).toBe(false);
    expect(p.supportsRoute({chain: "tron:728126428", token: "USDT"}, {chain: "eip155:42161", token: "USDT0"})).toBe(false);
    expect(p.supportsRoute({chain: "ton:-239", token: "USDT"}, {chain: "eip155:1", token: "USDT"})).toBe(false);
    // Without an RPC on any mesh source, Tron / TON are not offered.
    const bare = usdt0Provider({rpcUrls: {"eip155:999": "http://rpc.hype"}});
    expect(bare.supportsChain?.("tron:728126428")).toBe(false);
    expect(bare.supportsRoute({chain: "eip155:42161", token: "USDT0"}, {chain: "tron:728126428", token: "USDT"})).toBe(false);
    // The config view: any role vs. where it can send from.
    expect(usdt0.supportsChain("ton:-239") && !usdt0.supportsSourceChain("ton:-239")).toBe(true);
    expect(usdt0.supports("eip155:1", "tron:728126428") && !usdt0.supports("tron:728126428", "eip155:1")).toBe(true);
  });

  it("the protocol lists EVM source chains only (Celo added, Tron / TON never)", async () => {
    const proto = new Usdt0Swap2Protocol(undefined, {fromChain: "eip155:42161", rpcUrls: RPC, skipAccountChainCheck: true} as never);
    const ids = (await proto.getSupportedChains()).map((c) => String(c.id));
    expect(ids).toContain("eip155:42220");
    expect(ids).toContain("eip155:42161");
    expect(ids.some((id) => id.startsWith("tron:") || id.startsWith("ton:"))).toBe(false);
  });
});

describe("quote", () => {
  it("Arbitrum → Tron: quoteOFT's received amount (− 3 bps) is the floor, quoteSend's fee + headroom the value, approval to the mesh OFT", async () => {
    const {q, reasons} = await quote();
    expect(reasons).toEqual([]);
    expect(q).toMatchObject({
      provider: "usdt0", intentId: "usdt0-mesh:30110:30420", sourceAmount: "10000000", destAmount: "9997000", minDestAmount: "9997000", etaSeconds: 90,
      fees: [{type: "protocol", amount: "3000", token: ARB.token, included: true, description: "USDT0 Legacy Mesh fee"}],
      txRequest: {to: ARB.oft, approvalAddress: ARB.oft, chainId: 42161, value: sealedOf(FEE_TRON).toString(), nativeFee: sealedOf(FEE_TRON).toString(), gasLimit: "450000"},
    });
    expect(q!.feeUsd).toBeCloseTo(0.003, 9);
    const {functionName, args} = decodeFunctionData({abi: ABI, data: q!.txRequest!.data as Hex});
    expect(functionName).toBe("send");
    expect(args).toEqual([
      {dstEid: 30420, to: TRON_TO_B32, amountLD: 10_000_000n, minAmountLD: 9_997_000n, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x"},
      {nativeFee: sealedOf(FEE_TRON), lzTokenFee: 0n},
      SENDER,
    ]);
    expect(q!.providerData).toMatchObject({route: "legacy-mesh", recipient: TRON_TO, recipientBytes32: TRON_TO_B32, minAmountLD: "9997000"});
  });

  it("Ethereum USDT → TON (user-friendly address) and Celo USD₮ by contract → Tron; Ethereum's ETA is the long one", async () => {
    const eth = await quote({sourceChain: "eip155:1", sourceToken: "USDT"}, {}, TO_TON);
    expect(eth.reasons).toEqual([]);
    expect(eth.q).toMatchObject({intentId: "usdt0-mesh:30101:30343", etaSeconds: 300, txRequest: {to: ETH.oft, approvalAddress: ETH.oft, value: sealedOf(FEE_TON).toString()}});
    const [sp] = decodeFunctionData({abi: ABI, data: eth.q!.txRequest!.data as Hex}).args as unknown as [{to: string; dstEid: number}];
    expect(sp).toMatchObject({to: TON_TO_B32, dstEid: 30343});
    const celo = await quote({sourceChain: "eip155:42220", sourceToken: CELO.token});
    expect(celo.reasons).toEqual([]);
    expect(celo.q).toMatchObject({intentId: "usdt0-mesh:30125:30420", txRequest: {to: CELO.oft, approvalAddress: CELO.oft, chainId: 42220}});
    expect((await quote({sourceChain: "eip155:42220", sourceToken: "USDT"})).reasons).toEqual([`source token USDT is not USDT0 (${CELO.token}) on Celo`]);
  });

  it("a dry quote without a recipient prices the zero account; a live one without a recipient is refused", async () => {
    const dry = await quote({destAddress: "", refundAddress: "", dry: true});
    expect(dry.reasons).toEqual([]);
    const [sp] = decodeFunctionData({abi: ABI, data: dry.q!.txRequest!.data as Hex}).args as unknown as [{to: string}];
    expect(sp.to).toBe("0x" + "00".repeat(32));
    expect((await quote({destAddress: ""})).reasons).toEqual(["a live quote needs a recipient"]);
    expect((await quote({refundAddress: ""})).reasons).toEqual(["a live quote needs a refund address"]);
  });

  it("refuses a garbled / swapped-family recipient, a wrong token, a Tron / TON source and a source without a mesh OFT", async () => {
    expect((await quote({destAddress: TRON_TO.slice(0, -1) + (TRON_TO.endsWith("n") ? "m" : "n")})).reasons).toEqual(["destination must be a Tron address (base58check T…)"]);
    expect((await quote({destAddress: SENDER})).reasons).toEqual(["destination must be a Tron address (base58check T…)"]);
    expect((await quote({destAddress: TRON_TO}, {}, TO_TON)).reasons).toEqual(["destination must be a TON address (raw 0:… or user-friendly EQ…/UQ…)"]);
    expect((await quote({destAddress: `-1:${TON_TO_RAW.slice(2)}`}, {}, TO_TON)).reasons[0]).toMatch(/workchain 0 address/);
    expect((await quote({destToken: "TRX"})).reasons).toEqual([`destination token TRX is not USDT0 (${TRON.token}) on Tron`]);
    expect((await quote({sourceToken: "USDC"})).reasons).toEqual([`source token USDC is not USDT0 (${ARB.token}) on Arbitrum`]);
    const fromTron = await quote({sourceChain: "tron:728126428", sourceToken: "USDT", destChain: "eip155:42161", destToken: ARB.token, destAddress: SENDER});
    expect(fromTron.reasons).toEqual(["the USDT0 Legacy Mesh is not wired for a Tron source here: Tron and TON are destinations only (a send from them is signed on that chain)"]);
    expect(fromTron.calls).toEqual([]);
    const fromTon = await quote({sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:1", destToken: "USDT", destAddress: SENDER});
    expect(fromTon.reasons[0]).toMatch(/not wired for a TON source/);
    expect((await quote({sourceChain: "eip155:999", sourceToken: "USDT0"})).reasons).toEqual(["the USDT0 Legacy Mesh is not wired for eip155:999 → Tron: its EVM sources are Ethereum, Arbitrum and Celo"]);
    expect((await quote({amountIn: "0"})).reasons).toEqual(["amount must be positive"]);
    expect((await quote({flex: true})).reasons).toEqual(["the amount is sealed into the calldata (no flexible deposits)"]);
  });

  it("binds the pins on-chain: an unpinned peer (another Tron / TON contract), a foreign token or approval mode refuses the route", async () => {
    const moved = await quote({}, {peer: pad("0x1111111111111111111111111111111111111111", {size: 32})});
    expect(moved.reasons).toEqual(["usdt0: Arbitrum Legacy Mesh OFT has no pinned peer for Tron (eid 30420) — route not wired"]);
    expect((await quote({}, {token: ATTACKER})).reasons[0]).toMatch(/reports token 0x9999…|reports token 0x9999999999999999999999999999999999999999/);
    expect((await quote({}, {approvalRequired: false})).reasons[0]).toMatch(/approvalRequired=false, expected true/);
  });

  it("fees and limits come from the contract: credits cap the amount, a failed fee quote, an LZ-token fee or a high floor refuse", async () => {
    expect((await quote({}, {credits: 9_999_999n})).reasons).toEqual(["amount 10000000 exceeds the OFT maximum 9999999"]);
    expect((await quote({}, {quoteSendFails: "credits"})).reasons[0]).toMatch(/InsufficientCredits/);
    const http = await quote({}, {quoteSendFails: "http"});
    expect(http.reasons).toEqual(["usdt0: RPC for Arbitrum unavailable — try again"]);
    expect(http.q).toBeNull();
    expect((await quote({}, {lzTokenFee: 1n})).reasons).toEqual(["OFT asks for a fee in LZ token — unsupported"]);
    expect((await quote({minAmountOut: "9997001"})).reasons).toEqual(["received 9997000 is below the caller's floor 9997001"]);
    expect((await quote({}, {fee: 7n})).q!.txRequest!.value).toBe(sealedOf(7n).toString());
  });
});

describe("usdt0VerifyQuote on a mesh send (remote backends)", () => {
  it("passes the provider's own sends and refuses another eid, recipient, target, spender, amount, refund, fee or intent", async () => {
    const {q} = await quote();
    expect(usdt0VerifyQuote(TO_TRON, q!)).toBeNull();
    expect(usdt0VerifyQuote({...TO_TRON, destToken: TRON.token, minAmountOut: "9997000"}, q!)).toBeNull();
    expect(usdt0VerifyQuote(TO_TRON, edit(q!, (sp) => { sp.dstEid = 30168; }))).toBe("the send goes to eid 30168, not Tron (30420)");
    expect(usdt0VerifyQuote(TO_TRON, edit(q!, (sp) => { sp.dstEid = TON.eid; }))).toBe("the send goes to eid 30343, not Tron (30420)");
    expect(usdt0VerifyQuote(TO_TRON, edit(q!, (sp) => { sp.to = pad(ATTACKER, {size: 32}); }))).toMatch(/^the send delivers to 0x0+9999/);
    expect(usdt0VerifyQuote(TO_TRON, edit(q!, (sp) => { sp.to = "0x" + "ff".repeat(12) + TRON_TO_B32.slice(26); }))).toMatch(/the send delivers to/);
    expect(usdt0VerifyQuote({...TO_TRON, destAddress: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj"}, q!)).toMatch(/the send delivers to/);
    expect(usdt0VerifyQuote({...TO_TRON, destAddress: "garbage"}, q!)).toBe("destination must be a Tron address (base58check T…)");
    expect(usdt0VerifyQuote(TO_TRON, {...q!, txRequest: {...q!.txRequest!, to: USDT0_CHAINS["eip155:42161"]!.oft}})).toMatch(/not the Arbitrum Legacy Mesh OFT/);
    expect(usdt0VerifyQuote(TO_TRON, {...q!, txRequest: {...q!.txRequest!, approvalAddress: ATTACKER}})).toBe("the Legacy Mesh send approves another spender than its OFT");
    const {approvalAddress: _spender, ...unapproved} = q!.txRequest!;
    expect(usdt0VerifyQuote(TO_TRON, {...q!, txRequest: unapproved})).toBe("the Legacy Mesh send approves another spender than its OFT");
    expect(usdt0VerifyQuote(TO_TRON, edit(q!, (sp) => { sp.amountLD = 1n; }))).toMatch(/not the 10000000 input/);
    expect(usdt0VerifyQuote(TO_TRON, edit(q!, (sp) => { sp.minAmountLD = 1n; }))).toMatch(/below the 9997000 minimum/);
    expect(usdt0VerifyQuote(TO_TRON, edit(q!, (sp) => { sp.composeMsg = "0x01"; }))).toMatch(/compose message/);
    expect(usdt0VerifyQuote(TO_TRON, edit(q!, (_sp, r) => { r.refund = ATTACKER; }))).toMatch(/refunds/);
    expect(usdt0VerifyQuote(TO_TRON, edit(q!, (_sp, r) => { r.fee.lzTokenFee = 1n; }))).toMatch(/LZ-token fee/);
    expect(usdt0VerifyQuote(TO_TRON, {...q!, txRequest: {...q!.txRequest!, value: "1"}})).toMatch(/msg.value/);
    expect(usdt0VerifyQuote(TO_TRON, {...q!, intentId: "usdt0:30110:30420"})).toBe("the intent id does not name this send");
    expect(usdt0VerifyQuote({...TO_TRON, sourceChain: "eip155:999"}, q!)).toBe("not a USDT0 Legacy Mesh route from an EVM source");
    expect(usdt0VerifyQuote({...TO_TRON, destToken: "TRX"}, q!)).toMatch(/destination token TRX/);
  });

  it("a TON send is held to the TON recipient (workchain 0 account hash)", async () => {
    const {q} = await quote({}, {}, TO_TON);
    expect(usdt0VerifyQuote(TO_TON, q!)).toBeNull();
    expect(usdt0VerifyQuote({...TO_TON, destAddress: TON_TO_RAW}, q!)).toBeNull();
    expect(usdt0VerifyQuote({...TO_TON, destAddress: `0:${"22".repeat(32)}`}, q!)).toMatch(/the send delivers to/);
    expect(usdt0VerifyQuote({...TO_TON, destAddress: `-1:${TON_TO_RAW.slice(2)}`}, q!)).toMatch(/workchain 0 address/);
  });

  it("pins: the mesh OFT is a call target and spender on its chains; the remote corridor Arbitrum → TON executes, a swapped recipient does not", async () => {
    const backend = (tamper: boolean): typeof fetch => {
      const handle = createSwap2Handler<string>({providers: [make().p], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
      return (async (url: string, init: RequestInit) => {
        const action = String(url).split("/").pop()!;
        const res = await handle(action, JSON.parse(String(init.body)), "alice");
        let body = res.body as Quote;
        if (tamper && action === "quote") body = edit(body, (sp) => { sp.to = "0x" + "22".repeat(32); });
        return new Response(JSON.stringify(body), {status: res.status, headers: {"content-type": "application/json"}});
      }) as unknown as typeof fetch;
    };
    const app = (fetchImpl: typeof fetch) => {
      const sent: Array<{to: string; data?: string; value?: bigint}> = [];
      const account = {
        getAddress: async () => SENDER, getChainId: async () => 42161, getAllowance: async () => 0n, waitForTransaction: async () => {},
        sendTransaction: async (tx: {to: string; data?: string; value?: bigint}) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
      };
      const provider: CrossChainProvider = remoteProvider({name: "usdt0", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...usdt0Pins});
      class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
      return {sent, swap2: new P(account as never, {fromChain: "eip155:42161"})};
    };
    const REQ = {fromToken: "USDT0", toToken: "USDT", toChain: "ton:-239", recipient: TON_TO, fromTokenAmount: 10_000_000n, minAmountOut: 9_997_000n} as never;
    const ok = app(backend(false));
    await ok.swap2.swap2(REQ);
    // The exact approval to the mesh OFT, then the send with the sealed messaging fee.
    expect(ok.sent.map((t) => [t.to.toLowerCase(), t.value ?? 0n])).toEqual([[ARB.token.toLowerCase(), 0n], [ARB.oft.toLowerCase(), sealedOf(FEE_TON)]]);
    const evil = app(backend(true));
    await expect(evil.swap2.swap2(REQ)).rejects.toThrow(/the send delivers to/);
    expect(evil.sent).toEqual([]);
  });
});

describe("build & preflight", () => {
  it("buildDeposit reproduces the sealed request; preflight passes while the fee fits and the calldata is the sealed send", async () => {
    const {q, p} = await quote();
    const tx = await p.buildDeposit(q!);
    expect(tx).toMatchObject({chain: "eip155:42161", to: ARB.oft, value: sealedOf(FEE_TRON).toString(), chainId: 42161, approvalAddress: ARB.oft, gasLimit: "450000"});
    await expect(p.preflightDeposit!(q!, tx)).resolves.toBeUndefined();
    await expect(p.preflightDeposit!(q!, {...tx, to: USDT0_CHAINS["eip155:42161"]!.oft})).rejects.toThrow(/is not the Arbitrum Legacy Mesh OFT/);
    await expect(p.preflightDeposit!(q!, {...tx, data: edit(q!, (sp) => { sp.to = pad(ATTACKER, {size: 32}); }).txRequest!.data!})).rejects.toThrow("usdt0: the deposit is not the sealed Legacy Mesh send");
    await expect(p.preflightDeposit!(q!, {...tx, data: "0x1234"})).rejects.toThrow("usdt0: the deposit is not the sealed Legacy Mesh send");
    await expect(p.preflightDeposit!(q!, {...tx, value: "1"})).rejects.toThrow(/is not the quoted fee/);
    await expect(p.preflightDeposit!({...q!, providerData: {...q!.providerData, recipient: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj"}}, tx)).rejects.toThrow("usdt0: quote carries no sealed send parameters");
    const later = make({fee: sealedOf(FEE_TRON) + 1n});
    await expect(later.p.preflightDeposit!(q!, tx)).rejects.toThrow(/LayerZero fee rose to/);
    const drained = make({quoteSendFails: "credits"});
    await expect(drained.p.preflightDeposit!(q!, tx)).rejects.toThrow(/InsufficientCredits/);
    const rewired = make({peer: pad(ATTACKER, {size: 32})});
    await expect(rewired.p.preflightDeposit!(q!, tx)).rejects.toThrow(/no pinned peer for Tron/);
  });
});

describe("tracking", () => {
  const packet = (to: string, amount: bigint) => `0x0002${to.slice(2)}${amount.toString(16).padStart(16, "0")}`;
  const message = (dst: typeof TRON | typeof TON, status: string, o: {payload?: string; sender?: string; destHash?: string | null} = {}) => ({
    pathway: {srcEid: ARB.eid, dstEid: dst.eid, sender: {address: (o.sender ?? ARB.oft).toLowerCase()}, receiver: {address: dst.peer}, nonce: 7},
    source: {status: "SUCCEEDED", tx: {txHash: SRC_TX, payload: o.payload ?? packet(dst === TRON ? TRON_TO_B32 : TON_TO_B32, 9_997_000n)}},
    destination: {status: status === "DELIVERED" ? "SUCCEEDED" : "WAITING", ...(o.destHash === null ? {} : {tx: {txHash: o.destHash ?? DST_TX}})},
    guid: "0x" + "11".repeat(32),
    status: {name: status},
  });
  const tonEvent = (o: {status?: string; recipient?: string; amount?: string; inProgress?: boolean; sender?: string; jetton?: string} = {}) => ({
    event_id: DST_TX.slice(2), in_progress: o.inProgress ?? false,
    actions: [
      {type: "SmartContractExec", status: "ok"},
      {type: "JettonTransfer", status: o.status ?? "ok", JettonTransfer: {
        sender: {address: o.sender ?? tonRawAddress(TON.oft)}, recipient: {address: o.recipient ?? TON_TO_RAW}, amount: o.amount ?? "9997000",
        jetton: {address: o.jetton ?? tonRawAddress(TON.token)},
      }},
    ],
  });
  const track = async (o: MeshWorld, intentId = "usdt0-mesh:30110:30420", sourceTxHash: string | null = SRC_TX) => {
    const w = make(o);
    return {status: await w.p.trackIntent({intentId, sourceTxHash}), calls: w.calls};
  };

  it("Tron: pending until Scan indexes the hash; DELIVERED is a paid recipient (the payout runs inside lzReceive)", async () => {
    expect((await track({}, "usdt0-mesh:30110:30420", null)).status).toEqual({state: "pending"});
    expect((await track({})).status).toEqual({state: "pending", depositReceived: false});
    expect((await track({message: message(TRON, "INFLIGHT")})).status).toEqual({state: "pending", depositReceived: true});
    const done = await track({message: message(TRON, "DELIVERED")});
    expect(done.status).toEqual({state: "completed", depositReceived: true, destTxHash: DST_TX.slice(2)});
    expect(done.calls.every((u) => u.startsWith("https://scan.test/v1/messages/tx/"))).toBe(true);
    expect((await track({message: message(TRON, "FAILED")})).status).toEqual({state: "failed", depositReceived: true});
    // A message of another sender (the USDT0 OFT, not the mesh OFT) is not this send.
    expect((await track({message: message(TRON, "DELIVERED", {sender: USDT0_CHAINS["eip155:42161"]!.oft})})).status).toEqual({state: "failed"});
    expect((await track({scanStatus: 500})).status).toEqual({state: "pending"});
  });

  it("TON: DELIVERED completes only when the delivery's trace pays the USDT jetton to the packet's recipient", async () => {
    const intent = "usdt0-mesh:30110:30343";
    const ok = await track({message: message(TON, "DELIVERED"), tonEvent: tonEvent()}, intent);
    expect(ok.status).toEqual({state: "completed", depositReceived: true, destTxHash: DST_TX.slice(2)});
    expect(ok.calls).toContain(`https://ton.test/v2/events/${DST_TX.slice(2)}`);
    expect(ok.calls.every((u) => !u.includes("?"))).toBe(true); // no query string (proxies refuse one)
    expect((await track({message: message(TON, "DELIVERED"), tonEvent: tonEvent({status: "failed"})}, intent)).status).toEqual({state: "failed", depositReceived: true});
    const pending = {state: "pending", depositReceived: true};
    expect((await track({message: message(TON, "DELIVERED"), tonEvent: tonEvent({inProgress: true})}, intent)).status).toEqual(pending);
    expect((await track({message: message(TON, "DELIVERED"), tonEvent: tonEvent({recipient: `0:${"22".repeat(32)}`})}, intent)).status).toEqual(pending);
    expect((await track({message: message(TON, "DELIVERED"), tonEvent: tonEvent({amount: "1"})}, intent)).status).toEqual(pending);
    expect((await track({message: message(TON, "DELIVERED"), tonEvent: tonEvent({sender: `0:${"33".repeat(32)}`})}, intent)).status).toEqual(pending);
    expect((await track({message: message(TON, "DELIVERED"), tonEvent: tonEvent({jetton: `0:${"44".repeat(32)}`})}, intent)).status).toEqual(pending);
    expect((await track({message: message(TON, "DELIVERED"), tonStatus: 429}, intent)).status).toEqual(pending);
    expect((await track({message: message(TON, "DELIVERED", {destHash: null}), tonEvent: tonEvent()}, intent)).status).toEqual(pending);
    expect((await track({message: message(TON, "DELIVERED", {payload: "0x0003" + "00".repeat(48)}), tonEvent: tonEvent()}, intent)).status).toEqual(pending);
  });

  it("a stored payload stays pending (its retry is on Tron / TON); there is no claim; a malformed intent is not a mesh send", async () => {
    expect((await track({message: message(TRON, "PAYLOAD_STORED")})).status).toEqual({state: "pending", depositReceived: true});
    const {p} = make({message: message(TRON, "PAYLOAD_STORED")});
    expect(await p.buildClaim!({intentId: "usdt0-mesh:30110:30420", sourceTxHash: SRC_TX})).toBeNull();
    expect((await track({}, "usdt0-mesh:30110:30420:9")).status).toEqual({state: "failed"});
    expect((await track({}, "usdt0-mesh:30367:30420")).status).toEqual({state: "failed"});
    await expect(p.buildDeposit({intentId: "usdt0-mesh:30110:1", txRequest: {to: ARB.oft}} as Quote)).rejects.toThrow(/no transaction request/);
  });

  it("config guards", () => {
    expect(() => usdt0Provider({tonApiUrl: "ftp://ton"})).toThrow("usdt0: tonApiUrl must use http or https");
  });
});

describe("activity", () => {
  it("a send on a mesh OFT names the Tron / TON destination from the calldata", async () => {
    const {q} = await quote();
    const tx = {
      chain: "eip155:42161", hash: SRC_TX, time: 1, status: "confirmed" as const, address: SENDER, from: SENDER, to: ARB.oft, nativeValue: 5n,
      transfers: [{token: ARB.token, from: SENDER, to: ARB.oft, amount: 10_000_000n, standard: "erc20" as const, symbol: "USDT0", decimals: 6}, {token: null, from: SENDER, to: ARB.oft, amount: 5n}],
      call: {to: ARB.oft, data: q!.txRequest!.data},
    };
    const item = describeUsdt0Activity(tx as never, {own: new Set([SENDER])});
    // The native value is the LayerZero fee: it moves into `fee`, never into what was bridged.
    expect(item).toMatchObject({kind: "bridge", title: "Bridged USDT0 → USDT", subtitle: "USDT0 Legacy Mesh · Arbitrum → Tron"});
    expect(item!.fee).toBeGreaterThanOrEqual(5n);
    expect(item!.assetsOut.map((a) => a.token)).toEqual([ARB.token]);
    const noData = describeUsdt0Activity({...tx, call: {to: ARB.oft, selector: "0xc7c7f5b3"}} as never, {own: new Set([SENDER])});
    expect(noData?.title).toBe("Bridged USDT0");
    // Celo is not a USDT0 deployment: only its mesh OFT is recognized there.
    expect(describeUsdt0Activity({...tx, chain: "eip155:42220", to: CELO.oft, call: {to: CELO.oft, data: q!.txRequest!.data}} as never, {own: new Set([SENDER])})?.subtitle).toBe("USDT0 Legacy Mesh · Celo → Tron");
    expect(describeUsdt0Activity({...tx, chain: "eip155:42220", to: ATTACKER, call: {to: ATTACKER, data: q!.txRequest!.data}} as never, {own: new Set([SENDER])})).toBeNull();
  });
});
