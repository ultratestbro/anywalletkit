#!/usr/bin/env node
// PUBLIC MAINNET (Base). Without --send it only quotes. `--send <case>` makes one small, capped swap from the test
// wallet through the engine (review → exact approval → preflight → send) and follows it to the receipt:
//   native — ETH → USDC (the input as value, no approval)
//   token  — USDC → ETH (one exact approval to the router, spent by the swap; the allowance must be 0 afterwards)
// The signer phrase comes from KYBER_ENV_FILE (TEST_WALLET_MNEMONIC=...) and is never printed.
import {readFile, writeFile} from "node:fs/promises";
import {createPublicClient, formatUnits, http, parseAbi} from "viem";
import {WalletManagerEvm} from "../../wallet-evm/dist/index.js";
import {KYBER_ROUTER_V2, KyberswapSwap2Protocol} from "../dist/index.js";

const CHAIN = "eip155:8453", CHAIN_ID = 8453;
const RPC = process.env.RPC_8453 ?? "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", NATIVE = "0x0000000000000000000000000000000000000000";
// Hard caps per case (base units of what is sold).
const CAP = {eth: 300_000_000_000_000n /* 0.0003 ETH */, usdc: 1_000_000n /* 1 USDC */};
const REPORT = new URL("../mainnet-report.json", import.meta.url);
const check = (ok, msg) => { if (!ok) throw new Error(msg); };

async function phrase() {
  const file = process.env.KYBER_ENV_FILE;
  check(file, "set KYBER_ENV_FILE");
  const line = (await readFile(file, "utf8")).split("\n").map((l) => /^TEST_WALLET_MNEMONIC=(.*)$/.exec(l.trim())).find(Boolean);
  const value = line?.[1].replace(/^(["'])(.*)\1$/, "$2").trim();
  check(value && value.split(/\s+/).length >= 12, "TEST_WALLET_MNEMONIC missing");
  return value;
}

const client = createPublicClient({transport: http(RPC)});
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const balances = async (address) => {
  const [eth, usdc, allowance] = await Promise.all([
    client.getBalance({address}),
    client.readContract({address: USDC, abi: ERC20, functionName: "balanceOf", args: [address]}),
    client.readContract({address: USDC, abi: ERC20, functionName: "allowance", args: [address, KYBER_ROUTER_V2]}),
  ]);
  return {eth, usdc, allowance};
};
const show = (b) => `ETH ${formatUnits(b.eth, 18)}, USDC ${formatUnits(b.usdc, 6)}, USDC allowance to the router ${b.allowance}`;
const json = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const send = args[0] === "--send" ? args[1] : null;
const manager = new WalletManagerEvm(await phrase(), {provider: RPC, chainId: CHAIN_ID});
const account = await manager.getAccount(0);
const me = await account.getAddress();
const swaps = new KyberswapSwap2Protocol(account, {fromChain: CHAIN, rpcUrls: {[CHAIN_ID]: [RPC]}, enabledChains: [CHAIN_ID], clientId: "anywalletkit"});
const before = await balances(me);
console.log(`account ${me} on Base: ${show(before)}`);

const cases = {
  native: {from: "ETH", to: USDC, amount: () => (before.eth > 3n * CAP.eth ? CAP.eth / 2n : before.eth / 4n)},
  token: {from: "USDC", to: NATIVE, amount: () => (before.usdc < CAP.usdc ? before.usdc : CAP.usdc)},
};

if (!send) {
  for (const [name, c] of Object.entries(cases)) {
    const amount = c.amount();
    const q = await swaps.quoteSwap2({fromToken: c.from, toToken: c.to, toChain: CHAIN_ID, fromTokenAmount: amount, recipient: me}).catch((e) => ({error: e.message}));
    console.log(`${name}: ${c.from} ${amount} →`, q.error ?? `${q.toTokenAmount} (min ${q.toTokenAmountMin})`);
    await sleep(700);
  }
  manager.dispose?.();
  process.exit(0);
}

const c = cases[send];
check(c, `unknown case ${send}`);
const amount = c.amount();
check(amount > 0n, `${send}: nothing to sell`);
const entry = {case: send, at: new Date().toISOString(), chain: CHAIN, account: me, from: c.from, to: c.to, amountIn: amount.toString(), before: json(before)};
const q = await swaps.quoteSwap2({fromToken: c.from, toToken: c.to, toChain: CHAIN_ID, fromTokenAmount: amount, recipient: me});
console.log(`quote: ${amount} ${c.from} → ${q.toTokenAmount} (min ${q.toTokenAmountMin})`);
const result = await swaps.swap2({fromToken: c.from, toToken: c.to, toChain: CHAIN_ID, fromTokenAmount: amount, minAmountOut: (q.toTokenAmountMin * 99n) / 100n, recipient: me});
entry.result = json(result);
console.log("sent", JSON.stringify(entry.result));
let status;
for (let i = 0; i < 30; i++) {
  status = await swaps.getSwap2Status(result.id).catch((e) => ({status: "error", error: e.message}));
  const state = status.status ?? status.state;
  console.log(`  ${i * 5}s: ${JSON.stringify(json(status)).slice(0, 200)}`);
  if (state && !["pending", "error"].includes(state)) break;
  await sleep(5_000);
}
entry.status = json(status);
await sleep(4_000);
const after = await balances(me);
entry.after = json(after);
console.log(`after: ${show(after)}`);
if (send === "token") check(after.allowance === 0n, `allowance left on the router: ${after.allowance}`);
const report = await readFile(REPORT, "utf8").then(JSON.parse).catch(() => ({kind: "public-mainnet-funded", limitations: ["Small capped swaps from one test wallet on Base"], cases: []}));
report.cases.push(entry);
await writeFile(REPORT, JSON.stringify(report, null, 2) + "\n");
manager.dispose?.();
process.exit(0);
