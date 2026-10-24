/**
 * Live, opt-in (JUPITER_LIVE=1): a real /build answer → the assembled transaction → @anywalletkit/wallet-solana's
 * serialized-transaction guard on mainnet (program allowlist, simulation, balance proof against the quote), for a
 * well-funded public wallet. Nothing is signed. Keyless Jupiter is 0.5 RPS: the cases run one after another.
 */
import {describe, expect, it} from "vitest";
import {WalletAccountReadOnlySolana} from "@anywalletkit/wallet-solana";
import {jupiterProvider} from "../src/provider.js";
import {WSOL_MINT} from "../src/config.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const WHALE = process.env.JUPITER_LIVE_TAKER ?? "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"; // holds SOL and USDC
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ALLOWANCE = 20_000_000n; // swap2 engine's default serializedNativeAllowance (rent / fees slack)
const pause = () => new Promise((r) => setTimeout(r, 2_500));

describe.runIf(process.env.JUPITER_LIVE === "1")("jupiter live → wallet-solana guard (mainnet simulation, unsigned)", () => {
  const cases = [
    {name: "0.05 SOL → USDC", sourceToken: "SOL", destToken: USDC, amountIn: "50000000", mintIn: WSOL_MINT, mintOut: USDC},
    {name: "5 USDC → SOL", sourceToken: "USDC", destToken: "0x0000000000000000000000000000000000000000", amountIn: "5000000", mintIn: USDC, mintOut: WSOL_MINT},
  ];
  for (const c of cases) {
    it(c.name, async () => {
      await pause();
      const reasons: string[] = [];
      const p = jupiterProvider({rpcUrls: [RPC]});
      const q = await p.getQuote({sourceChain: "solana:mainnet", sourceToken: c.sourceToken, destChain: "solana:mainnet", destToken: c.destToken, amountIn: c.amountIn, slippageBps: 50, destAddress: WHALE, refundAddress: WHALE, dry: false, onRefusal: (r) => reasons.push(r)});
      expect(reasons).toEqual([]);
      const native = c.mintIn === WSOL_MINT;
      const account = new WalletAccountReadOnlySolana(WHALE, {rpcUrl: RPC});
      const check = await account.checkSerialized(q!.txRequest!.serializedTx!, {
        expect: {
          maxLamportsOut: (native ? BigInt(c.amountIn) : 0n) + ALLOWANCE,
          tokenIn: {mint: c.mintOut, minAmount: BigInt(q!.minDestAmount)},
          ...(native ? {} : {maxTokenOut: {mint: c.mintIn, amount: BigInt(c.amountIn)}}),
        },
      });
      console.log(c.name, {route: q!.providerData?.route, cu: q!.providerData?.computeUnits, out: q!.destAmount, min: q!.minDestAmount, tokenInDelta: check.tokenInDelta, lamportsDelta: check.lamportsDelta, fee: check.quote.fee});
      // A token output must arrive in full; a SOL output nets at least the minimum less the network fee.
      if (c.mintOut === WSOL_MINT) expect(check.lamportsDelta).toBeGreaterThanOrEqual(BigInt(q!.minDestAmount) - check.quote.fee);
      else expect(check.tokenInDelta!).toBeGreaterThanOrEqual(BigInt(q!.minDestAmount));
    }, 60_000);
  }
});
