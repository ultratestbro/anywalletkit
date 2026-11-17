import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {decodeEventLog, encodeAbiParameters, toEventSelector, type Abi} from "viem";
import {STARGATE_ABI, TOKEN_MESSAGING_ABI} from "../src/abi.js";

const upstream = JSON.parse(readFileSync(new URL("./fixtures/upstream.json", import.meta.url), "utf8")) as {commit: string; artifacts: {name: string; abi: Abi}[]};
// ABI parameter names/internalType do not affect wire compatibility. Tuple layout,
// event indexed flags, mutability and outputs do, so compare all of those recursively.
function wire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wire);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key, v]) => key !== "name" && key !== "internalType" && !((key === "indexed" || key === "anonymous") && v === false))
    .map(([key, v]) => [key, wire(v)]));
  return value;
}

describe("pinned official interfaces", () => {
  for (const [name, abi] of [["StargatePoolUSDC", STARGATE_ABI], ["TokenMessaging", TOKEN_MESSAGING_ABI]] as const) {
    const artifact = upstream.artifacts.find((a) => a.name === name)!;
    for (const item of abi) {
      it(`${name}.${item.name} matches upstream input/output/event layout`, () => {
        const official = artifact.abi.find((a) => "name" in a && a.name === item.name && a.type === item.type);
        expect(official).toBeDefined();
        expect(wire(item)).toEqual(wire(official));
      });
    }
  }

  it("pins an immutable upstream commit", () => {
    expect(upstream.commit).toBe("414f47412123d7737520c6ba331c1376ec874a88");
  });

  it("decodes synthetic BusDriven ticket ids above Number.MAX_SAFE_INTEGER losslessly", () => {
    // Synthetic codec vector, NOT a mainnet delivery fixture.
    const ticketId = (1n << 65n) + 19n;
    const guid = `0x${"ab".repeat(32)}` as const;
    const data = encodeAbiParameters([{type: "uint32"}, {type: "uint72"}, {type: "uint8"}, {type: "bytes32"}], [30110, ticketId, 3, guid]);
    const decoded = decodeEventLog({abi: TOKEN_MESSAGING_ABI, eventName: "BusDriven", topics: [toEventSelector("BusDriven(uint32,uint72,uint8,bytes32)")], data});
    expect(decoded.args).toEqual({dstEid: 30110, startTicketId: ticketId, numPassengers: 3, guid});
  });
});
