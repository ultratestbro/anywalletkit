// U0 (0.4.12): with `maxPriceImpactBps` unset the provider sends the requests 0.4.11 sent and returns what 0.4.11
// returned, on every path the probe and the quote take (UNISWAP-V4-RESEARCH §5.2 U0, gaps/impact-gate §4.3). The
// fixture is tests/unset-scenarios.ts run against the 0.4.11 dist (origin/main 7535149c): each request's URL and the
// sha256 of its exact body, every refusal, the quote, and each preflight outcome.
//
// One addition is always on and is taken out here before comparing: the gas-validity check reads the block gas limit
// with its own request, `eth_getBlockByNumber("latest", false)` alone, once per chain (and every 10 minutes), sent
// after the deployment check. Everything else — every other request byte, the ids, the order — is compared as 0.4.11
// sent it.
//
// The quote has one addition (0.6.0): `gasEstimate` / `gasEstimateSource` (protocol-swap2-core's expected gas used),
// computed from the quoter figure 0.4.11 already read — no request more. The two fields are taken out of the quote
// before it is compared with 0.4.11's and checked on their own (here against the core contract; the figures in
// tests/gas-estimate-u6.test.ts); every other field of the quote is compared as 0.4.11 returned it.
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {gasEstimateProblem} from "@anywalletkit/protocol-swap2-core/validate";
import type {Quote} from "@anywalletkit/protocol-swap2-core/types";
import {uniswapProvider} from "../src/provider.js";
import {SCENARIOS, digest, run, type Recorded} from "./unset-scenarios.js";

type Golden = Omit<Recorded, "requests"> & {requests: Array<[string, string, string]>};
const golden = JSON.parse(readFileSync(new URL("../fixtures/unset-0.4.11.json", import.meta.url), "utf8")) as {module: string; scenarios: Record<string, Golden>};

type Body = {jsonrpc: string; id: number; method: string; params: unknown[]};

/** The gas check's block read: a request of that one call, exactly as sent. */
function isBlockRead([, body]: [string, string]): boolean {
  const calls = JSON.parse(body) as Body[];
  if (!calls.some((c) => c.method === "eth_getBlockByNumber")) return false;
  expect(calls).toEqual([{jsonrpc: "2.0", id: 0, method: "eth_getBlockByNumber", params: ["latest", false]}]);
  return true;
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
      const reads = got.requests.flatMap((r, i) => (isBlockRead(r) ? [i] : []));
      // Sent once the deployment check (router and quoter factory() / WETH9()) has passed, once per endpoint tried.
      const deployed = !/mismatch/.test(s.name);
      expect(reads.length).toBe(deployed ? (s.config?.rpcUrls ? 2 : 1) : 0);
      for (const i of reads) expect(got.requests.slice(0, i).some((r) => /^(0x[0-9a-fA-F]{40}:0x(c45a0155|4aa4a4fc) ?){4}$/.test(digest(r)[2]))).toBe(true);
      expect(got.requests.filter((_, i) => !reads.includes(i)).map(digest)).toEqual(want.requests);
      expect(got.refusals).toEqual(want.refusals);
      const {gasEstimate, gasEstimateSource, ...quote} = (got.quote ?? {}) as Quote;
      expect(got.quote === null ? null : quote).toEqual(want.quote);
      if (got.quote !== null) {
        expect(gasEstimateProblem(got.quote, s.params.sourceChain)).toBeNull();
        // Exactly where 0.4.11 derived a gas limit from the quoter's figure (none from a figure of 0).
        expect(gasEstimate === undefined).toBe(got.quote.txRequest?.gasLimit === undefined);
        if (gasEstimate !== undefined) expect(gasEstimateSource).toBe("simulated");
      }
      expect(got.preflight).toEqual(want.preflight);
    });
  }
});
