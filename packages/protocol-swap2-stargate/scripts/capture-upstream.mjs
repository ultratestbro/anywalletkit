// Read-only HTTP downloads. Updating this SHA requires review; never follow main here.
import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {STARGATE_ABI, TOKEN_MESSAGING_ABI} from "../dist/abi.js";

const commit = "414f47412123d7737520c6ba331c1376ec874a88";
const repository = "https://github.com/stargate-protocol/stargate-v2";
const sources = [
  ["StargatePoolUSDC", STARGATE_ABI],
  ["TokenMessaging", TOKEN_MESSAGING_ABI],
];
const artifacts = [];
for (const [name, localAbi] of sources) {
  const path = `packages/stg-evm-v2/deployments/base-mainnet/${name}.json`;
  const url = `https://raw.githubusercontent.com/stargate-protocol/stargate-v2/${commit}/${path}`;
  const response = await fetch(url, {signal: AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error(`upstream ${name}: HTTP ${response.status}`);
  const raw = await response.text();
  const artifact = JSON.parse(raw);
  const abi = localAbi.map((item) => {
    const matches = artifact.abi.filter((a) => a.type === item.type && a.name === item.name);
    if (matches.length !== 1) throw new Error(`upstream ${name}: expected one ${item.name}`);
    return matches[0];
  });
  artifacts.push({name, path, url, sha256: createHash("sha256").update(raw).digest("hex"), address: artifact.address, abi});
}
const dir = new URL("../tests/fixtures/", import.meta.url);
await mkdir(dir, {recursive: true});
await writeFile(new URL("upstream.json", dir), JSON.stringify({schemaVersion: 1, repository, commit, artifacts}, null, 2) + "\n");
console.log(`Pinned ${artifacts.length} deployment interfaces at ${commit}.`);
