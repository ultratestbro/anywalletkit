import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {concatHex, createPublicClient, custom, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, slice, toHex, type Hex, type TransactionReceipt} from "viem";
import {LIFI_COMPOSE_PAYLOAD, LIFI_ETHEREUM_COMPOSER, proveLifiStargateCompose, type StargateComposeExpectation} from "../src/compose.js";
import {COMPOSE_DEX_PINS, COMPOSE_UNOSWAP_ABI, validateLifiUnoswap2Compose} from "../src/compose-dex.js";

// Real RPC data; only individual negative mutations below are synthetic.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/compose.json", import.meta.url), "utf8"));
const foreign: Hex = "0x1111111111111111111111111111111111111111";
function setup(index = 0) {
  const c = fixture.cases[index];
  const expected: StargateComposeExpectation = {...c.expected, minimum: BigInt(c.expected.minimum), bridge: {...c.expected.bridge, amount: BigInt(c.expected.bridge.amount), minimum: BigInt(c.expected.bridge.minimum), nativeDrop: BigInt(c.expected.bridge.nativeDrop)}};
  const receipt = (r: TransactionReceipt) => ({...r, blockNumber: BigInt(r.blockNumber), logs: r.logs.map((l) => ({...l, blockNumber: BigInt(l.blockNumber!)}))});
  const proof = proveLifiStargateCompose(expected, receipt(c.source.receipt), receipt(c.delivery.receipt), c.code);
  const baseline = fixture.cases[0], at = BigInt(baseline.execution.block.number);
  const code = new Map([
    [COMPOSE_DEX_PINS.router.toLowerCase(), baseline.dexEvidence.code.router],
    [COMPOSE_DEX_PINS.factory.toLowerCase(), baseline.dexEvidence.code.factory],
    [LIFI_ETHEREUM_COMPOSER.receiver.toLowerCase(), baseline.code.receiver],
    [LIFI_ETHEREUM_COMPOSER.executor.toLowerCase(), baseline.code.executor],
  ]);
  const state = {chainId: "0x1", code, reorg: false, wrongPool: false, reads: 0};
  const client = createPublicClient({cacheTime: 0, transport: custom({request: async ({method, params}) => {
    const args = params as unknown[];
    if (method === "eth_chainId") return state.chainId;
    if (method === "eth_getBlockByNumber") {
      expect(args[0]).toBe(toHex(at));
      return {number: toHex(at), hash: state.reorg && ++state.reads > 1 ? `0x${"ab".repeat(32)}` : baseline.execution.block.hash, transactions: []};
    }
    expect(args[1]).toBe(toHex(at));
    if (method === "eth_getCode") return state.code.get(String(args[0]).toLowerCase());
    if (method === "eth_call") {
      const call = args[0] as {to: string; data: Hex};
      const found = baseline.calls.find((r: {to: string; data: Hex; blockNumber: string}) => r.to.toLowerCase() === call.to.toLowerCase() && r.data === call.data && BigInt(r.blockNumber) === at);
      if (!found) throw new Error("Unrecorded RPC call");
      return state.wrongPool && found.functionName === "getPool" ? encodeAbiParameters([{type: "address"}], [foreign]) : found.result;
    }
    throw new Error(`Unexpected RPC method: ${method}`);
  }}, {retryCount: 0})});
  const [id, swaps, recipient] = decodeAbiParameters(LIFI_COMPOSE_PAYLOAD, expected.composeMsg);
  const swap = swaps[0]!;
  function mutate(patch: Partial<typeof swap> = {}, target = recipient) {
    const message = concatHex([slice(proof.message, 0, 76), encodeAbiParameters(LIFI_COMPOSE_PAYLOAD, [id, [{...swap, ...patch}], target])]);
    return {...proof, message, messageHash: keccak256(message)};
  }
  function calldata(patch: Partial<Record<0 | 1 | 2 | 3 | 4, bigint>>, suffix = "") {
    const call = decodeFunctionData({abi: COMPOSE_UNOSWAP_ABI, data: swap.callData});
    const args = [...call.args] as [bigint, bigint, bigint, bigint, bigint];
    for (const [key, value] of Object.entries(patch)) args[parseInt(key)] = value!;
    return `${encodeFunctionData({abi: COMPOSE_UNOSWAP_ABI, functionName: "unoswap2", args})}${suffix}` as Hex;
  }
  return {proof, client, at, state, swap, mutate, calldata, baseline};
}

describe("LI.FI unoswap2 canonical Uniswap V3 path", () => {
  it("replays actual code and pool reads and enforces the encoded minimum", async () => {
    const s = setup();
    const result = await validateLifiUnoswap2Compose(s.proof, s.client, s.at);
    expect(result).toMatchObject({amount: 97496616n, minimum: s.proof.minimum, pools: s.baseline.dexEvidence.validated.pools, recipient: s.proof.recipient, finalToken: s.proof.finalToken, executionSupported: false});
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.pools)).toBe(true);
    await expect(validateLifiUnoswap2Compose(s.mutate({callData: s.calldata({})}), s.client, s.at)).resolves.toMatchObject({minimum: s.proof.minimum});
  });
  it("rejects opaque aggregator targets and changed approval/recipient/assets", async () => {
    const s = setup();
    await expect(validateLifiUnoswap2Compose(setup(1).proof, s.client, s.at)).rejects.toThrow(/target/);
    for (const patch of [{callTo: foreign}, {approveTo: foreign}, {requiresDeposit: false}, {sendingAssetId: foreign}, {receivingAssetId: foreign}, {fromAmount: s.swap.fromAmount + 1n}]) {
      await expect(validateLifiUnoswap2Compose(s.mutate(patch), s.client, s.at)).rejects.toThrow();
    }
    await expect(validateLifiUnoswap2Compose(s.mutate({}, foreign), s.client, s.at)).rejects.toThrow(/action/);
  });
  it("rejects changed minimum, amount, token and arbitrary trailing calldata", async () => {
    const s = setup();
    for (const patch of [{0: BigInt(foreign)}, {0: 1n << 160n}, {1: s.swap.fromAmount + 1n}, {2: s.proof.minimum - 1n}, {2: 0n}]) {
      await expect(validateLifiUnoswap2Compose(s.mutate({callData: s.calldata(patch)}), s.client, s.at)).rejects.toThrow(/input or minimum/);
    }
    for (const suffix of ["00", "2a94d115", "2a94d11400"]) {
      await expect(validateLifiUnoswap2Compose(s.mutate({callData: s.calldata({}, suffix)}), s.client, s.at)).rejects.toThrow(/noncanonical/);
    }
    await expect(validateLifiUnoswap2Compose({...s.proof, messageHash: `0x${"00".repeat(32)}`}, s.client, s.at)).rejects.toThrow(/changed compose/);
  });
  it("rejects Permit2, native unwrap, unknown flags and incorrect directions", async () => {
    const s = setup(), {args} = decodeFunctionData({abi: COMPOSE_UNOSWAP_ABI, data: s.swap.callData});
    for (const flag of [1n << 250n, 1n << 252n, 1n << 160n, 1n << 254n]) {
      await expect(validateLifiUnoswap2Compose(s.mutate({callData: s.calldata({3: args[3] | flag})}), s.client, s.at)).rejects.toThrow(/flags/);
    }
    for (const index of [3, 4] as const) {
      await expect(validateLifiUnoswap2Compose(s.mutate({callData: s.calldata({[index]: args[index] ^ (1n << 247n)})}), s.client, s.at)).rejects.toThrow(/path input/);
    }
  });
  it("rejects foreign factories, code changes, wrong networks and reorganized blocks", async () => {
    const s = setup();
    s.state.wrongPool = true;
    await expect(validateLifiUnoswap2Compose(s.proof, s.client, s.at)).rejects.toThrow(/pool/);
    s.state.wrongPool = false; s.state.reorg = true;
    await expect(validateLifiUnoswap2Compose(s.proof, s.client, s.at)).rejects.toThrow(/block changed/);
    s.state.reorg = false;
    for (const address of s.state.code.keys()) {
      const original = s.state.code.get(address); s.state.code.set(address, "0x00");
      await expect(validateLifiUnoswap2Compose(s.proof, s.client, s.at)).rejects.toThrow(/bytecode/);
      s.state.code.set(address, original);
    }
    s.state.chainId = "0xa4b1";
    await expect(validateLifiUnoswap2Compose(s.proof, s.client, s.at)).rejects.toThrow(/chain/);
  });
});
