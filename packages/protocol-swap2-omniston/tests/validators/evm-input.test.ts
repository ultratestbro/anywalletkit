import {describe, expect, it, vi} from "vitest";
import {encodeAbiParameters, type Hex} from "viem";
import {createOmnistonEvmInputValidator, SRC_ESCROW_CREATED_TOPIC, type EvmInputValidationInput} from "../../src/validators/evm-input.js";

const FACTORY = "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd";
const LOP = "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E";
const POSITION = "0x0CD4d5758313baAdB792c51175B383Bb64Ea6909";
const OWNER = "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA";
const RESOLVER = "0x2b654E50C83801AC79CE3011Ff94245E2937b1B7";
const TOKEN = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const STUB_TAKER_ASSET = "0xbDdba5647D24c4a513f8F85e596B111B511A6E5e";
const HASH = Uint8Array.from({length: 32}, (_, index) => 255 - index);
const HASH_HEX = `0x${Buffer.from(HASH).toString("hex")}` as Hex;
const DEPLOYED_AT = 1_792_100_000;
const QUOTE_TIME = DEPLOYED_AT - 10;

const INPUT: EvmInputValidationInput = {
  chain: "eip155:8453",
  positionAddress: POSITION,
  factoryAddress: FACTORY,
  orderProtocolAddress: LOP,
  ownerAddress: OWNER,
  resolverAddress: RESOLVER,
  inputTokenAddress: TOKEN,
  inputUnits: "20000000",
  resolverSendsUnits: "20346628",
  srcHtlcSecurityDepositUnits: "600000000000000",
  quoteTimestamp: QUOTE_TIME,
  secretHash: HASH,
};

const IMMUTABLES = [
  {name: "orderHash", type: "bytes32"}, {name: "hashlock", type: "bytes32"}, {name: "maker", type: "uint256"}, {name: "taker", type: "uint256"},
  {name: "token", type: "uint256"}, {name: "amount", type: "uint256"}, {name: "safetyDeposit", type: "uint256"}, {name: "timelocks", type: "uint256"}, {name: "parameters", type: "bytes"},
] as const;
const COMPLEMENT = [
  {name: "maker", type: "uint256"}, {name: "amount", type: "uint256"}, {name: "token", type: "uint256"}, {name: "safetyDeposit", type: "uint256"}, {name: "chainId", type: "uint256"}, {name: "parameters", type: "bytes"},
] as const;

function timelocks(stages: bigint[] = [1n, 120n, 240n, 300n, 1n, 120n, 180n], deployedAt = BigInt(DEPLOYED_AT)): bigint {
  return stages.reduce((packed, value, index) => packed | (value << BigInt(index * 32)), deployedAt << 224n);
}

/** The live Base shape: the factory emits SrcEscrowCreated from the order's post-interaction. */
function rpc(opts: {
  maker?: string; taker?: string; token?: string; amount?: bigint; safetyDeposit?: bigint; timelocks?: bigint; parameters?: Hex;
  complementAmount?: bigint; derived?: string; blockNumber?: string; latest?: string; blockTimestamp?: number;
  complementChainId?: bigint; complementToken?: string; complementDeposit?: bigint;
  code?: Hex; reportedFactory?: string; tokenBalance?: bigint; nativeBalance?: bigint; logAddress?: string; status?: Hex;
} = {}) {
  const immutables = {
    orderHash: `0x${"25".repeat(32)}` as Hex,
    hashlock: HASH_HEX,
    maker: BigInt(opts.maker ?? OWNER),
    taker: BigInt(opts.taker ?? RESOLVER),
    token: BigInt(opts.token ?? TOKEN),
    amount: opts.amount ?? 20_000_000n,
    safetyDeposit: opts.safetyDeposit ?? 600_000_000_000_000n,
    timelocks: opts.timelocks ?? timelocks(),
    parameters: opts.parameters ?? "0x",
  };
  const complement = {
    maker: BigInt(RESOLVER), amount: opts.complementAmount ?? 20_346_628n, token: BigInt(opts.complementToken ?? STUB_TAKER_ASSET),
    safetyDeposit: opts.complementDeposit ?? 0n, chainId: opts.complementChainId ?? 0n,
    parameters: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}, {type: "uint256"}, {type: "uint256"}], [0x28a1n, 0n, 0n, 0n]),
  };
  const data = encodeAbiParameters(
    [{type: "tuple", components: IMMUTABLES}, {type: "tuple", components: COMPLEMENT}],
    [immutables, complement],
  );
  const blockNumber = opts.blockNumber ?? "0x50";
  return vi.fn(async (_chain: string, method: string, params: unknown[]) => {
    if (method === "eth_blockNumber") return opts.latest ?? "0x64";
    if (method === "eth_getLogs") return [{address: opts.logAddress ?? FACTORY, data, topics: [SRC_ESCROW_CREATED_TOPIC], transactionHash: `0x${"77".repeat(32)}`, blockNumber}];
    if (method === "eth_getTransactionReceipt") return {status: opts.status ?? "0x1", blockNumber};
    if (method === "eth_getBlockByNumber") return {timestamp: `0x${(opts.blockTimestamp ?? DEPLOYED_AT).toString(16)}`};
    if (method === "eth_getCode") return opts.code ?? "0x6001";
    if (method === "eth_getBalance") return `0x${(opts.nativeBalance ?? 600_000_000_000_000n).toString(16)}`;
    if (method === "eth_call") {
      const call = params[0] as {to: string; data: Hex};
      if (call.to.toLowerCase() === FACTORY.toLowerCase()) return encodeAbiParameters([{type: "address"}], [(opts.derived ?? POSITION) as Hex]);
      if (call.to.toLowerCase() === POSITION.toLowerCase()) return encodeAbiParameters([{type: "address"}], [(opts.reportedFactory ?? FACTORY) as Hex]);
      if (call.to.toLowerCase() === TOKEN.toLowerCase()) return encodeAbiParameters([{type: "uint256"}], [opts.tokenBalance ?? 20_000_000n]);
    }
    throw new Error(`unexpected ${method}`);
  });
}

const validator = (request: ReturnType<typeof rpc>, nowSeconds = DEPLOYED_AT + 30) =>
  createOmnistonEvmInputValidator({request, now: () => nowSeconds * 1000});

describe("Omniston EVM input-position validator (EVM→TON source fill)", () => {
  it("accepts the live shape: factory event for the hashlock, pinned terms, derived address, funded escrow, inside the window", async () => {
    await expect(validator(rpc())(INPUT)).resolves.toBe(true);
  });

  it("looks for the event at the trusted factory only, within the finalized range", async () => {
    const request = rpc();
    await validator(request)(INPUT);
    const logs = request.mock.calls.find(([, method]) => method === "eth_getLogs")![2] as [{address: string; topics: string[]; fromBlock: string; toBlock: string}];
    expect(logs[0]).toMatchObject({address: FACTORY, topics: [SRC_ESCROW_CREATED_TOPIC], toBlock: "0x50"}); // 0x64 − 20 confirmations
    await expect(validator(rpc({logAddress: LOP}))(INPUT)).resolves.toBe(false);
  });

  it("refuses every term that differs from what the wallet signed", async () => {
    const cases: [string, Parameters<typeof rpc>[0], Partial<EvmInputValidationInput>?][] = [
      ["another maker", {maker: RESOLVER}],
      ["another resolver", {taker: OWNER}],
      ["another token", {token: STUB_TAKER_ASSET}],
      ["partial fill", {amount: 19_000_000n}],
      ["smaller safety deposit", {safetyDeposit: 1n}],
      ["TON output amount drifted", {complementAmount: 20_000_000n}],
      ["foreign timelock profile", {timelocks: timelocks([1n, 120n, 240n, 300n, 1n, 120n, 60n])}],
      ["extra immutables parameters", {parameters: "0x01"}],
      ["deployed long before the quote", {timelocks: timelocks(undefined, BigInt(QUOTE_TIME - 121))}],
      ["another hashlock", {}, {secretHash: new Uint8Array(32)}],
    ];
    for (const [label, opts, patch] of cases) {
      await expect(validator(rpc(opts))({...INPUT, ...patch}), label).resolves.toBe(false);
    }
  });

  it("refuses when the position is not the factory's derived escrow, is unfunded, unconfirmed or reverted", async () => {
    await expect(validator(rpc({derived: OWNER}))(INPUT)).resolves.toBe(false);
    await expect(validator(rpc({code: "0x"}))(INPUT)).resolves.toBe(false);
    await expect(validator(rpc({reportedFactory: LOP}))(INPUT)).resolves.toBe(false);
    await expect(validator(rpc({tokenBalance: 19_999_999n}))(INPUT)).resolves.toBe(false);
    await expect(validator(rpc({nativeBalance: 1n}))(INPUT)).resolves.toBe(false);
    await expect(validator(rpc({status: "0x0"}))(INPUT)).resolves.toBe(false);
    await expect(validator(rpc({blockTimestamp: DEPLOYED_AT + 1}))(INPUT)).resolves.toBe(false);
    await expect(validator(rpc({blockNumber: "0x60", latest: "0x64"}))(INPUT)).resolves.toBe(false); // 4 confirmations on Base
  });

  it("refuses to disclose within 45 s of the source cancellation stage", async () => {
    await expect(validator(rpc(), DEPLOYED_AT + 194)(INPUT)).resolves.toBe(true);
    await expect(validator(rpc(), DEPLOYED_AT + 195)(INPUT)).resolves.toBe(false);
    await expect(validator(rpc(), DEPLOYED_AT + 300)(INPUT)).resolves.toBe(false);
  });

  it("never throws: an RPC failure is a refusal", async () => {
    const request = vi.fn(async () => { throw new Error("rpc down"); });
    await expect(createOmnistonEvmInputValidator({request})(INPUT)).resolves.toBe(false);
    await expect(validator(rpc())({...INPUT, chain: "eip155:10"})).resolves.toBe(false);
  });

  it("EVM destination: the recorded complement must name the quoted chain, token and destination deposit", async () => {
    const ARB_USDT0 = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
    const dest = {destinationChainId: 42161, destinationTokenAddress: ARB_USDT0, dstSecurityDepositUnits: "600000000000000"};
    const evmDest = {complementChainId: 42161n, complementToken: ARB_USDT0, complementDeposit: 600_000_000_000_000n};
    await expect(validator(rpc(evmDest))({...INPUT, ...dest})).resolves.toBe(true);
    await expect(validator(rpc({...evmDest, complementChainId: 8453n}))({...INPUT, ...dest})).resolves.toBe(false);
    await expect(validator(rpc({...evmDest, complementToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}))({...INPUT, ...dest})).resolves.toBe(false);
    await expect(validator(rpc({...evmDest, complementDeposit: 1n}))({...INPUT, ...dest})).resolves.toBe(false);
    // A TON-shaped complement (chain 0, stub token) is refused for an EVM destination.
    await expect(validator(rpc())({...INPUT, ...dest})).resolves.toBe(false);
  });
});
