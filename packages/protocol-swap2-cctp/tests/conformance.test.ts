import {describeProtocolModule} from "@anywalletkit/conformance";
import {CctpSwap2Protocol} from "../src/protocol.js";

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

describeProtocolModule("protocol-swap2-cctp", {
  type: "swap2",
  activity,
  Protocol: CctpSwap2Protocol,
  config: {fromChain: "eip155:8453", skipAccountChainCheck: true},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});
