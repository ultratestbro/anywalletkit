// U0 (0.4.12): with `maxPriceImpactBps` unset the provider sends the requests 0.4.11 sent and returns what 0.4.11
// returned, on every path the probe and the quote take (UNISWAP-V4-RESEARCH §5.2 U0, gaps/impact-gate §4.3). The
// fixture is tests/unset-scenarios.ts run against the 0.4.11 dist (origin/main 7535149c): each request's URL and the
// sha256 of its exact body, every refusal, the quote, and each preflight outcome.
//
// One addition is always on and is taken out here before comparing: the deployment check's batch carries
// `eth_getBlockByNumber("latest", false)` as its last item (the gas-validity check reads the block gas limit), once
// per chain. Everything else — every other request byte, the ids, the order — is compared as 0.4.11 sent it.
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider} from "../src/provider.js";
import {SCENARIOS, digest, run, type Recorded} from "./unset-scenarios.js";

type Golden = Omit<Recorded, "requests"> & {requests: Array<[string, string, string]>};
const golden = JSON.parse(readFileSync(new URL("../fixtures/unset-0.4.11.json", import.meta.url), "utf8")) as {module: string; scenarios: Record<string, Golden>};

type Body = {jsonrpc: string; id: number; method: string; params: unknown[]};

/** The request without the gas check's block read (asserted to be the batch's last item, ids untouched). */
function withoutBlockRead([url, body]: [string, string]): {request: [string, string]; blockReads: number} {
  const calls = JSON.parse(body) as Body[];
  const at = calls.findIndex((c) => c.method === "eth_getBlockByNumber");
  if (at < 0) return {request: [url, body], blockReads: 0};
  expect(at).toBe(calls.length - 1);
  expect(calls[at]!.params).toEqual(["latest", false]);
  expect(calls.slice(0, at).map((c) => c.id)).toEqual(calls.slice(0, at).map((_, i) => i));
  return {request: [url, JSON.stringify(calls.slice(0, at))], blockReads: 1};
}

describe("maxPriceImpactBps unset: 0.4.11, byte for byte", () => {
  it("the fixture is 0.4.11's and covers every scenario", () => {
    expect(golden.module).toMatch(/0\.4\.11 \(dist of origin\/main 7535149c\)/);
    expect(Object.keys(golden.scenarios)).toEqual(SCENARIOS.map((s) => s.name));
  });

  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const got = await run(uniswapProvider as never, s, refusalOf);
      const want = golden.scenarios[s.name]!;
      const stripped = got.requests.map(withoutBlockRead);
      // The block read rides only on the deployment check's batch (router and quoter factory() / WETH9()).
      for (const r of stripped.filter((x) => x.blockReads)) expect(digest(r.request)[2]).toMatch(/^(0x[0-9a-fA-F]{40}:0x(c45a0155|4aa4a4fc) ?){4}$/);
      expect(stripped.map((r) => digest(r.request))).toEqual(want.requests);
      expect(got.refusals).toEqual(want.refusals);
      expect(got.quote).toEqual(want.quote);
      expect(got.preflight).toEqual(want.preflight);
    });
  }
});
