import {mkdir, writeFile, rename} from "node:fs/promises";
const base = "https://transfer.layerzero-api.com/v1/";
const paths = ["chains", "metadata", "tokens?transferrableFromChainKey=base&transferrableFromTokenAddress=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"];
const captures = [];
for (const path of paths) {
  const url = base + path;
  const response = await fetch(url, {redirect: "error", signal: AbortSignal.timeout(20_000)});
  if (!response.ok) throw new Error(`Public API capture failed: HTTP ${response.status}`);
  captures.push({url, status: response.status, capturedAt: new Date().toISOString(), body: await response.json()});
}
const directory = new URL("../tests/fixtures/", import.meta.url);
await mkdir(directory, {recursive: true});
const target = new URL("public.json", directory), temporary = new URL("public.json.tmp", directory);
await writeFile(temporary, JSON.stringify({schemaVersion: 1, kind: "live-public-value-transfer-api", captures}, null, 2) + "\n");
await rename(temporary, target);
console.log("Captured public chains, metadata and Base USDC destination catalog; no authenticated requests or signatures.");
