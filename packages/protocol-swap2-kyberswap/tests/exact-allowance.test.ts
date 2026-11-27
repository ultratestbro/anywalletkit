// exactAllowanceOnly (2026-11-28): on the chains whose router is the `generic` build (an owner-managed `swapGeneric`
// executor whitelist; a single owner key on all but Linea) no allowance may outlive the swap, so the provider asks the
// engine to keep its defaults there — an exact allowance, revoked when unspent — whatever allowanceReuse /
// revokeUnspentApproval the app set. The `lite` chains are free; a chain the module does not list counts as generic.
import {describe, expect, it} from "vitest";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {KYBER_CHAINS, kyberExactAllowanceOnly, kyberPins} from "../src/router.js";
import {kyberswapProvider} from "../src/provider.js";

describe("kyberExactAllowanceOnly", () => {
  it("true on every generic-build chain, false on every lite one, true for a chain it does not know", () => {
    const generic = Object.entries(KYBER_CHAINS).filter(([, c]) => c.build === "generic").map(([id]) => Number(id));
    const lite = Object.entries(KYBER_CHAINS).filter(([, c]) => c.build === "lite").map(([id]) => Number(id));
    expect(generic.sort((a, b) => a - b)).toEqual([1, 10, 56, 137, 8453, 42161, 43114, 59144]);
    expect(generic.length + lite.length).toBe(Object.keys(KYBER_CHAINS).length);
    for (const id of generic) expect(kyberExactAllowanceOnly(`eip155:${id}`), String(id)).toBe(true);
    for (const id of lite) expect(kyberExactAllowanceOnly(`eip155:${id}`), String(id)).toBe(false);
    for (const chain of ["eip155:324", "eip155:0", "eip155:constructor", "solana:mainnet", ""]) expect(kyberExactAllowanceOnly(chain), chain).toBe(true);
  });

  it("the provider, its pins and a remote stub built from them all carry it", () => {
    expect(kyberswapProvider().exactAllowanceOnly).toBe(kyberExactAllowanceOnly);
    expect(kyberPins.exactAllowanceOnly).toBe(kyberExactAllowanceOnly);
    const stub = remoteProvider({name: "kyberswap", baseUrl: "https://backend.example/api/v2/swap2", ...kyberPins});
    expect(stub.exactAllowanceOnly?.("eip155:1")).toBe(true);
    expect(stub.exactAllowanceOnly?.("eip155:130")).toBe(false);
  });
});
