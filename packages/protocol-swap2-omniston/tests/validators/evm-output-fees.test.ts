import {readFileSync} from "node:fs";
import {describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeAbiParameters, getAddress, type Hex} from "viem";
import {createOmnistonEvmOutputValidator, type EvmOutputValidationInput} from "../../src/validators/evm-output.js";

/**
 * scan F12: the destination escrow's fee split (`immutables.parameters`) and
 * destination timelocks decide what the trader actually receives. Fixtures are
 * REAL Omniston destination escrows (Base, Arbitrum, BNB, Polygon; TON-source
 * and EVM-source orders; both protocol fee recipients seen live). Their quote
 * fields are constructed from each escrow — no quote was captured for them.
 */
interface Row {
  chain: string;
  factory: Hex;
  escrow: Hex;
  transactionHash: Hex;
  transactionTo: string;
  blockNumber: Hex;
  blockTimestamp: Hex;
  logData: Hex;
  input: Hex;
  srcProfile: "ton-source" | "evm-source";
  dstStages: string;
  quote: {
    recipientAddress: string;
    outputTokenAddress: string;
    resolverSendsUnits: string;
    outputUnits: string;
    protocolFeeUnits: string;
    integratorFeeUnits: string;
    dstSecurityDepositUnits: string;
    protocolFeeRecipientAddress: string;
    integratorAddress?: string;
  };
}

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/live-dst-escrows-2026-10-22.json", import.meta.url), "utf8")) as {escrows: Row[]};
const ATTACKER = "0x000000000000000000000000000000000000dEaD";

const IMMUTABLES = [
  {name: "orderHash", type: "bytes32"}, {name: "hashlock", type: "bytes32"},
  {name: "maker", type: "uint256"}, {name: "taker", type: "uint256"},
  {name: "token", type: "uint256"}, {name: "amount", type: "uint256"},
  {name: "safetyDeposit", type: "uint256"}, {name: "timelocks", type: "uint256"},
  {name: "parameters", type: "bytes"},
] as const;
const FACTORY_ABI = [{
  type: "function", name: "addressOfEscrowDst", stateMutability: "view",
  inputs: [{name: "immutables", type: "tuple", components: IMMUTABLES}], outputs: [{type: "address"}],
}] as const;

const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const hashlockOf = (row: Row): Hex => `0x${row.logData.slice(2 + 64, 2 + 128)}`;

/** Word offsets (hex chars into the calldata) of the immutables tuple, anchored on the hashlock. */
function layout(input: Hex, hashlock: Hex) {
  const data = input.slice(2).toLowerCase();
  const at = data.indexOf(hashlock.slice(2).toLowerCase());
  const tupleStart = at - 64;
  const wordAt = (i: number) => at + 64 * i;
  const offset = Number(BigInt(`0x${data.slice(wordAt(7), wordAt(8))}`));
  const paramsAt = tupleStart + offset * 2 + 64;
  return {data, wordAt, paramsAt};
}

/** The real calldata with chosen immutables words rewritten (the attacker deploys THAT escrow). */
function mutate(row: Row, change: {timelocks?: (t: bigint) => bigint; fees?: [bigint, bigint, bigint, bigint]}): Hex {
  const {data, wordAt, paramsAt} = layout(row.input, hashlockOf(row));
  let out = data;
  if (change.timelocks) {
    const t = change.timelocks(BigInt(`0x${data.slice(wordAt(6), wordAt(7))}`));
    out = out.slice(0, wordAt(6)) + word(t) + out.slice(wordAt(7));
  }
  if (change.fees) {
    out = out.slice(0, paramsAt) + change.fees.map(word).join("") + out.slice(paramsAt + 256);
  }
  return `0x${out}`;
}

function feesOf(row: Row): [bigint, bigint, bigint, bigint] {
  const {data, paramsAt} = layout(row.input, hashlockOf(row));
  return [0, 1, 2, 3].map((i) => BigInt(`0x${data.slice(paramsAt + 64 * i, paramsAt + 64 * (i + 1))}`)) as [bigint, bigint, bigint, bigint];
}

/**
 * RPC of the destination chain serving one escrow deployment. The factory
 * mock derives the escrow address for exactly the immutables the deployment
 * calldata carries (deployedAt stamped with the block timestamp) — the
 * CREATE2 property; for the unmodified fixtures the live factory returned the
 * same address (checked when the fixture was captured).
 */
function rpcFor(row: Row, input: Hex = row.input) {
  const blockTimestamp = BigInt(row.blockTimestamp);
  const {data, wordAt, paramsAt} = layout(input, hashlockOf(row));
  const w = (i: number) => BigInt(`0x${data.slice(wordAt(i), wordAt(i + 1))}`);
  const deployed = {
    orderHash: `0x${data.slice(wordAt(-1), wordAt(0))}`,
    hashlock: hashlockOf(row).toLowerCase(),
    maker: w(1), taker: w(2), token: w(3), amount: w(4), safetyDeposit: w(5),
    timelocks: (w(6) & ~(((1n << 32n) - 1n) << 224n)) | (blockTimestamp << 224n),
    parameters: `0x${data.slice(paramsAt, paramsAt + 256)}`,
  };
  const latest = BigInt(row.blockNumber) + 100n;
  return vi.fn(async (_chain: string, method: string, params: unknown[]) => {
    if (method === "eth_blockNumber") return `0x${latest.toString(16)}`;
    if (method === "eth_getLogs") return [{data: row.logData, transactionHash: row.transactionHash, blockNumber: row.blockNumber}];
    if (method === "eth_getTransactionByHash") return {to: row.transactionTo, input, value: "0x0"};
    if (method === "eth_getTransactionReceipt") return {status: "0x1", blockNumber: row.blockNumber};
    if (method === "eth_getBlockByNumber") return {timestamp: row.blockTimestamp};
    if (method === "eth_getCode") return "0x6080";
    if (method === "eth_getBalance") return `0x${BigInt(row.quote.dstSecurityDepositUnits).toString(16)}`;
    if (method === "eth_call") {
      const call = params[0] as {to: string; data: Hex};
      if (getAddress(call.to) === getAddress(row.factory)) {
        const asked = decodeFunctionData({abi: FACTORY_ABI, data: call.data}).args[0];
        const same = asked.orderHash.toLowerCase() === deployed.orderHash && asked.hashlock.toLowerCase() === deployed.hashlock &&
          asked.maker === deployed.maker && asked.taker === deployed.taker && asked.token === deployed.token &&
          asked.amount === deployed.amount && asked.safetyDeposit === deployed.safetyDeposit &&
          asked.timelocks === deployed.timelocks && asked.parameters.toLowerCase() === deployed.parameters;
        return encodeAbiParameters([{type: "address"}], [same ? row.escrow : "0x0000000000000000000000000000000000000bad"]);
      }
      if (getAddress(call.to) === getAddress(row.escrow)) return encodeAbiParameters([{type: "address"}], [row.factory]);
      if (getAddress(call.to) === getAddress(row.quote.outputTokenAddress)) {
        return encodeAbiParameters([{type: "uint256"}], [BigInt(row.quote.resolverSendsUnits)]);
      }
    }
    throw new Error(`unexpected ${method}`);
  });
}

function inputFor(row: Row): EvmOutputValidationInput {
  const q = row.quote;
  return {
    chain: row.chain,
    positionAddress: row.escrow,
    factoryAddress: row.factory,
    quoteTimestamp: Number(BigInt(row.blockTimestamp)) - 30,
    executionIndex: 0,
    recipientAddress: q.recipientAddress,
    outputTokenAddress: q.outputTokenAddress,
    inputUnits: "1000000",
    outputUnits: q.outputUnits,
    resolverSendsUnits: q.resolverSendsUnits,
    srcHtlcSecurityDepositUnits: "1",
    dstSecurityDepositUnits: q.dstSecurityDepositUnits,
    protocolFeeUnits: q.protocolFeeUnits,
    integratorFeeUnits: q.integratorFeeUnits,
    protocolFeeRecipientAddress: q.protocolFeeRecipientAddress,
    ...(q.integratorAddress ? {integratorAddress: q.integratorAddress} : {}),
    secretHash: Uint8Array.from(Buffer.from(hashlockOf(row).slice(2), "hex")),
  };
}

function validator(row: Row, input?: Hex, secondsAfterDeploy = 30) {
  const refusals: string[] = [];
  const validate = createOmnistonEvmOutputValidator({
    request: rpcFor(row, input),
    now: () => (Number(BigInt(row.blockTimestamp)) + secondsAfterDeploy) * 1000,
    onRefusal: (reason) => refusals.push(reason),
  });
  return {validate, refusals};
}

const rows = FIXTURE.escrows;
const byHash = (prefix: string) => rows.find((row) => row.transactionHash.startsWith(prefix))!;
const evmSource = byHash("0x216a07cc8e"); // Arbitrum, 0x0762… protocol recipient
const withIntegrator = byHash("0x82df26d32c"); // Base, integratorFee > 0

describe("Omniston EVM output: real destination escrows (scan F12)", () => {
  it("covers four chains, both source profiles and both live protocol fee recipients", () => {
    expect(new Set(rows.map((row) => row.chain))).toEqual(new Set(["eip155:8453", "eip155:42161", "eip155:56", "eip155:137"]));
    expect(new Set(rows.map((row) => row.srcProfile))).toEqual(new Set(["ton-source", "evm-source"]));
    expect(new Set(rows.map((row) => getAddress(row.quote.protocolFeeRecipientAddress)))).toEqual(new Set([
      "0x076268146B4EC6D21fc49C27586Cfa91B9079a00",
      getAddress("0x145f18260c87d2eca5d25e9dcaf1baa43bd5970e"),
    ]));
    expect(rows.every((row) => row.dstStages === "1/120/180")).toBe(true);
    expect(rows.some((row) => BigInt(row.quote.integratorFeeUnits) > 0n)).toBe(true);
  });

  it.each(rows.map((row) => [`${row.chain} ${row.srcProfile} ${row.transactionHash.slice(0, 12)}`, row] as const))(
    "accepts %s with its matching quote fields",
    async (_label, row) => {
      const {validate, refusals} = validator(row);
      await expect(validate(inputFor(row))).resolves.toBe(true);
      expect(refusals).toEqual([]);
    },
  );
});

describe("Omniston EVM output: fee split and timelock attacks (scan F12)", () => {
  it("refuses an escrow whose protocol fee takes almost the whole amount to the attacker", async () => {
    const amount = BigInt(evmSource.quote.resolverSendsUnits);
    const {validate, refusals} = validator(evmSource, mutate(evmSource, {fees: [amount - 1n, 0n, BigInt(ATTACKER), 0n]}));
    await expect(validate(inputFor(evmSource))).resolves.toBe(false);
    expect(refusals).toEqual(["fee-amounts"]);
  });

  it("refuses the quoted protocol fee paid to a different recipient", async () => {
    const [pf, inf, , ir] = feesOf(evmSource);
    const {validate, refusals} = validator(evmSource, mutate(evmSource, {fees: [pf, inf, BigInt(ATTACKER), ir]}));
    await expect(validate(inputFor(evmSource))).resolves.toBe(false);
    expect(refusals).toEqual(["protocol-fee-recipient"]);
  });

  it("refuses a fee moved into an unquoted integrator fee", async () => {
    const [pf, , pr] = feesOf(evmSource);
    const {validate, refusals} = validator(evmSource, mutate(evmSource, {fees: [pf, 1000n, pr, BigInt(ATTACKER)]}));
    await expect(validate(inputFor(evmSource))).resolves.toBe(false);
    expect(refusals).toEqual(["fee-amounts"]);
  });

  it("refuses a quoted integrator fee paid to someone other than the quote's integrator", async () => {
    const [pf, inf, pr] = feesOf(withIntegrator);
    expect(inf).toBeGreaterThan(0n);
    const {validate, refusals} = validator(withIntegrator, mutate(withIntegrator, {fees: [pf, inf, pr, BigInt(ATTACKER)]}));
    await expect(validate(inputFor(withIntegrator))).resolves.toBe(false);
    expect(refusals).toEqual(["integrator-fee-recipient"]);
  });

  it("refuses when the quote carries an integrator fee but no integrator address", async () => {
    const {validate, refusals} = validator(withIntegrator);
    const {integratorAddress: _, ...input} = inputFor(withIntegrator);
    await expect(validate(input)).resolves.toBe(false);
    expect(refusals).toEqual(["quote-missing-integrator-address"]);
  });

  it("refuses when the quote names no protocol fee recipient for a non-zero protocol fee", async () => {
    const {validate, refusals} = validator(evmSource);
    const {protocolFeeRecipientAddress: _, ...input} = inputFor(evmSource);
    await expect(validate(input)).resolves.toBe(false);
    expect(refusals).toEqual(["quote-missing-protocol-fee-recipient"]);
  });

  it("refuses a recipient word with bits above the address", async () => {
    const [pf, inf, pr, ir] = feesOf(evmSource);
    const {validate, refusals} = validator(evmSource, mutate(evmSource, {fees: [pf, inf, pr | (1n << 200n), ir]}));
    await expect(validate(inputFor(evmSource))).resolves.toBe(false);
    expect(refusals).toEqual(["fee-parameters-shape"]);
  });

  const setDst = (stages: [bigint, bigint, bigint]) => (t: bigint) => {
    let out = t;
    stages.forEach((value, index) => {
      const shift = BigInt((4 + index) * 32);
      out = (out & ~(((1n << 32n) - 1n) << shift)) | (value << shift);
    });
    return out;
  };

  it("refuses a destination escrow that cancels before (or as) withdrawal opens", async () => {
    const {validate, refusals} = validator(evmSource, mutate(evmSource, {timelocks: setDst([120n, 150n, 60n])}));
    await expect(validate(inputFor(evmSource))).resolves.toBe(false);
    expect(refusals).toEqual(["dst-timelocks"]);
  });

  it("refuses destination stages other than 1/120/180", async () => {
    for (const stages of [[1n, 120n, 3600n], [1n, 3600n, 7200n], [0n, 120n, 180n]] as [bigint, bigint, bigint][]) {
      const {validate, refusals} = validator(evmSource, mutate(evmSource, {timelocks: setDst(stages)}));
      await expect(validate(inputFor(evmSource))).resolves.toBe(false);
      expect(refusals).toEqual(["dst-timelocks"]);
    }
  });

  it("keeps accepting any source stages (TON-source 0/0/0/0, EVM-source 1/120/240/300)", async () => {
    const tonSource = rows.find((row) => row.srcProfile === "ton-source")!;
    const swapped = mutate(tonSource, {timelocks: (t) => (t & ~((1n << 128n) - 1n)) | 1n | (120n << 32n) | (240n << 64n) | (300n << 96n)});
    const {validate, refusals} = validator(tonSource, swapped);
    await expect(validate(inputFor(tonSource))).resolves.toBe(true);
    expect(refusals).toEqual([]);
  });

  it("refuses disclosure once the destination cancellation is within the margin", async () => {
    // Cancellation opens at deployedAt + 180; the margin is 45 s.
    await expect(validator(evmSource, undefined, 134).validate(inputFor(evmSource))).resolves.toBe(true);
    const closing = validator(evmSource, undefined, 135);
    await expect(closing.validate(inputFor(evmSource))).resolves.toBe(false);
    expect(closing.refusals).toEqual(["dst-cancellation-window"]);
    const late = validator(evmSource, undefined, 600);
    await expect(late.validate(inputFor(evmSource))).resolves.toBe(false);
    expect(late.refusals).toEqual(["dst-cancellation-window"]);
  });
});
