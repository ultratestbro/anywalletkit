// The provider decodes every Legacy Mesh send it builds against the request before returning it. Its own build always
// passes that check (legacy-mesh.test.ts), so here the check is made to fail to prove a mismatch is a refusal, not a quote.
import {describe, expect, it, vi} from "vitest";
import {TO_TON, TO_TRON, make} from "./mesh-fixtures.js";

vi.mock("../src/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/config.js")>();
  return {...real, usdt0VerifyMeshSend: () => "the send delivers to 0x1234, not the recipient"};
});

describe("Legacy Mesh: the built send is read back before it is returned", () => {
  it("a build that does not match the request is refused with the reason, for Tron and TON", async () => {
    for (const params of [TO_TRON, TO_TON]) {
      const reasons: string[] = [];
      const q = await make().p.getQuote({...params, onRefusal: (r) => reasons.push(r)});
      expect(q).toBeNull();
      expect(reasons).toEqual(["usdt0: the built Legacy Mesh send does not match the request — the send delivers to 0x1234, not the recipient"]);
    }
  });
});
