// The pinned contracts: the same constants the engine's own gate holds, one row per shipped chain, and an extra
// chain can never bring another settlement contract or vault relayer.
import {describe, expect, it} from "vitest";
import {getAddress} from "viem";
import {GPV2_NATIVE_BUY, GPV2_SETTLEMENT, GPV2_VAULT_RELAYER} from "@anywalletkit/protocol-swap2-core";
import {COW_API_BASE, COW_DEPLOYMENTS, COW_ETH_FLOW, COW_NATIVE, COW_SETTLEMENT, COW_VAULT_RELAYER, cowDeployments, deploymentOf} from "../src/deployments.js";
import {cowProvider} from "../src/provider.js";

const GNOSIS = {chainId: 100, network: "xdai", label: "Gnosis", settlement: COW_SETTLEMENT, vaultRelayer: COW_VAULT_RELAYER, ethFlow: COW_ETH_FLOW, wrappedNative: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d"};

describe("pinned deployments", () => {
  it("are the engine's constants, checksummed", () => {
    expect([COW_SETTLEMENT, COW_VAULT_RELAYER, COW_NATIVE]).toEqual([GPV2_SETTLEMENT, GPV2_VAULT_RELAYER, GPV2_NATIVE_BUY]);
    for (const a of [COW_SETTLEMENT, COW_VAULT_RELAYER, COW_ETH_FLOW, COW_NATIVE]) expect(getAddress(a)).toBe(a);
    expect(COW_SETTLEMENT).toBe("0x9008D19f58AAbD9eD0D60971565AA8510560ab41");
    expect(COW_VAULT_RELAYER).toBe("0xC92E8bdf79f0507f65a392b0ab4667716BFE0110");
    expect(COW_ETH_FLOW).toBe("0xbA3cB449bD2B4ADddBc894D8697F5170800EAdeC");
    expect(COW_API_BASE).toBe("https://api.cow.fi");
  });
  it("Ethereum, Base and Arbitrum — each with the orderbook network and the chain's wrapped native", () => {
    expect(Object.keys(COW_DEPLOYMENTS)).toEqual(["1", "8453", "42161"]);
    expect(Object.values(COW_DEPLOYMENTS).map((d) => [d.chainId, d.network, d.wrappedNative])).toEqual([
      [1, "mainnet", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"],
      [8453, "base", "0x4200000000000000000000000000000000000006"],
      [42161, "arbitrum_one", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"],
    ]);
    for (const d of Object.values(COW_DEPLOYMENTS)) {
      expect([d.settlement, d.vaultRelayer, d.ethFlow]).toEqual([COW_SETTLEMENT, COW_VAULT_RELAYER, COW_ETH_FLOW]);
      expect(getAddress(d.wrappedNative)).toBe(d.wrappedNative);
    }
    expect(Object.isFrozen(COW_DEPLOYMENTS)).toBe(true);
  });
  it("a lookup finds own rows only", () => {
    expect(deploymentOf(COW_DEPLOYMENTS, 8453)?.network).toBe("base");
    expect(deploymentOf(COW_DEPLOYMENTS, 100)).toBeNull();
    expect(deploymentOf(COW_DEPLOYMENTS, "constructor" as never)).toBeNull();
  });
  it("a chain is added by configuration — never with another settlement contract or vault relayer", () => {
    expect(cowDeployments()).toBe(COW_DEPLOYMENTS);
    expect(Object.keys(cowDeployments({100: GNOSIS}))).toEqual(["1", "100", "8453", "42161"]);
    const p = cowProvider({enabled: true, chains: {100: GNOSIS}});
    expect(p.supportsChain!("eip155:100")).toBe(true);
    expect(p.cancelTargets!("eip155:100")).toEqual([COW_SETTLEMENT, COW_ETH_FLOW]);
    const other = "0x1111111111111111111111111111111111111111";
    expect(() => cowDeployments({100: {...GNOSIS, settlement: other}})).toThrow(/canonical GPv2Settlement/);
    expect(() => cowDeployments({100: {...GNOSIS, vaultRelayer: other}})).toThrow(/canonical GPv2Settlement/);
    expect(() => cowDeployments({100: {...GNOSIS, chainId: 10}})).toThrow(/not a valid deployment entry/);
    expect(() => cowDeployments({100: {...GNOSIS, network: "../x"}})).toThrow(/names no orderbook network/);
    expect(() => cowDeployments({100: {...GNOSIS, ethFlow: "0x12"}})).toThrow(/malformed address/);
  });
});
