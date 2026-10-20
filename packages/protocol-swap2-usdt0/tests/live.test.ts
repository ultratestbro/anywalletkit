import {describe, expect, it} from "vitest";
import {decodeFunctionData, parseAbi, type Hex} from "viem";
import {usdt0Provider} from "../src/provider.js";
import {USDT0_CHAINS} from "../src/config.js";

/**
 * Live, read-only: `quoteOFT` + `quoteSend` on the real Arbitrum OFT for 10
 * USDT0 → HyperEVM over a public RPC. Opt-in (USDT0_LIVE=1) so the unit run
 * never touches the network; `pnpm verify:live` covers every deployment.
 */
const live = process.env.USDT0_LIVE === "1";
const ARB = USDT0_CHAINS["eip155:42161"]!;
const HYPE = USDT0_CHAINS["eip155:999"]!;
const ABI = parseAbi([
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "function send(SendParam s, MessagingFee fee, address refundAddress) payable",
]);

describe.skipIf(!live)("live: USDT0 Arbitrum → HyperEVM", () => {
  it("quotes 10 USDT0 with a positive native fee, full amount received, calldata on the Arbitrum OFT", async () => {
    const p = usdt0Provider({rpcUrls: {"eip155:42161": process.env.RPC_42161 ?? "https://arbitrum-one-rpc.publicnode.com"}});
    const reasons: string[] = [];
    const me = "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA";
    const q = await p.getQuote({sourceChain: ARB.caip2, sourceToken: "USDT0", destChain: HYPE.caip2, destToken: HYPE.token, amountIn: "10000000", destAddress: me, refundAddress: me, onRefusal: (r) => reasons.push(r)});
    expect(reasons).toEqual([]);
    expect(q).not.toBeNull();
    expect(q!.destAmount).toBe("10000000");
    expect(BigInt(q!.txRequest!.nativeFee!)).toBeGreaterThan(0n);
    expect(BigInt(q!.txRequest!.nativeFee!)).toBeLessThan(10n ** 15n); // well under 0.001 ETH
    expect(q!.txRequest!.to).toBe(ARB.oft);
    const {args} = decodeFunctionData({abi: ABI, data: q!.txRequest!.data as Hex});
    expect(args![0]).toMatchObject({dstEid: HYPE.eid, amountLD: 10_000_000n, minAmountLD: 10_000_000n});
    await expect(p.preflightDeposit!(q!, await p.buildDeposit(q!))).resolves.toBeUndefined();
  }, 60_000);
});
