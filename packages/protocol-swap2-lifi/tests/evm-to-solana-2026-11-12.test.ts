// EVM → Solana (2026-11-12). Up to 0.7.0 every EVM → Solana quote was refused ("the recipient on a non-EVM destination
// sits in bridge-specific data and cannot be checked here"): BridgeData.receiver is LI.FI's NON_EVM_ADDRESS placeholder
// and the recipient sits in the facet's own data. It is now read for the facets LI.FI routes EVM → Solana through whose
// delivery the transaction binds — Mayan (Swift v2, MCTP, Fast MCTP), Polymer CCTP (the USDC account derived on the
// device), Chainflip and LI.FI Intents — and held to the requested owner and mint; such requests ask LI.FI for those
// bridges only. NEAR Intents, LayerSwap and Smart Deposits pay a deposit address whose order names the recipient off
// chain: refused for this direction. The fixture is read-only answers of the public li.quest/v1/quote (no API key).
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, parseAbi, toFunctionSelector, type Hex} from "viem";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {diamondCallMismatch, type DiamondExpectation} from "../src/calldata.js";
import {lifiProvider, lifiVerifyQuote} from "../src/provider.js";
import {associatedTokenAccount, base58, solanaKey} from "../src/solana-address.js";

afterEach(() => vi.unstubAllGlobals());

type Answer = {tool: string; action: {toAddress: string; slippage: number}; transactionRequest: {data: string}; includedSteps?: {type: string; tool: string}[]};
type Corridor = {name: string; params: QuoteParams; response: Answer};
const live = (JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-12-evm-solana.json", import.meta.url), "utf8")) as {corridors: Corridor[]}).corridors;
const SOLANA_ID = 1151111081099710n;
const NON_EVM = "0x11f111f111f111F111f111f111F111f111f111F1";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL = "11111111111111111111111111111111";
/** A public key that is no one's recipient here. */
const OTHER = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";
const NOT_READ = "the recipient on a non-EVM destination sits in bridge-specific data and cannot be checked here";

const word = (b58: string) => `0x${Array.from(solanaKey(b58)!, (x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
const pick = (name: string) => { const c = live.find((k) => k.name === name); if (!c) throw new Error(name); return c; };
const evm = (c: Corridor) => c.response.transactionRequest.data;

// The facets' ABIs, written from lifinance/contracts (ILiFi.BridgeData, LibSwap.SwapData, each facet's *Data struct).
const BD = "(bytes32 transactionId,string bridge,string integrator,address referrer,address sendingAssetId,address receiver,uint256 minAmount,uint256 destinationChainId,bool hasSourceSwaps,bool hasDestinationCall)";
const SD = "(address callTo,address approveTo,address sendingAssetId,address receivingAssetId,uint256 fromAmount,bytes callData,bool requiresDeposit)";
const DATA: Record<string, string> = {
  Mayan: "(bytes32 nonEVMReceiver,address mayanProtocol,bytes protocolData,address swapProtocol,bytes swapData,address middleToken,uint256 minMiddleAmount,address refundRecipient,uint256 mayanAmountIn)",
  PolymerCCTP: "(uint256 polymerTokenFee,uint256 maxCCTPFee,bytes32 nonEVMReceiver,bytes32 solanaReceiverATA,uint32 minFinalityThreshold,address refundRecipient,bytes hookData)",
  Chainflip: `(bytes nonEVMReceiver,uint32 dstToken,address dstCallReceiver,${SD}[] dstCallSwapData,uint256 gasAmount,bytes cfParameters)`,
  LiFiIntentEscrowV2: `(bytes32 dstCallReceiver,bytes32 recipient,address depositAndRefundAddress,uint256 nonce,uint32 expires,uint32 fillDeadline,address inputOracle,bytes32 outputOracle,bytes32 outputSettler,bytes32 outputToken,uint128 outputAmountMultiplier,${SD}[] dstCallSwapData,bytes outputContext)`,
  NEARIntents: "(bytes32 nonEVMReceiver,bytes32 destinationAsset,address depositAddress,bytes32 quoteId,uint256 deadline,uint256 minAmountOut,address refundRecipient,bytes signature)",
  LayerSwap: "(bytes32 requestId,address depositoryReceiver,address refundRecipient,bytes32 nonEVMReceiver,bytes signature,uint256 deadline)",
  GasZip: "(bytes32 receiverAddress,uint256 destinationChains)",
};
const ABI = parseAbi(Object.entries(DATA).map(([f, t]) => `function swapAndStartBridgeTokensVia${f}(${BD} _bridgeData, ${SD}[] _swapData, ${t} _data)`));

type Args = [Record<string, unknown>, readonly unknown[], Record<string, unknown>];
/** Decodes a recorded Diamond call, lets `edit` change its arguments, and encodes it again (as `as` when given). */
function rewrite(data: string, edit: (a: Args) => void, as?: string): Hex {
  const d = decodeFunctionData({abi: ABI, data: data as Hex});
  const args = structuredClone(d.args) as unknown as Args;
  edit(args);
  return encodeFunctionData({abi: ABI, functionName: (as ?? d.functionName) as never, args: args as never});
}
/** Writes `value` (a 32-byte hex word) at head word `i` of Mayan's protocolData. */
const mayanWord = (i: number, value: Hex) => (a: Args) => {
  const p = a[2].protocolData as string;
  a[2].protocolData = `${p.slice(0, 10 + 64 * i)}${value.slice(2)}${p.slice(10 + 64 * (i + 1))}`;
};
const uint = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** The expectation the provider builds for a corridor (the recipient and mint requested). */
const expectation = (c: Corridor, over: Partial<DiamondExpectation> = {}): DiamondExpectation => ({
  fromToken: (c.response as unknown as {action: {fromToken: {address: string}}}).action.fromToken.address, toToken: c.params.destToken,
  amountIn: BigInt(c.params.amountIn), receiver: c.params.destAddress, sender: c.params.refundAddress!, minOut: 1n, destChainId: SOLANA_ID,
  sameChain: false, evmDestination: false, ...over,
});

/** LI.FI answers the corridor (echoing the slippage asked, as a re-quote at a scaled slippage would). */
function replay(c: Corridor, answer: Answer = c.response) {
  vi.stubGlobal("fetch", async (u: URL) => new Response(JSON.stringify({...answer, action: {...answer.action, slippage: Number(new URL(String(u)).searchParams.get("slippage"))}})));
}
async function outcome(c: Corridor, answer?: Answer, params: QuoteParams = c.params): Promise<string> {
  replay(c, answer);
  const reasons: string[] = [];
  // Recorded at 0.5 %; two-step routes (a source swap, then the bridge) carry LI.FI's per-step minimum, which the
  // provider's floor re-quote would tighten live. The recorded answer stands in for it at a 3 % budget.
  const quote = await lifiProvider().getQuote({...params, slippageBps: 300, onRefusal: (r) => reasons.push(r)});
  if (!quote) return reasons[0] ?? "no reason";
  return lifiVerifyQuote(params, quote) ?? "pass";
}
const withData = (c: Corridor, data: string): Answer => ({...c.response, transactionRequest: {...c.response.transactionRequest, data}});

describe("EVM → Solana: the recipient is read from the bridge's own data", () => {
  it("every recorded Mayan, Polymer, Chainflip and LI.FI Intents answer passes the provider and the remote pin; NEAR Intents and LayerSwap are refused as deposits", async () => {
    const got: Record<string, string> = {};
    for (const c of live) got[c.name] = await outcome(c);
    expect(Object.keys(got)).toHaveLength(16);
    for (const [name, result] of Object.entries(got)) {
      if (/ (near|layerswap)$/.test(name)) expect([name, result]).toEqual([name, expect.stringMatching(/pays a deposit address whose off-chain order names the Solana recipient — the transaction does not bind it$/)]);
      else expect([name, result]).toEqual([name, "pass"]);
    }
    // Five Mayan entry points (Swift v2, MCTP createOrder / bridgeWithFee, Fast MCTP createOrder / bridge) are covered live.
    const mayan = live.filter((c) => c.response.tool.startsWith("mayan")).map((c) => ((decodeFunctionData({abi: ABI, data: evm(c) as Hex}).args as unknown as Args)[2].protocolData as string).slice(0, 10));
    expect(new Set(mayan)).toEqual(new Set(["0xa3a30834", "0x1c59b7fc", "0x2072197f", "0x2337e236", "0xf58b6de8"]));
  });

  it("an answer that names the requested recipient but whose calldata pays another Solana key is refused, on every facet", async () => {
    for (const c of live.filter((k) => !/ (near|layerswap)$/.test(k.name))) {
      const owner = word(c.params.destAddress).slice(2);
      const data = evm(c).toLowerCase();
      expect(data).toContain(owner);
      const evil = data.split(owner).join(word(OTHER).slice(2));
      expect([c.name, await outcome(c, withData(c, evil))]).toEqual([c.name, expect.stringMatching(new RegExp(`(${OTHER}|nonEVMReceiver is ${OTHER}).*not (the recipient )?${c.params.destAddress}`))]);
      // The same answer for a request that named OTHER: the calldata's recipient is not the requested one.
      expect(diamondCallMismatch(evm(c), expectation(c, {receiver: OTHER}))).toMatch(new RegExp(`not (the recipient )?${OTHER}`));
    }
  });

  it("Mayan: nonEVMReceiver and the order's destAddr are both read; the order's chain, payload type, token and entry point are held", () => {
    const swift = pick("base-usdc>solana-sol mayan"); // Swift v2: payloadType w2, destAddr w4, destChainId w5, tokenOut w7
    const e = expectation(swift);
    expect(diamondCallMismatch(evm(swift), e)).toBeNull();
    expect(diamondCallMismatch(rewrite(evm(swift), (a) => { a[2].nonEVMReceiver = word(OTHER); }), e)).toBe(`Mayan's nonEVMReceiver is ${OTHER}, not the recipient ${swift.params.destAddress}`);
    expect(diamondCallMismatch(rewrite(evm(swift), mayanWord(4, word(OTHER))), e)).toBe(`the Mayan order pays ${OTHER} on Solana, not the recipient ${swift.params.destAddress}`);
    expect(diamondCallMismatch(rewrite(evm(swift), mayanWord(5, uint(30n))), e)).toBe("the Mayan order goes to Wormhole chain 30, not Solana");
    expect(diamondCallMismatch(rewrite(evm(swift), mayanWord(2, uint(2n))), e)).toBe("the Mayan call 0xa3a30834 carries payload type 2, not a plain delivery");
    expect(diamondCallMismatch(rewrite(evm(swift), mayanWord(7, word(USDC))), e)).toBe(`the Mayan order delivers ${USDC}, not ${SOL}`);
    expect(diamondCallMismatch(evm(swift), {...e, toToken: USDC})).toBe(`the Mayan order delivers ${SOL}, not ${USDC}`);
    // An entry point whose layout is not read here (Swift v1 createOrderWithToken) is refused, not guessed.
    const v1 = rewrite(evm(swift), (a) => { a[2].protocolData = `0x8e8d142b${(a[2].protocolData as string).slice(10)}`; });
    expect(diamondCallMismatch(v1, e)).toBe("the Mayan call 0x8e8d142b is an entry point whose Solana recipient cannot be checked here");

    const fastBridge = pick("ethereum-usdc>solana-usdc mayanFastMCTP"); // bridge: destAddr w5, destDomain w6, payloadType w9
    expect(diamondCallMismatch(evm(fastBridge), expectation(fastBridge))).toBeNull();
    expect(diamondCallMismatch(rewrite(evm(fastBridge), mayanWord(6, uint(0n))), expectation(fastBridge))).toBe("the Mayan order goes to CCTP domain 0, not Solana");
    expect(diamondCallMismatch(rewrite(evm(fastBridge), mayanWord(9, uint(2n))), expectation(fastBridge))).toMatch(/payload type 2, not a plain delivery/);
    expect(diamondCallMismatch(evm(fastBridge), expectation(fastBridge, {toToken: USDT}))).toBe(`a Mayan CCTP transfer delivers USDC, not ${USDT}`);

    const fastOrder = pick("base-usdc>solana-sol mayanFastMCTP"); // createOrder: destDomain w3, payloadType w5 (3 = order), destAddr w6, tokenOut w7
    expect(diamondCallMismatch(evm(fastOrder), expectation(fastOrder))).toBeNull();
    expect(diamondCallMismatch(rewrite(evm(fastOrder), mayanWord(6, word(OTHER))), expectation(fastOrder))).toMatch(new RegExp(`^the Mayan order pays ${OTHER}`));
    expect(diamondCallMismatch(rewrite(evm(fastOrder), mayanWord(3, uint(6n))), expectation(fastOrder))).toBe("the Mayan order goes to CCTP domain 6, not Solana");
    expect(diamondCallMismatch(rewrite(evm(fastOrder), mayanWord(5, uint(1n))), expectation(fastOrder))).toMatch(/payload type 1, not a plain delivery/);

    const mctpOrder = pick("arbitrum-usdc>solana-sol mayanMCTP"); // createOrder((…, destAddr w3, destChain w4, tokenOut w5, …))
    expect(diamondCallMismatch(evm(mctpOrder), expectation(mctpOrder))).toBeNull();
    expect(diamondCallMismatch(rewrite(evm(mctpOrder), mayanWord(4, uint(2n))), expectation(mctpOrder))).toBe("the Mayan order goes to Wormhole chain 2, not Solana");
    expect(diamondCallMismatch(rewrite(evm(mctpOrder), mayanWord(5, word(USDT))), expectation(mctpOrder))).toBe(`the Mayan order delivers ${USDT}, not ${SOL}`);

    const mctpBridge = pick("base-usdc>solana-usdc mayanMCTP"); // bridgeWithFee: destAddr w4, destDomain w5, payloadType w6
    expect(diamondCallMismatch(evm(mctpBridge), expectation(mctpBridge))).toBeNull();
    expect(diamondCallMismatch(rewrite(evm(mctpBridge), mayanWord(4, word(OTHER))), expectation(mctpBridge))).toMatch(new RegExp(`^the Mayan order pays ${OTHER}`));
    expect(diamondCallMismatch(rewrite(evm(mctpBridge), mayanWord(5, uint(3n))), expectation(mctpBridge))).toBe("the Mayan order goes to CCTP domain 3, not Solana");
  });

  it("Polymer CCTP: CCTP must mint to the requested owner's USDC account, derived on the device", () => {
    const c = pick("ethereum-usdc>solana-usdc polymerStandard");
    const e = expectation(c);
    expect(diamondCallMismatch(evm(c), e)).toBeNull();
    // The owner is the recipient, but CCTP mints to OTHER's USDC account.
    const theirs = base58(associatedTokenAccount(solanaKey(OTHER)!, solanaKey(USDC)!));
    expect(diamondCallMismatch(rewrite(evm(c), (a) => { a[2].solanaReceiverATA = word(theirs); }), e)).toBe(`the Polymer CCTP transfer mints to ${theirs}, not the recipient's USDC account 5N3f1tj9v1vc5TUZ8S7mCAnVmjVKrfnzXWhxLaxyZAgt`);
    // The owner itself as mintRecipient (a wallet, not a token account) is not its USDC account either.
    expect(diamondCallMismatch(rewrite(evm(c), (a) => { a[2].solanaReceiverATA = word(c.params.destAddress); }), e)).toMatch(/^the Polymer CCTP transfer mints to HAgk14/);
    expect(diamondCallMismatch(rewrite(evm(c), (a) => { a[2].nonEVMReceiver = word(OTHER); }), e)).toBe(`Polymer CCTP's nonEVMReceiver is ${OTHER}, not the recipient ${c.params.destAddress}`);
    expect(diamondCallMismatch(evm(c), {...e, toToken: USDT})).toBe(`Polymer CCTP delivers USDC, not ${USDT}`);
  });

  it("Chainflip: the vault swap's 32-byte dstAddress and Solana asset are held to the request", () => {
    const c = pick("ethereum-eth>solana-sol chainflip");
    const e = expectation(c);
    expect(diamondCallMismatch(evm(c), e)).toBeNull();
    expect(diamondCallMismatch(rewrite(evm(c), (a) => { a[2].dstToken = 10; }), e)).toBe(`Chainflip delivers its asset 10, not ${SOL}`);
    expect(diamondCallMismatch(rewrite(evm(c), (a) => { a[2].nonEVMReceiver = word(OTHER); }), e)).toBe(`Chainflip pays ${OTHER} on Solana, not the recipient ${c.params.destAddress}`);
    expect(diamondCallMismatch(rewrite(evm(c), (a) => { a[2].nonEVMReceiver = (word(c.params.destAddress)).slice(0, 42); }), e)).toBe(`Chainflip pays a 20-byte address on Solana, not the recipient ${c.params.destAddress}`);
    const usdc = pick("ethereum-usdc>solana-usdc chainflip");
    expect(diamondCallMismatch(evm(usdc), expectation(usdc))).toBeNull();
    expect(diamondCallMismatch(evm(usdc), expectation(usdc, {toToken: USDT}))).toBe(`Chainflip delivers its asset 10, not ${USDT}`);
  });

  it("LI.FI Intents: the escrowed order's recipient and output token are held to the request", () => {
    const c = pick("arbitrum-usdc>solana-usdc lifiIntents");
    const e = expectation(c);
    expect(diamondCallMismatch(evm(c), e)).toBeNull();
    expect(diamondCallMismatch(rewrite(evm(c), (a) => { a[2].recipient = word(OTHER); }), e)).toBe(`the LI.FI Intents order pays ${OTHER} on Solana, not the recipient ${c.params.destAddress}`);
    expect(diamondCallMismatch(rewrite(evm(c), (a) => { a[2].outputToken = word(USDT); }), e)).toBe(`the LI.FI Intents order delivers ${USDT}, not ${USDC}`);
  });

  it("BridgeData must name Solana and the non-EVM placeholder; another facet, an unknown entry point or broken calldata is refused", () => {
    const c = pick("ethereum-usdc>solana-usdc lifiIntents");
    const e = expectation(c);
    expect(diamondCallMismatch(rewrite(evm(c), (a) => { a[0].destinationChainId = 1n; }), e)).toBe(`bridges to chain 1, not ${SOLANA_ID}`);
    expect(diamondCallMismatch(rewrite(evm(c), (a) => { a[0].receiver = c.params.refundAddress; }), e)).toBe(`BridgeData pays ${c.params.refundAddress!.toLowerCase()}, not LI.FI's non-EVM placeholder 0x11f111f111f111f111f111f111f111f111f111f1, on a Solana route`);
    // A non-EVM destination other than Solana (Sui's LI.FI chain id, say) keeps the non-EVM refusal.
    expect(diamondCallMismatch(rewrite(evm(c), (a) => { a[0].destinationChainId = 9270000000000000n; }), {...e, destChainId: 9270000000000000n})).toBe(NOT_READ);
    // A facet whose Solana recipient is not read (GasZip carries a bytes32 receiver too) keeps the existing refusal.
    const gasZip = rewrite(evm(c), (a) => { a[0].bridge = "gasZipBridge"; a[2] = {receiverAddress: word(c.params.destAddress), destinationChains: 1n}; }, "swapAndStartBridgeTokensViaGasZip");
    expect(gasZip.slice(0, 10)).toBe(toFunctionSelector(`function swapAndStartBridgeTokensViaGasZip(${BD},${SD}[],(bytes32,uint256))`));
    expect(diamondCallMismatch(gasZip, e)).toBe(NOT_READ);
    expect(diamondCallMismatch(`0xdeadbeef${evm(c).slice(10)}`, e)).toBe("unknown Diamond call 0xdeadbeef");
    expect(diamondCallMismatch(evm(c).slice(0, 1200), e)).toMatch(/^the Diamond calldata does not decode/);
    expect(diamondCallMismatch(`${evm(c)}0`, e)).toBe("the calldata is not hex");
    // A request whose recipient or token is not a Solana key at all is refused by name.
    expect(diamondCallMismatch(evm(c), {...e, receiver: c.params.refundAddress!})).toBe(`the recipient ${c.params.refundAddress} is not a Solana address`);
    expect(diamondCallMismatch(evm(c), {...e, toToken: "0x0000000000000000000000000000000000000000"})).toBe("the destination token 0x0000000000000000000000000000000000000000 is not a Solana mint");
    // The EVM path is untouched: the same call checked as an EVM delivery fails on its placeholder receiver.
    expect(diamondCallMismatch(evm(c), {...e, evmDestination: true, receiver: c.params.refundAddress!})).toBe(`pays ${NON_EVM.toLowerCase()}, not ${c.params.refundAddress}`);
  });

  it("NEAR Intents and LayerSwap (deposit addresses) are refused by name, and so is a Smart Deposits answer", async () => {
    const near = pick("ethereum-usdc>solana-usdc near");
    expect(diamondCallMismatch(evm(near), expectation(near))).toBe("NEARIntents pays a deposit address whose off-chain order names the Solana recipient — the transaction does not bind it");
    const ls = pick("base-usdc>solana-usdc layerswap");
    expect(diamondCallMismatch(evm(ls), expectation(ls))).toBe("LayerSwap pays a deposit address whose off-chain order names the Solana recipient — the transaction does not bind it");
    const smart = {...near.response, tool: "smartDeposits", includedSteps: [{type: "cross", tool: "smartDeposits"}]};
    expect(await outcome(near, smart)).toBe("lifi: LI.FI Smart Deposits pay a deposit address whose recipient the transaction does not bind — refused for a Solana destination");
    // Its tool named only in includedSteps is refused the same way.
    expect(await outcome(near, {...near.response, includedSteps: [{type: "cross", tool: "smartDeposits"}]})).toMatch(/Smart Deposits/);
  });
});

describe("EVM → Solana: LI.FI is asked only for the bridges whose recipient is read", () => {
  const READABLE = ["mayan", "mayanMCTP", "mayanFastMCTP", "polymer", "polymerStandard", "chainflip", "lifiIntents"];
  const c = pick("ethereum-usdc>solana-usdc lifiIntents");
  function record(routes: unknown = {routes: []}) {
    const urls: URL[] = [];
    const bodies: {options?: Record<string, unknown>}[] = [];
    vi.stubGlobal("fetch", async (u: URL | string, init?: RequestInit) => {
      const url = new URL(String(u));
      if (url.pathname.endsWith("/advanced/routes")) { bodies.push(JSON.parse(String(init!.body))); return new Response(JSON.stringify(routes)); }
      urls.push(url);
      return new Response(JSON.stringify({...c.response, action: {...c.response.action, slippage: Number(url.searchParams.get("slippage"))}}));
    });
    return {urls, bodies};
  }
  const route = (tool: string) => ({toAmount: "990000", toAmountMin: "985050", steps: [{tool, estimate: {executionDuration: 30}, includedSteps: [{type: "cross", tool}]}]});

  it("/quote carries allowBridges = the readable bridges (the unbound ones still denied); EVM → EVM and Solana sources are unchanged", async () => {
    const {urls} = record();
    expect(await lifiProvider().getQuote(c.params)).not.toBeNull();
    expect(urls[0]!.searchParams.getAll("allowBridges")).toEqual(READABLE);
    expect(urls[0]!.searchParams.getAll("denyBridges")).toEqual(["relaydepository", "garden", "squid", "symbiosis"]);
    await lifiProvider().getQuote({...c.params, destChain: "eip155:8453", destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", destAddress: c.params.refundAddress!});
    expect(urls[1]!.searchParams.getAll("allowBridges")).toEqual([]);
    expect(urls[1]!.searchParams.getAll("denyBridges")).toEqual(["relaydepository", "garden", "squid", "symbiosis"]);
    await lifiProvider().getQuote({sourceChain: "solana:mainnet", sourceToken: "SOL", destChain: "eip155:8453", destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amountIn: "100000000", destAddress: c.params.refundAddress!, refundAddress: c.params.destAddress, dry: false});
    expect(urls[2]!.searchParams.getAll("allowBridges")).toEqual([]);
    expect(urls[2]!.searchParams.getAll("denyBridges")).toEqual([]);
  });

  it("a route policy sees only readable candidates; its pick is kept among them, otherwise all readable bridges are asked", async () => {
    let seen: string[] = [];
    const policy = (pickTool: string) => (options: readonly {tool: string}[]) => { seen = options.map((o) => o.tool); return {allowBridges: [pickTool]}; };
    const {urls, bodies} = record({routes: [route("near"), route("mayan"), route("relaydepository"), route("lifiIntents")]});
    expect(await lifiProvider({chooseRoute: policy("lifiIntents")}).getQuote(c.params)).not.toBeNull();
    expect(bodies[0]!.options).toMatchObject({bridges: {allow: READABLE, deny: ["relaydepository", "garden", "squid", "symbiosis"]}});
    expect(seen).toEqual(["mayan", "lifiIntents"]);
    expect(urls[0]!.searchParams.getAll("allowBridges")).toEqual(["lifiIntents"]);
    await lifiProvider({chooseRoute: () => ({allowBridges: ["near"]})}).getQuote(c.params);
    expect(urls[1]!.searchParams.getAll("allowBridges")).toEqual(READABLE);
  });

  it("a dry quote without a recipient prices a Solana placeholder recipient, not the EVM sender", async () => {
    const {urls} = record();
    await lifiProvider().getQuote({...c.params, destAddress: "", dry: true});
    expect(urls[0]!.searchParams.get("toAddress")).toBe("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
    await lifiProvider().getQuote({...c.params, destChain: "eip155:8453", destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", destAddress: "", dry: true});
    expect(urls[1]!.searchParams.get("toAddress")).toBe(c.params.refundAddress);
  });
});

describe("Solana keys and associated token accounts", () => {
  it("derives the USDC account LI.FI's Polymer answers mint to, for two owners", () => {
    expect(base58(associatedTokenAccount(solanaKey("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk")!, solanaKey(USDC)!))).toBe("5N3f1tj9v1vc5TUZ8S7mCAnVmjVKrfnzXWhxLaxyZAgt");
    expect(base58(associatedTokenAccount(solanaKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")!, solanaKey(USDC)!))).toBe("FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B");
  });

  it("reads exactly 32-byte base58 keys and nothing else", () => {
    for (const k of [SOL, USDC, USDT, OTHER, "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"]) expect(base58(solanaKey(k)!)).toBe(k);
    expect(solanaKey(SOL)).toEqual(new Uint8Array(32));
    for (const bad of ["", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "1111111111111111111111111111111", "111111111111111111111111111111111", `${USDC.slice(0, -1)}0`, `${USDC.slice(0, -1)}l`, `${USDC}z`, "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"]) {
      expect([bad, solanaKey(bad)]).toEqual([bad, null]);
    }
  });
});
