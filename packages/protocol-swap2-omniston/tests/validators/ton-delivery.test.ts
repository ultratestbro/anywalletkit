import "../../src/buffer-global.js";
import {describe, expect, it, vi} from "vitest";
import {Address} from "@ton/core";
import {createOmnistonTonDeliveryLocator} from "../../src/validators/ton.js";

// The first completed Base → TON order (2026-10-20 20:22:02 UTC), as tonapi
// lists it on the recipient: the output position's USD₮ transfer.
const POSITION_RAW = "0:1b589dd8d4780822f70cab5a6b1b56a79430b44f771994053b96e3d3e8b993a6";
const RECIPIENT = "UQDYnhFaWBymayF47tWRMbEemf0D-mS4DnsRju38CTmRAIrc";
const RECIPIENT_RAW = Address.parse(RECIPIENT).toRawString();
const USDT_MASTER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const USDT_RAW = Address.parse(USDT_MASTER).toRawString();
const DELIVERY = "28dd10c6234062c29ed3dfec25817a870d8cfc2fc6f6bf77352dce6845a0b8c0";
const POSITION = Address.parse(POSITION_RAW).toString();

const transfer = (sender: string, amount: string, jetton = USDT_RAW, status = "ok") => ({
  type: "JettonTransfer", status,
  JettonTransfer: {sender: {address: sender}, recipient: {address: RECIPIENT_RAW}, jetton: {address: jetton, symbol: "USD₮"}, amount},
});
const events = (list: unknown[]) => new Response(JSON.stringify({events: list}), {status: 200, headers: {"content-type": "application/json"}});
const live = [
  {event_id: "ffff000000000000000000000000000000000000000000000000000000000000", timestamp: 1792527800, in_progress: false, actions: [{type: "TonTransfer", status: "ok"}]},
  {event_id: DELIVERY, timestamp: 1792527722, in_progress: false, actions: [transfer(POSITION_RAW, "726752")]},
  {event_id: "b4f78fa1b1b13c21cce71dc0dea1f71fea3876e6e9e1e08e2d58539ad3f8604a", timestamp: 1791828214, in_progress: false, actions: [{type: "TonTransfer", status: "ok"}]},
];

describe("createOmnistonTonDeliveryLocator", () => {
  it("returns the tonapi event id of the position's jetton transfer to the recipient", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => events(live));
    const locate = createOmnistonTonDeliveryLocator({fetch: request as unknown as typeof fetch, tonApiUrl: "https://ton.example/", tonApiKey: "key"});
    await expect(locate({positionAddress: POSITION, recipientAddress: RECIPIENT, jettonMasterAddress: USDT_MASTER, minUnits: "726752"})).resolves.toBe(DELIVERY);
    expect(request).toHaveBeenCalledOnce();
    const url = String(request.mock.calls[0]?.[0]);
    const init = request.mock.calls[0]?.[1];
    expect(url).toBe(`https://ton.example/v2/accounts/${encodeURIComponent(Address.parse(RECIPIENT).toString())}/events?limit=20`);
    expect(init?.headers).toEqual({Authorization: "Bearer key"});
    // Raw and friendly spellings of the same position / jetton agree.
    await expect(locate({positionAddress: POSITION_RAW, recipientAddress: RECIPIENT_RAW, jettonMasterAddress: USDT_RAW, minUnits: "700000"})).resolves.toBe(DELIVERY);
  });

  it("refuses a transfer that is too small, from another sender, of another jetton, failed, or still in progress", async () => {
    const run = async (list: unknown[], input: Partial<Parameters<ReturnType<typeof createOmnistonTonDeliveryLocator>>[0]> = {}) => {
      const locate = createOmnistonTonDeliveryLocator({fetch: (async () => events(list)) as unknown as typeof fetch});
      return locate({positionAddress: POSITION, recipientAddress: RECIPIENT, jettonMasterAddress: USDT_MASTER, minUnits: "726752", ...input});
    };
    await expect(run(live, {minUnits: "726753"})).resolves.toBeNull();
    await expect(run([{...live[1], actions: [transfer("0:" + "aa".repeat(32), "726752")]}])).resolves.toBeNull();
    await expect(run([{...live[1], actions: [transfer(POSITION_RAW, "726752", "0:" + "bb".repeat(32))]}])).resolves.toBeNull();
    await expect(run([{...live[1], actions: [transfer(POSITION_RAW, "726752", USDT_RAW, "failed")]}])).resolves.toBeNull();
    await expect(run([{...live[1], in_progress: true}])).resolves.toBeNull();
    await expect(run([])).resolves.toBeNull();
  });

  it("backfill: no position matches any sender, and a start time keeps older transfers out", async () => {
    const older = {...live[1], event_id: "00".repeat(32), timestamp: 1792527000};
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => events([live[1], older]));
    const locate = createOmnistonTonDeliveryLocator({fetch: request as unknown as typeof fetch});
    await expect(locate({recipientAddress: RECIPIENT, jettonMasterAddress: USDT_MASTER, minUnits: "719485", afterTimestamp: 1792527615})).resolves.toBe(DELIVERY);
    expect(String(request.mock.calls[0]?.[0])).toContain("&start_date=1792527615");
    await expect(locate({recipientAddress: RECIPIENT, jettonMasterAddress: USDT_MASTER, minUnits: "719485", afterTimestamp: 1792527900})).resolves.toBeNull();
  });

  it("never throws: tonapi down, malformed input, bad JSON", async () => {
    const down = createOmnistonTonDeliveryLocator({fetch: (async () => new Response("{}", {status: 503})) as unknown as typeof fetch});
    await expect(down({positionAddress: POSITION, recipientAddress: RECIPIENT, jettonMasterAddress: USDT_MASTER, minUnits: "1"})).resolves.toBeNull();
    const throwing = createOmnistonTonDeliveryLocator({fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch});
    await expect(throwing({positionAddress: POSITION, recipientAddress: RECIPIENT, jettonMasterAddress: USDT_MASTER, minUnits: "1"})).resolves.toBeNull();
    const ok = createOmnistonTonDeliveryLocator({fetch: (async () => events(live)) as unknown as typeof fetch});
    await expect(ok({positionAddress: "not-an-address", recipientAddress: RECIPIENT, jettonMasterAddress: USDT_MASTER, minUnits: "1"})).resolves.toBeNull();
    await expect(ok({positionAddress: POSITION, recipientAddress: RECIPIENT, jettonMasterAddress: USDT_MASTER, minUnits: "0"})).resolves.toBeNull();
    const html = createOmnistonTonDeliveryLocator({fetch: (async () => new Response("<html>", {status: 200})) as unknown as typeof fetch});
    await expect(html({positionAddress: POSITION, recipientAddress: RECIPIENT, jettonMasterAddress: USDT_MASTER, minUnits: "1"})).resolves.toBeNull();
  });
});
