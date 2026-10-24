import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {expect} from "vitest";
import {getCompiledTransactionMessageDecoder, getTransactionDecoder} from "@solana/kit";
import {JupiterSwap2Protocol} from "../src/protocol.js";
import {JUPITER_PROGRAM, JUPITER_TX_PROGRAMS} from "../src/config.js";
import {fromBase64} from "../src/codec.js";

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";

// Real mainnet transactions captured through wallet-solana history (fixtures/activity/*.json); `negative-*` → null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

// Jupiter's real /build answer for 0.1 SOL → USDC (taker 9WzD…), 2026-10-23.
const file = JSON.parse(readFileSync(new URL("../fixtures/build-2026-10-23.json", import.meta.url), "utf8")) as {taker: string; responses: Record<string, {response: unknown}>};
const ME = file.taker;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const stub = (async (url: RequestInfo | URL) => {
  if (String(url).includes("/build?")) return new Response(JSON.stringify(file.responses.sol_usdc!.response));
  return new Response("{}", {status: 404});
}) as typeof fetch;

describeProtocolModule("protocol-swap2-jupiter", {
  type: "swap2",
  activity,
  Protocol: JupiterSwap2Protocol,
  config: {fromChain: "solana:mainnet", skipAccountChainCheck: true},
  samples: {getSupportedChains: []},
});

describeProtocolBehaviour("protocol-swap2-jupiter", {
  type: "swap2",
  Protocol: JupiterSwap2Protocol,
  config: {fromChain: "solana:mainnet", skipAccountChainCheck: true},
  fixtures: [
    {
      name: "0.1 SOL → USDC (a v0 transaction from /build, executed through the account's serialized guard)",
      options: {fromToken: "SOL", toToken: USDC, toChain: "solana:mainnet", fromTokenAmount: 100_000_000n, slippageBps: 50, minAmountOut: 10_000_000n},
      fetch: stub,
      account: {address: ME, chain: "solana:mainnet", serialized: true},
      serialized: (wire, own) => {
        const tx = getTransactionDecoder().decode(fromBase64(wire));
        const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {version: number; staticAccounts: string[]; instructions: {programAddressIndex: number}[]};
        expect(msg.version).toBe(0);
        // the owner pays and is the only signer; nothing is signed yet
        expect(Object.keys(tx.signatures).map((s) => s.toLowerCase())).toEqual([...own].filter((a) => a === ME.toLowerCase()));
        expect(Object.values(tx.signatures).every((s) => s === null)).toBe(true);
        // every invoked program is Jupiter or its plumbing, and Jupiter is among them
        const programs = msg.instructions.map((ix) => msg.staticAccounts[ix.programAddressIndex]!);
        expect(programs.every((p) => JUPITER_TX_PROGRAMS.has(p))).toBe(true);
        expect(programs).toContain(JUPITER_PROGRAM);
      },
    },
  ],
});
