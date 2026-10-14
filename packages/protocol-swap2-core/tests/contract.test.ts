import {describe, expect, it} from "vitest";
import {Swap2UnsupportedOperationError} from "../src/errors.js";
import {validQuote} from "../src/validate.js";
import {remoteProvider} from "../src/remote.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {CrossChainProvider} from "../src/types.js";

describe("core public contract", () => {
  it("exposes typed unsupported-operation errors", () => {
    expect(new Swap2UnsupportedOperationError("no")).toMatchObject({code: "UNSUPPORTED_OPERATION"});
  });

  it("rejects unknown expiry and caller-constraint violations at the shared quote boundary", () => {
    const params = {
      sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:42161",
      destToken: "0x0000000000000000000000000000000000000000", amountIn: "100",
      minAmountOut: "90", slippageBps: 1_000, destAddress: "0x1",
    };
    const quote = {
      provider: "x", intentId: "i", depositAddress: "0x2", depositMemo: null,
      sourceAmount: "100", destAmount: "100", minDestAmount: "90", feeUsd: 0,
      etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
    };
    expect(validQuote(quote, params, "x")).toBe(true);
    expect(validQuote({...quote, validUntilMs: 0}, params, "x")).toBe(false);
    expect(validQuote({...quote, minDestAmount: "89"}, params, "x")).toBe(false);
    // A provider floor computed as floor(dest × (1 − s)) passes (1Click: 99977003 @ 100 bps → 98977232).
    const {minAmountOut: _floor, ...withoutFloor} = params;
    const p100 = {...withoutFloor, slippageBps: 100};
    const q100 = {...quote, sourceAmount: "100", destAmount: "99977003", minDestAmount: "98977232"};
    expect(validQuote(q100, p100, "x")).toBe(true);
    expect(validQuote({...q100, minDestAmount: "98977231"}, p100, "x")).toBe(false);
  });

  it("fails closed for malformed status ids and disabled discovery", async () => {
    const provider: CrossChainProvider = {
      name: "disabled", enabled: () => false, supportsRoute: () => true,
      getQuote: async () => null, buildDeposit: async () => ({chain: "", to: "", value: "0"}),
      trackIntent: async () => ({state: "pending"}),
    };
    class DisabledProtocol extends SingleProviderSwap2 {
      protected readonly provider = provider;
      protected chainSupported(): boolean { return true; }
    }
    const protocol = new DisabledProtocol(undefined, {fromChain: "eip155:1"});
    await expect(protocol.getSupportedChains()).resolves.toEqual([]);
    await expect(protocol.getSupportedTokens()).resolves.toEqual([]);
    await expect(protocol.getSwap2Status("awk1.%ZZ.intent")).rejects.toThrow(/malformed swap2 status id/);
    await expect(protocol.getSwap2Status("awk1.%ZZ.intent")).rejects.toThrow(/malformed swap2 status id/);
    await expect(protocol.getSwap2Status("xyz1.prov.intent")).rejects.toThrow(/malformed swap2 status id/);
    await expect(protocol.quoteSwap2({fromToken: "USDT", toToken: "USDT", toChain: -1, fromTokenAmount: 1n}))
      .rejects.toThrow(/chain id must be a positive safe integer/);
  });

  it("times out every remote action and normalizes its endpoint", async () => {
    let requested = "";
    const provider = remoteProvider({
      name: "remote", baseUrl: "https://remote.invalid///", timeoutMs: 10,
      fetchImpl: async (input, init) => {
        requested = String(input);
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {once: true});
        });
      },
    });
    await expect(provider.trackIntent({intentId: "i"})).rejects.toThrow();
    expect(requested).toBe("https://remote.invalid/track");
  });

  it("attempts allowance cleanup when the approval RPC loses its response", async () => {
    const txRequest = {
      to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
      data: "0xdeadbeef",
      value: "0",
      chainId: 1,
      gasLimit: "21000",
      approvalAddress: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
    };
    const provider: CrossChainProvider = {
      name: "approval-test",
      enabled: () => true,
      supportsRoute: () => true,
      getQuote: async (params) => ({
        provider: "approval-test",
        intentId: "intent",
        depositAddress: "",
        depositMemo: null,
        txRequest,
        sourceAmount: params.amountIn,
        destAmount: "990000",
        minDestAmount: "980000",
        feeUsd: 0,
        etaSeconds: 1,
        reliability: 1,
        validUntilMs: Date.now() + 60_000,
      }),
      buildDeposit: async () => ({chain: "eip155:1", ...txRequest}),
      trackIntent: async () => ({state: "pending"}),
    };
    class ApprovalProtocol extends SingleProviderSwap2 {
      protected readonly provider = provider;
      protected chainSupported(): boolean { return true; }
    }
    const sent: {data?: string}[] = [];
    const account = {
      getAddress: async () => "0x4444444444444444444444444444444444444444",
      getChainId: async () => 1,
      sendTransaction: async (tx: {data?: string}) => {
        sent.push(tx);
        if (sent.length === 2) throw new Error("lost rpc response after broadcast");
        return {hash: `0x${sent.length}`};
      },
    };
    const protocol = new ApprovalProtocol(account, {fromChain: "eip155:1"});
    await expect(protocol.swap2({
      fromToken: "USDT",
      toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9",
      toChain: 42161,
      recipient: "0x3333333333333333333333333333333333333333",
      refundAddress: "0x4444444444444444444444444444444444444444",
      fromTokenAmount: 1_000_000n,
      minAmountOut: 980_000n,
    })).rejects.toThrow("lost rpc response");
    expect(sent).toHaveLength(3);
    expect(sent[0]!.data).toBe(sent[2]!.data); // zero-first and cleanup
    expect(sent[1]!.data).not.toBe(sent[2]!.data); // exact allowance
  });

  it("waits for each approval to be mined before the next step, and stops on a reverted one", async () => {
    const txRequest = {
      to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "21000",
      approvalAddress: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
    };
    const provider: CrossChainProvider = {
      name: "approval-wait", enabled: () => true, supportsRoute: () => true,
      getQuote: async (params) => ({
        provider: "approval-wait", intentId: "intent", depositAddress: "", depositMemo: null, txRequest,
        sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000",
        feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
      }),
      buildDeposit: async () => ({chain: "eip155:1", ...txRequest}),
      trackIntent: async () => ({state: "pending"}),
    };
    class P extends SingleProviderSwap2 {
      protected readonly provider = provider;
      protected chainSupported(): boolean { return true; }
    }
    const options = {
      fromToken: "USDT", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161,
      recipient: "0x3333333333333333333333333333333333333333", fromTokenAmount: 1_000_000n, minAmountOut: 980_000n,
    };
    // Happy path: approve(0) → wait → approve(n) → wait → deposit, strictly in that order.
    const log: string[] = [];
    let n = 0;
    const account = {
      getAddress: async () => "0x4444444444444444444444444444444444444444",
      getChainId: async () => 1,
      sendTransaction: async (tx: {data?: string}) => { n += 1; log.push(`send:${tx.data === "0xdeadbeef" ? "deposit" : `approve${n}`}`); return {hash: `0x${n}`}; },
      waitForTransaction: async (hash: string) => { log.push(`mined:${hash}`); },
    };
    await expect(new P(account, {
      fromChain: "eip155:1",
      // Progress phases interleave with the sends; a throwing observer changes nothing.
      onExecutionPhase: (phase, detail) => {
        log.push(`phase:${phase}${detail?.index ? `${detail.index}/${detail.total}` : ""}${detail?.hash ? `:${detail.hash}` : ""}`);
        throw new Error("observer bug");
      },
    }).swap2(options)).resolves.toMatchObject({hash: "0x3"});
    expect(log).toEqual([
      "phase:approving1/2", "send:approve1", "mined:0x1",
      "phase:approving2/2", "send:approve2", "mined:0x2",
      "phase:signing", "send:deposit", "phase:broadcast:0x3",
    ]);
    // A reverted approval is a hard stop: no deposit, allowance cleanup attempted.
    const log2: string[] = [];
    let m = 0;
    const reverting = {
      ...account,
      sendTransaction: async (tx: {data?: string}) => { m += 1; log2.push(tx.data === "0xdeadbeef" ? "deposit" : `approve${m}`); return {hash: `0x${m}`}; },
      waitForTransaction: async (hash: string) => { if (hash === "0x2") throw new Error("reverted on-chain"); },
    };
    await expect(new P(reverting, {fromChain: "eip155:1"}).swap2(options)).rejects.toThrow(/reverted on-chain/);
    expect(log2).toEqual(["approve1", "approve2", "approve3"]); // zero, exact, cleanup — never the deposit
  });

  it("uses the account transfer surface for a TON jetton deposit", async () => {
    const provider: CrossChainProvider = {
      name: "token-transfer",
      enabled: () => true,
      supportsRoute: () => true,
      getQuote: async (params) => ({
        provider: "token-transfer", intentId: "intent", depositAddress: "EQdeposit", depositMemo: null,
        sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000",
        feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
      }),
      buildDeposit: async (quote) => ({chain: "ton:-239", to: quote.depositAddress, value: quote.sourceAmount}),
      trackIntent: async () => ({state: "pending"}),
    };
    class TokenProtocol extends SingleProviderSwap2 {
      protected readonly provider = provider;
      protected chainSupported(): boolean { return true; }
    }
    const sent: unknown[] = [];
    const transferred: unknown[] = [];
    const account = {
      getAddress: async () => "UQsender",
      getChainId: async () => "ton:-239",
      sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: "native"}; },
      transfer: async (options: unknown) => { transferred.push(options); return {hash: "jetton"}; },
    };
    const executionOptions = {
      fromToken: "USDT", toToken: "0xdac17f958d2ee523a2206206994597c13d831ec7", toChain: 1,
      recipient: "0x3333333333333333333333333333333333333333", fromTokenAmount: 1_000_000n,
      minAmountOut: 980_000n,
    };
    const protocol = new TokenProtocol(account, {fromChain: "ton:-239"});
    await expect(protocol.swap2(executionOptions)).resolves.toMatchObject({hash: "jetton"});
    expect(sent).toHaveLength(0);
    expect(transferred).toEqual([{
      token: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
      recipient: "EQdeposit",
      amount: 1_000_000n,
    }]);

    const nativeFallbacks: unknown[] = [];
    const accountWithoutTransfer = {
      getAddress: async () => "UQsender",
      getChainId: async () => "ton:-239",
      sendTransaction: async (tx: unknown) => { nativeFallbacks.push(tx); return {hash: "native"}; },
    };
    await expect(new TokenProtocol(accountWithoutTransfer, {fromChain: "ton:-239"}).swap2(executionOptions))
      .rejects.toThrow(/requires account\.transfer/);
    expect(nativeFallbacks).toHaveLength(0);
  });

  it("carries a Tron swap memo on the native send and on the TRC-20 transfer surface", async () => {
    const MEMO = "=:ETH.ETH:0x3333333333333333333333333333333333333333:2014026";
    const VAULT = "TAewdzzZPbA8bUUoDqo1Ygh5CbCuq2hrLD";
    const provider: CrossChainProvider = {
      name: "thor-like",
      enabled: () => true,
      supportsRoute: () => true,
      getQuote: async (params) => ({
        provider: "thor-like", intentId: "intent", depositAddress: VAULT, depositMemo: MEMO,
        sourceAmount: params.amountIn, destAmount: "20610030000000000", minDestAmount: "20140260000000000",
        feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
      }),
      buildDeposit: async (quote) => ({chain: "tron:728126428", to: quote.depositAddress, value: quote.sourceAmount, memo: quote.depositMemo!}),
      trackIntent: async () => ({state: "pending"}),
    };
    class TronProtocol extends SingleProviderSwap2 {
      protected readonly provider = provider;
      protected chainSupported(): boolean { return true; }
    }
    const sent: unknown[] = [];
    const transferred: unknown[] = [];
    const account = {
      getAddress: async () => "TSender",
      getChainId: async () => "tron:728126428",
      sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: "trx"}; },
      transfer: async (options: unknown) => { transferred.push(options); return {hash: "trc20"}; },
    };
    const common = {toToken: "0x0000000000000000000000000000000000000000", toChain: 1, recipient: "0x3333333333333333333333333333333333333333"};
    // Native TRX: memo rides as `memo`, never as a TON `body`.
    await expect(new TronProtocol(account, {fromChain: "tron:728126428"}).swap2({
      ...common, fromToken: "TRX", fromTokenAmount: 100_000_000_000n, minAmountOut: 20_140_260_000_000_000n,
    })).resolves.toMatchObject({hash: "trx"});
    expect(sent).toEqual([{to: VAULT, value: 100_000_000_000n, memo: MEMO}]);
    expect(transferred).toHaveLength(0);
    // TRC-20 USDT: the official transfer surface, with the memo alongside.
    await expect(new TronProtocol(account, {fromChain: "tron:728126428"}).swap2({
      ...common, fromToken: "USDT", fromTokenAmount: 50_000_000n, minAmountOut: 20_140_260_000_000_000n,
    })).resolves.toMatchObject({hash: "trc20"});
    expect(transferred).toEqual([{token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", recipient: VAULT, amount: 50_000_000n, memo: MEMO}]);
    expect(sent).toHaveLength(1);
    // A TON jetton with a memo rides the transfer surface too (forward-payload comment, TEP-74).
    const tonProvider: CrossChainProvider = {
      ...provider,
      getQuote: async (params) => ({...(await provider.getQuote(params))!, depositAddress: "EQdeposit"}),
      buildDeposit: async (quote) => ({chain: "ton:-239", to: quote.depositAddress, value: quote.sourceAmount, memo: quote.depositMemo!}),
    };
    class TonProtocol extends SingleProviderSwap2 {
      protected readonly provider = tonProvider;
      protected chainSupported(): boolean { return true; }
    }
    const tonAccount = {...account, getAddress: async () => "UQsender", getChainId: async () => "ton:-239"};
    await expect(new TonProtocol(tonAccount, {fromChain: "ton:-239"}).swap2({
      ...common, fromToken: "USDT", fromTokenAmount: 1_000_000n, minAmountOut: 1n,
    })).resolves.toMatchObject({hash: "trc20"});
    expect(transferred).toHaveLength(2);
    expect(transferred[1]).toMatchObject({recipient: "EQdeposit", amount: 1_000_000n, memo: MEMO});
  });

  it("rejects calldata execution on a non-EVM source before any send", async () => {
    const txRequest = {to: "EQprovider", data: "0xdeadbeef", value: "1000000"};
    const provider: CrossChainProvider = {
      name: "bad-calldata", enabled: () => true, supportsRoute: () => true,
      getQuote: async (params) => ({
        provider: "bad-calldata", intentId: "intent", depositAddress: "", depositMemo: null, txRequest,
        sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000",
        feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
      }),
      buildDeposit: async () => ({chain: "ton:-239", ...txRequest}),
      trackIntent: async () => ({state: "pending"}),
    };
    class CalldataProtocol extends SingleProviderSwap2 {
      protected readonly provider = provider;
      protected chainSupported(): boolean { return true; }
    }
    const sent: unknown[] = [];
    const account = {
      getAddress: async () => "UQsender",
      getChainId: async () => "ton:-239",
      sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: "native"}; },
    };
    await expect(new CalldataProtocol(account, {fromChain: "ton:-239"}).swap2({
      fromToken: "USDT", toToken: "USDT", toChain: 1,
      recipient: "0x3333333333333333333333333333333333333333",
      fromTokenAmount: 1_000_000n, minAmountOut: 980_000n,
    })).rejects.toThrow(/calldata execution is not implemented/);
    expect(sent).toHaveLength(0);
  });

  it("revokes allowance when source broadcast returns no hash", async () => {
    const txRequest = {
      to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: "0xdeadbeef", value: "0",
      chainId: 1, gasLimit: "21000", approvalAddress: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
    };
    const provider: CrossChainProvider = {
      name: "missing-hash", enabled: () => true, supportsRoute: () => true,
      getQuote: async (params) => ({
        provider: "missing-hash", intentId: "intent", depositAddress: "", depositMemo: null, txRequest,
        sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000",
        feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
      }),
      buildDeposit: async () => ({chain: "eip155:1", ...txRequest}),
      trackIntent: async () => ({state: "pending"}),
    };
    class MissingHashProtocol extends SingleProviderSwap2 {
      protected readonly provider = provider;
      protected chainSupported(): boolean { return true; }
    }
    const sent: {data?: string}[] = [];
    const account = {
      getAddress: async () => "0x4444444444444444444444444444444444444444",
      getChainId: async () => 1,
      sendTransaction: async (tx: {data?: string}) => {
        sent.push(tx);
        return sent.length === 2 ? {} : {hash: `0x${sent.length}`};
      },
    };
    await expect(new MissingHashProtocol(account, {fromChain: "eip155:1"}).swap2({
      fromToken: "USDC", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161,
      recipient: "0x3333333333333333333333333333333333333333", fromTokenAmount: 1_000_000n,
      minAmountOut: 980_000n,
    })).rejects.toThrow("did not return a source transaction hash");
    expect(sent).toHaveLength(3);
    expect(sent[0]!.data).not.toBe(sent[2]!.data);
  });

  it("executes a provider-serialized transaction only through the account's guarded hook", async () => {
    const WIRE = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const SOL_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    const SENDER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
    const quoteFor = (params: {amountIn: string; sourceToken: string; destChain: string}) => ({
      provider: "serial", intentId: "serial:intent", depositAddress: "", depositMemo: null,
      txRequest: {serializedTx: WIRE, value: params.sourceToken === "SOL" ? params.amountIn : "0"},
      sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000",
      feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
    });
    const provider: CrossChainProvider = {
      name: "serial",
      enabled: () => true,
      supportsSameChain: true,
      supportsRoute: () => true,
      getQuote: async (params) => quoteFor(params),
      buildDeposit: async (quote) => ({chain: "solana:mainnet", to: "", value: quote.txRequest!.value!, serializedTx: quote.txRequest!.serializedTx!}),
      trackIntent: async () => ({state: "pending"}),
    };
    class SerialProtocol extends SingleProviderSwap2 {
      protected readonly provider = provider;
      protected chainSupported(): boolean { return true; }
    }
    const sent: unknown[] = [];
    const serialized: Array<{tx: string; expect: unknown}> = [];
    const account = {
      getAddress: async () => SENDER,
      getChainId: async () => "solana:mainnet",
      sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: "plain"}; },
      transfer: async (tx: unknown) => { sent.push(tx); return {hash: "transfer"}; },
      sendSerializedTransaction: async (tx: string, expect: unknown) => { serialized.push({tx, expect}); return {hash: "serial-sig"}; },
    };
    // (a) SOL → USDC on the same chain: the input plus the native allowance may
    // leave, and the quoted minimum of USDC must arrive.
    const sameChain = new SerialProtocol(account, {fromChain: "solana:mainnet"});
    await expect(sameChain.swap2({
      fromToken: "SOL", toToken: SOL_USDC, toChain: "solana:mainnet", fromTokenAmount: 50_000_000n, minAmountOut: 980_000n,
    })).resolves.toMatchObject({hash: "serial-sig"});
    expect(sent).toHaveLength(0);
    expect(serialized).toEqual([{tx: WIRE, expect: {
      maxValueOut: String(50_000_000n + 20_000_000n),
      tokenIn: {token: SOL_USDC, minAmount: "980000"},
    }}]);
    // (b) USDT → Ethereum (bridge): nothing arrives here, so no tokenIn; only
    // the configured allowance of SOL and exactly the input of USDT may leave.
    serialized.length = 0;
    const bridge = new SerialProtocol(account, {fromChain: "solana:mainnet", serializedNativeAllowance: 5_000_000n});
    await expect(bridge.swap2({
      fromToken: "USDT", toToken: "0xdac17f958d2ee523a2206206994597c13d831ec7", toChain: 1,
      recipient: "0x3333333333333333333333333333333333333333", fromTokenAmount: 1_000_000n, minAmountOut: 980_000n,
    })).resolves.toMatchObject({hash: "serial-sig"});
    expect(serialized).toEqual([{tx: WIRE, expect: {maxValueOut: "5000000", source: {token: SOL_USDT, maxAmount: "1000000"}}}]);
    expect(sent).toHaveLength(0);
    // (c) an account without the hook is refused before anything is sent.
    const plain = {getAddress: account.getAddress, getChainId: account.getChainId, sendTransaction: account.sendTransaction, transfer: account.transfer};
    await expect(new SerialProtocol(plain, {fromChain: "solana:mainnet"}).swap2({
      fromToken: "SOL", toToken: SOL_USDC, toChain: "solana:mainnet", fromTokenAmount: 50_000_000n, minAmountOut: 980_000n,
    })).rejects.toThrow(/requires account\.sendSerializedTransaction/);
    expect(sent).toHaveLength(0);
    // (d) the build must reproduce the quote's serialized bytes.
    const tampered: CrossChainProvider = {...provider, buildDeposit: async (quote) => ({chain: "solana:mainnet", to: "", value: quote.txRequest!.value!, serializedTx: WIRE.replace("A", "B")})};
    class TamperedProtocol extends SingleProviderSwap2 {
      protected readonly provider = tampered;
      protected chainSupported(): boolean { return true; }
    }
    await expect(new TamperedProtocol(account, {fromChain: "solana:mainnet"}).swap2({
      fromToken: "SOL", toToken: SOL_USDC, toChain: "solana:mainnet", fromTokenAmount: 50_000_000n, minAmountOut: 980_000n,
    })).rejects.toThrow(/does not match the validated quote transaction/);
    expect(serialized).toHaveLength(1);
  });
});
