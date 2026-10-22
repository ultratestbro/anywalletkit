import {describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, stringToHex, type Hex} from "viem";
import {createOmnistonEvmDeliveryLocator, createOmnistonEvmOutputValidator, type EvmOutputValidationInput} from "../../src/validators/evm-output.js";

const FACTORY = "0xafCF681272AF10959736f45616eeCBC22D7095E2";
const POSITION = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const HASH = Uint8Array.from({length: 32}, (_, index) => index + 1);
const HASH_HEX = `0x${Buffer.from(HASH).toString("hex")}` as Hex;
const QUOTE_TIME = 1_700_000_000;

const FACTORY_ABI = [{
  type: "function", name: "createDstEscrow", stateMutability: "payable",
  inputs: [{name: "dstImmutables", type: "tuple", components: [
    {name: "orderHash", type: "bytes32"}, {name: "hashlock", type: "bytes32"},
    {name: "maker", type: "uint256"}, {name: "taker", type: "uint256"},
    {name: "token", type: "uint256"}, {name: "amount", type: "uint256"},
    {name: "safetyDeposit", type: "uint256"}, {name: "timelocks", type: "uint256"},
    {name: "parameters", type: "bytes"},
  ]}, {name: "srcCancellationTimestamp", type: "uint256"}], outputs: [],
}, {
  type: "function", name: "addressOfEscrowDst", stateMutability: "view",
  inputs: [{name: "immutables", type: "tuple", components: [
    {name: "orderHash", type: "bytes32"}, {name: "hashlock", type: "bytes32"},
    {name: "maker", type: "uint256"}, {name: "taker", type: "uint256"},
    {name: "token", type: "uint256"}, {name: "amount", type: "uint256"},
    {name: "safetyDeposit", type: "uint256"}, {name: "timelocks", type: "uint256"},
    {name: "parameters", type: "bytes"},
  ]}], outputs: [{type: "address"}],
}] as const;

const INPUT: EvmOutputValidationInput = {
  chain: "eip155:1",
  positionAddress: POSITION,
  factoryAddress: FACTORY,
  quoteTimestamp: QUOTE_TIME,
  executionIndex: 0,
  recipientAddress: RECIPIENT,
  outputTokenAddress: TOKEN,
  inputUnits: "1000000",
  outputUnits: "990000",
  resolverSendsUnits: "995000",
  srcHtlcSecurityDepositUnits: "500",
  dstSecurityDepositUnits: "1000",
  protocolFeeUnits: "5000",
  integratorFeeUnits: "0",
  protocolFeeRecipientAddress: "0x6666666666666666666666666666666666666666",
  secretHash: HASH,
};

function successfulRpc(opts: {wrapped?: boolean; maker?: string; tokenBalance?: bigint; nativeBalance?: bigint; decoyMaker?: string; hidden?: boolean} = {}) {
  const immutables = {
    orderHash: `0x${"44".repeat(32)}` as Hex,
    hashlock: HASH_HEX,
    maker: BigInt(opts.maker ?? RECIPIENT),
    taker: BigInt("0x5555555555555555555555555555555555555555"),
    token: BigInt(TOKEN),
    amount: 995000n,
    safetyDeposit: 1000n,
    timelocks: 1n | (120n << 32n) | (240n << 64n) | (300n << 96n) |
      (1n << 128n) | (120n << 160n) | (180n << 192n),
    parameters: encodeAbiParameters(
      [{type: "uint256"}, {type: "uint256"}, {type: "uint256"}, {type: "uint256"}],
      [5000n, 0n, BigInt("0x6666666666666666666666666666666666666666"), 0n],
    ),
  };
  // What the calldata shows. A decoy carries a tuple paying the recipient
  // while the escrow actually deployed (the CREATE2 truth below) does not.
  const shown = opts.decoyMaker ? {...immutables, maker: BigInt(opts.decoyMaker)} : immutables;
  const txInput = opts.hidden
    ? (`0x48de5a3b${"00".repeat(320)}` as Hex)
    : encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createDstEscrow",
      args: [shown, BigInt(QUOTE_TIME + 600)],
    });
  // The factory derives the escrow from the immutables with deployedAt stamped.
  const deployed = {...immutables, timelocks: immutables.timelocks | (BigInt(QUOTE_TIME) << 224n)};
  const sameImmutables = (a: typeof immutables, b: typeof immutables) =>
    a.orderHash === b.orderHash && a.hashlock.toLowerCase() === b.hashlock.toLowerCase() && a.maker === b.maker && a.taker === b.taker &&
    a.token === b.token && a.amount === b.amount && a.safetyDeposit === b.safetyDeposit && a.timelocks === b.timelocks &&
    a.parameters.toLowerCase() === b.parameters.toLowerCase();
  const eventData = encodeAbiParameters(
    [{type: "address"}, {type: "bytes32"}, {type: "uint256"}],
    [POSITION, HASH_HEX, immutables.taker],
  );
  return vi.fn(async (_chain: string, method: string, params: unknown[]) => {
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_getLogs") return [{
      data: eventData,
      transactionHash: `0x${"77".repeat(32)}`,
      blockNumber: "0x50",
    }];
    if (method === "eth_getTransactionByHash") {
      // A real resolver deploys the escrow through its OWN contract: the tx
      // targets the resolver, carries a private selector and sends no value,
      // and only the factory emits the event. That shape used to be rejected.
      return opts.wrapped
        ? {to: "0x9999999999999999999999999999999999999999", input: `0x48de5a3b${"00".repeat(32)}${txInput.slice(10)}` as Hex, value: "0x0"}
        : {to: FACTORY, input: txInput, value: "0x3e8"};
    }
    if (method === "eth_getTransactionReceipt") return {status: "0x1", blockNumber: "0x50"};
    if (method === "eth_getBlockByNumber") return {timestamp: `0x${QUOTE_TIME.toString(16)}`};
    if (method === "eth_getCode") return "0x6001";
    if (method === "eth_getBalance") return `0x${(opts.nativeBalance ?? 1000n).toString(16)}`;
    if (method === "eth_call") {
      const call = params[0] as {to: string; data: Hex};
      if (call.to.toLowerCase() === FACTORY.toLowerCase()) {
        const {args} = decodeFunctionData({abi: FACTORY_ABI, data: call.data});
        const asked = args[0] as typeof immutables;
        return encodeAbiParameters([{type: "address"}], [sameImmutables(asked, deployed) ? POSITION : "0x0000000000000000000000000000000000000bad"]);
      }
      if (call.to.toLowerCase() === POSITION.toLowerCase()) {
        return encodeAbiParameters([{type: "address"}], [FACTORY]);
      }
      if (call.to.toLowerCase() === TOKEN.toLowerCase()) {
        return encodeAbiParameters([{type: "uint256"}], [opts.tokenBalance ?? 995000n]);
      }
    }
    throw new Error(`unexpected ${method}`);
  });
}

describe("Omniston EVM output-position validation", () => {
  it("proves the finalized factory event, creation calldata and escrow state", async () => {
    const request = successfulRpc();
    const validate = createOmnistonEvmOutputValidator({request, now: () => QUOTE_TIME * 1000 + 60_000});
    await expect(validate(INPUT)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("eip155:1", "eth_getLogs", [expect.objectContaining({
      address: FACTORY,
      topics: [keccak256(stringToHex("DstEscrowCreated(address,bytes32,uint256)"))],
    })]);
  });

  it("rejects a recipient substitution even when the feed address and hash exist", async () => {
    const request = successfulRpc();
    const validate = createOmnistonEvmOutputValidator({request, now: () => QUOTE_TIME * 1000 + 60_000});
    await expect(validate({...INPUT, recipientAddress: "0x9999999999999999999999999999999999999999"})).resolves.toBe(false);
  });

  it("rejects a feed-only READY signal with no matching on-chain factory event", async () => {
    const request = vi.fn(async (_chain: string, method: string) => method === "eth_blockNumber" ? "0x64" : []);
    const validate = createOmnistonEvmOutputValidator({request, now: () => QUOTE_TIME * 1000 + 60_000});
    await expect(validate(INPUT)).resolves.toBe(false);
  });

  it("accepts an escrow deployed through the resolver's own contract", async () => {
    // The production shape: only the factory's event ties the escrow to our
    // hashlock, and the immutables ride inside the resolver's calldata.
    const validate = createOmnistonEvmOutputValidator({request: successfulRpc({wrapped: true}), now: () => QUOTE_TIME * 1000});
    await expect(validate(INPUT)).resolves.toBe(true);
  });

  it("rejects a wrapped escrow that would pay somebody else", async () => {
    const request = successfulRpc({wrapped: true, maker: "0x000000000000000000000000000000000000dEaD"});
    const validate = createOmnistonEvmOutputValidator({request, now: () => QUOTE_TIME * 1000});
    await expect(validate(INPUT)).resolves.toBe(false);
  });

  it("rejects a decoy tuple in the calldata that is not the deployed escrow's", async () => {
    // The real escrow pays someone else; the calldata carries a tuple paying
    // the recipient. Only the factory's own derivation tells them apart.
    const request = successfulRpc({wrapped: true, maker: "0x000000000000000000000000000000000000dEaD", decoyMaker: RECIPIENT});
    const validate = createOmnistonEvmOutputValidator({request, now: () => QUOTE_TIME * 1000});
    await expect(validate(INPUT)).resolves.toBe(false);
  });

  it("fails closed when the immutables cannot be found in the calldata", async () => {
    const validate = createOmnistonEvmOutputValidator({request: successfulRpc({hidden: true}), now: () => QUOTE_TIME * 1000});
    await expect(validate(INPUT)).resolves.toBe(false);
  });

  it("rejects an escrow that does not hold the promised output", async () => {
    const validate = createOmnistonEvmOutputValidator({request: successfulRpc({tokenBalance: 994_999n}), now: () => QUOTE_TIME * 1000});
    await expect(validate(INPUT)).resolves.toBe(false);
  });

  it("rejects an escrow without the resolver's safety deposit", async () => {
    const validate = createOmnistonEvmOutputValidator({request: successfulRpc({nativeBalance: 999n}), now: () => QUOTE_TIME * 1000});
    await expect(validate(INPUT)).resolves.toBe(false);
  });
});

describe("Omniston EVM RPC endpoints", () => {
  it("tries the caller's rpcUrls before the public fallbacks and reads no env", async () => {
    const {omnistonEvmRpcRequest} = await import("../../src/validators/evm-output.js");
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url);
      if (url === "https://own.example/a") return new Response("nope", {status: 500});
      return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result: "0x10"}), {status: 200});
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await omnistonEvmRpcRequest("eip155:8453", "eth_blockNumber", [], {"eip155:8453": ["https://own.example/a", "https://own.example/b"]});
      expect(result).toBe("0x10");
      expect(seen).toEqual(["https://own.example/a", "https://own.example/b"]);
      seen.length = 0;
      await omnistonEvmRpcRequest("eip155:8453", "eth_blockNumber", []);
      expect(seen).toEqual(["https://base-rpc.publicnode.com"]);
      await expect(omnistonEvmRpcRequest("eip155:999999", "eth_blockNumber", [])).rejects.toThrow("no RPC configured");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Omniston EVM delivery locator", () => {
  const log = (amount: bigint, hash: string) => ({address: TOKEN, data: encodeAbiParameters([{type: "uint256"}], [amount]), transactionHash: hash, blockNumber: "0x60"});
  it("returns the escrow's payout to the recipient of at least the promised amount", async () => {
    const request = vi.fn(async (_chain: string, method: string, params: unknown[]) => {
      if (method === "eth_blockNumber") return "0x64";
      const filter = params[0] as {topics: string[]; address: string};
      expect(filter.address).toBe(TOKEN);
      expect(filter.topics[1]).toBe(`0x${POSITION.slice(2).padStart(64, "0")}`);
      expect(filter.topics[2]).toBe(`0x${RECIPIENT.slice(2).padStart(64, "0")}`);
      return [log(989_999n, `0x${"aa".repeat(32)}`), log(990_000n, `0x${"bb".repeat(32)}`)];
    });
    const locate = createOmnistonEvmDeliveryLocator({request});
    const input = {chain: "eip155:1", positionAddress: POSITION, recipientAddress: RECIPIENT, tokenAddress: TOKEN, minUnits: "990000"};
    await expect(locate(input)).resolves.toBe(`0x${"bb".repeat(32)}`);
    await expect(locate({...input, minUnits: "990001"})).resolves.toBeNull();
    await expect(locate({...input, chain: "eip155:10"})).resolves.toBeNull();
  });
});
