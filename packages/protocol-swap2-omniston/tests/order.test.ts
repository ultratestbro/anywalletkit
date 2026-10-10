import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {validQuote} from "@forgewallet/protocol-swap2-core/validate";
import {omnistonProvider, type OmnistonProviderOptions} from "../src/provider.js";

/**
 * TON → EVM order settlement against responses captured live on 2026-10-10
 * (resolver Arbiter, SDK 0.8.11). Timestamps are shifted to "now"; every other
 * byte is what the venue returned.
 */
const live = JSON.parse(readFileSync(new URL("./fixtures/live-2026-10-10.json", import.meta.url), "utf8"));
const TRADER = "UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq";
const RECIPIENT = "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA";
const JETTON_WALLET = live.baseUsdc.escrowResponse.messages[0].targetAddress as string;
const TRUSTED = {
  "ton:-239": ["EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ"],
  "eip155:8453": ["0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd"],
  "eip155:56": ["0xafCF681272AF10959736f45616eeCBC22D7095E2"],
};

type Quote = Record<string, unknown> & {settlementData: {value: Record<string, unknown>}};

function fresh(event: {value: Quote}, patch: (q: Quote) => void = () => {}): Quote {
  const q = structuredClone(event.value);
  const now = Math.floor(Date.now() / 1000);
  q.quoteTimestamp = now;
  q.settlementData.value.tradeStartDeadline = now + 300;
  patch(q);
  return q;
}

function clientFor(quote: Quote | null, escrow = live.baseUsdc.escrowResponse) {
  const calls: Record<string, unknown[]> = {};
  return {
    calls,
    requestForQuote(request: unknown) {
      (calls.requestForQuote ??= []).push(request);
      const events = [{$case: "ack", value: {rfqId: quote?.rfqId ?? "r"}}, ...(quote ? [{$case: "quoteUpdated", rfqId: quote.rfqId, value: quote}] : [])];
      return {
        subscribe(observer: {next: (e: unknown) => void; complete?: () => void}) {
          for (const e of events) observer.next(e);
          observer.complete?.();
          return {unsubscribe() {}};
        },
      };
    },
    async tonBuildEscrowTransfer(request: unknown) { (calls.tonBuildEscrowTransfer ??= []).push(request); return structuredClone(escrow); },
    orderTrack() { throw new Error("not used"); },
  };
}

function provider(client: ReturnType<typeof clientFor>, extra: Partial<OmnistonProviderOptions> = {}) {
  return omnistonProvider({
    client: client as never,
    quoteSettleMs: 0,
    maxHtlcExecutions: 1,
    trustedSettlementContracts: TRUSTED,
    validateTonJettonWallet: ({walletAddress}) => walletAddress === JETTON_WALLET,
    validateTonEscrowPayload: () => true,
    validateEvmOutputPosition: () => true,
    ...extra,
  });
}

const params = (destChain: string, destToken: string, extra: Record<string, unknown> = {}) => ({
  sourceChain: "ton:-239", sourceToken: "USDT", destChain, destToken,
  amountIn: "5000000", destAddress: RECIPIENT, refundAddress: TRADER, slippageBps: 100, dry: true, ...extra,
});
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BNB_USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";

describe("Omniston TON → EVM orders (live 2026-10-10 fixtures)", () => {
  it("quotes TON USDT → Base USDC from the live response and passes validQuote", async () => {
    const p = params("eip155:8453", BASE_USDC);
    const q = await provider(clientFor(fresh(live.baseUsdc.quoteUpdated))).getQuote(p);
    expect(q?.destAmount).toBe("4953511");
    expect(validQuote(q!, p, "omniston")).toBe(true);
  });

  it("names a fee token for catalog assets without a 1Click id (BNB USDC) so validQuote accepts it", async () => {
    const p = params("eip155:56", BNB_USDC);
    const q = await provider(clientFor(fresh(live.bnbUsdc.quoteUpdated))).getQuote(p);
    expect(q?.fees?.[0]?.token).toBe(BNB_USDC);
    expect(validQuote(q!, p, "omniston")).toBe(true);
  });

  it("refuses — by name — an order quote that does not carry exclusivityTimeout", async () => {
    const refusals: string[] = [];
    const quote = fresh(live.baseUsdc.quoteUpdated, (q) => { delete q.settlementData.value.exclusivityTimeout; });
    const q = await provider(clientFor(quote)).getQuote({...params("eip155:8453", BASE_USDC), onRefusal: (r: string) => refusals.push(r)});
    expect(q).toBeNull();
    expect(refusals).toEqual(["omniston: resolver quote rejected: incomplete order settlement data"]);
  });

  it("names the silent-null branches: no quote, untrusted contract, cap, native leg", async () => {
    const reasons = async (quote: Quote | null, p = params("eip155:8453", BASE_USDC), extra: Partial<OmnistonProviderOptions> = {}) => {
      const refusals: string[] = [];
      await provider(clientFor(quote), extra).getQuote({...p, onRefusal: (r: string) => refusals.push(r)});
      return refusals;
    };
    expect(await reasons(null)).toEqual(["omniston: no resolver quoted this route/amount"]);
    expect(await reasons(fresh(live.baseUsdc.quoteUpdated), params("eip155:8453", BASE_USDC), {
      trustedSettlementContracts: {...TRUSTED, "eip155:8453": ["0x0000000000000000000000000000000000000001"]},
    })).toEqual(["omniston: untrusted eip155:8453 settlement contract 0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd"]);
    expect(await reasons(null, params("eip155:8453", BASE_USDC, {amountIn: "1000000001"}))).toEqual(["omniston: amount above the 1000 USD per-swap cap"]);
    expect(await reasons(null, params("eip155:8453", "0x0000000000000000000000000000000000000000"))).toEqual(["omniston: cross-chain orders are token corridors only (no ETH native leg)"]);
  });

  it("builds the live escrow transfer and binds the quoted exclusivityTimeout into payload validation", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = clientFor(fresh(live.baseUsdc.quoteUpdated));
    const p = provider(client, {validateTonEscrowPayload: (input) => { seen.push(input); return true; }});
    const q = await p.getQuote(params("eip155:8453", BASE_USDC));
    const tx = await p.buildDeposit(q!);
    expect(tx).toMatchObject({chain: "ton:-239", to: JETTON_WALLET, value: "400000000"});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      exclusivityTimeout: 300,
      inputUnits: "5000000",
      resolverSendsUnits: "4954997",
      srcHtlcSecurityDepositUnits: "500000000",
      protocolAddress: "EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ",
      initialResolverAddress: "EQCOPHYSaiB-c3bH4js_jIIwVhLxikq4edDNbtJcjY0Rsg88",
      destinationChain: "base",
      destinationAddress: RECIPIENT,
    });
  });

  it("still refuses the escrow when the payload validator says no", async () => {
    const p = provider(clientFor(fresh(live.baseUsdc.quoteUpdated)), {validateTonEscrowPayload: () => false});
    const q = await p.getQuote(params("eip155:8453", BASE_USDC));
    await expect(p.buildDeposit(q!)).rejects.toThrow(/failed independent semantic validation/);
  });
});
