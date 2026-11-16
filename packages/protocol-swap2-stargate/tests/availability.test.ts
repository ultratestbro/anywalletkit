import {afterEach, describe, expect, it, vi} from "vitest";
import {stargateChainActive, stargateChainCutoff} from "../src/availability.js";
import {stargateProvider} from "../src/provider.js";
import {checkedStargateQuote} from "../src/pins.js";
import {stargateRegistry} from "../src/deployments.js";
import {setup, actor, recipient} from "./helpers/rpc.js";

afterEach(() => vi.useRealTimers());
describe("new-transfer service policy", () => {
  it("refuses Bus before making RPC calls, without breaking historical registry identity", async () => {
    const f = setup();
    await expect(f.quoter.quote({...f.request, mode: "bus"})).rejects.toThrow(/retired/);
    expect(f.reads).toHaveLength(0);
    expect(stargateRegistry.route(f.source.chain, f.source.token, f.destination.chain, f.destination.token)).toBeDefined();
  });
  it("expires Scroll quotes at the published cutoff and rejects builds afterwards", async () => {
    const f = setup("eip155:8453", "eip155:534352", 13);
    const cutoff = stargateChainCutoff(f.destination.chain);
    vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(cutoff - 1000);
    const q = await f.quoter.quote(f.request);
    expect(q.validUntilMs).toBe(cutoff);
    const provider = stargateProvider(f.config);
    const params = {sourceChain: f.source.chain, sourceToken: f.source.token, destChain: f.destination.chain, destToken: f.destination.token, refundAddress: actor, destAddress: recipient, amountIn: String(f.request.amount), dry: false};
    const quote = (await provider.getQuote(params))!;
    expect(quote).not.toBeNull();
    vi.setSystemTime(cutoff);
    expect(stargateChainActive(f.destination.chain)).toBe(false);
    expect(provider.supportsChain!(f.destination.chain)).toBe(false);
    expect(f.quoter.supportsRoute(f.source.chain, f.source.token, f.destination.chain, f.destination.token)).toBe(false);
    await expect(f.quoter.quote(f.request)).rejects.toThrow(/support has ended/);
    expect(() => checkedStargateQuote(quote, stargateRegistry)).toThrow(/support has ended/);
    expect(stargateRegistry.find(f.destination.chain, f.destination.token)).toBeDefined();
  });
});
