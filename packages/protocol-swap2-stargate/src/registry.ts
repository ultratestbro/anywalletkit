import {getAddress, isAddress, zeroAddress, type Address} from "viem";
import {conversionRate} from "./amounts.js";

/** Reviewed deployment identity. Discovery metadata is never a runtime trust source. */
export interface StargateDeployment {
  readonly chain: string;
  readonly chainId: number;
  readonly eid: number;
  readonly assetId: number;
  readonly symbol: string;
  readonly token: Address;
  readonly address: Address;
  readonly tokenMessaging: Address;
  readonly endpoint: Address;
  readonly localDecimals: number;
  readonly sharedDecimals: number;
  readonly kind: "pool" | "oft" | "native";
  readonly approvalRequired: boolean;
}

/** Source TokenMessaging peer evidence. Credits/fees/paused state must still be read live. */
export interface StargatePath {
  readonly source: string;
  readonly destination: string;
}

export interface StargateRegistry {
  readonly deployments: readonly StargateDeployment[];
  readonly paths: readonly StargatePath[];
  find(chain: string, token: string): StargateDeployment | undefined;
  route(sourceChain: string, sourceToken: string, destinationChain: string, destinationToken: string): {source: StargateDeployment; destination: StargateDeployment} | undefined;
  callTargets(chain: string): readonly Address[];
  spenders(chain: string): readonly Address[];
}

function boundedInteger(value: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`stargate registry: invalid ${name}`);
}
function address(value: string, nonzero: boolean): Address {
  if (!isAddress(value) || (nonzero && value.toLowerCase() === zeroAddress)) throw new Error("stargate registry: invalid address");
  return getAddress(value);
}

/**
 * Builds immutable lookup/pin data from a reviewed static manifest. Token symbols
 * are deliberately not resolved here: a symbol can name a different token in the
 * app's catalog (USDC/USDC.e and USDT/USDT0 are not interchangeable).
 */
export function createStargateRegistry(input: readonly StargateDeployment[], inputPaths: readonly StargatePath[]): StargateRegistry {
  const ids = new Map<string, StargateDeployment>();
  const tokens = new Map<string, StargateDeployment>();
  const contracts = new Set<string>();
  const chains = new Map<string, StargateDeployment>();
  const eids = new Map<number, string>();
  const shared = new Map<number, number>();
  const deployments = Object.freeze(input.map((raw) => {
    boundedInteger(raw.chainId, Number.MAX_SAFE_INTEGER, "chainId");
    boundedInteger(raw.eid, 0xffffffff, "eid");
    boundedInteger(raw.assetId, 0xffff, "assetId");
    if (raw.chain !== `eip155:${raw.chainId}`) throw new Error("stargate registry: chainId mismatch");
    conversionRate(raw.localDecimals, raw.sharedDecimals);
    if (!["pool", "oft", "native"].includes(raw.kind) || typeof raw.approvalRequired !== "boolean" || typeof raw.symbol !== "string" || !raw.symbol.trim()) throw new Error("stargate registry: malformed deployment");
    const d = Object.freeze({...raw, token: address(raw.token, false), address: address(raw.address, true), tokenMessaging: address(raw.tokenMessaging, true), endpoint: address(raw.endpoint, true)});
    if ((d.kind === "native") !== (d.token === zeroAddress)) throw new Error("stargate registry: native token mismatch");
    const identity = `${d.chain}:${d.assetId}`;
    const tokenKey = `${d.chain}:${d.token.toLowerCase()}`;
    const contractKey = `${d.chain}:${d.address.toLowerCase()}`;
    if (ids.has(identity) || tokens.has(tokenKey) || contracts.has(contractKey)) throw new Error("stargate registry: duplicate deployment");
    const chain = chains.get(d.chain);
    if (chain && (chain.eid !== d.eid || chain.tokenMessaging !== d.tokenMessaging || chain.endpoint !== d.endpoint)) throw new Error("stargate registry: inconsistent chain messaging");
    if (eids.has(d.eid) && eids.get(d.eid) !== d.chain) throw new Error("stargate registry: eid names multiple chains");
    if (shared.has(d.assetId) && shared.get(d.assetId) !== d.sharedDecimals) throw new Error("stargate registry: incompatible shared decimals");
    ids.set(identity, d); tokens.set(tokenKey, d); contracts.add(contractKey);
    chains.set(d.chain, d); eids.set(d.eid, d.chain); shared.set(d.assetId, d.sharedDecimals);
    return d;
  }));
  const pathKeys = new Set<string>();
  const paths = Object.freeze(inputPaths.map((path) => {
    if (path.source === path.destination || !chains.has(path.source) || !chains.has(path.destination)) throw new Error("stargate registry: invalid path");
    const key = `${path.source}>${path.destination}`;
    if (pathKeys.has(key)) throw new Error("stargate registry: duplicate path");
    pathKeys.add(key);
    return Object.freeze({source: path.source, destination: path.destination});
  }));
  const lookup = (chain: string, token: string) => chains.has(chain) && isAddress(token, {strict: false})
    ? tokens.get(`${chain}:${token.toLowerCase()}`) : undefined;
  return Object.freeze({
    deployments, paths,
    find: lookup,
    route(sourceChain: string, sourceToken: string, destinationChain: string, destinationToken: string) {
      if (!pathKeys.has(`${sourceChain}>${destinationChain}`)) return undefined;
      const source = lookup(sourceChain, sourceToken), destination = lookup(destinationChain, destinationToken);
      return source && destination && source.assetId === destination.assetId ? {source, destination} : undefined;
    },
    callTargets: (chain: string) => Object.freeze(deployments.filter((d) => d.chain === chain).map((d) => d.address)),
    spenders: (chain: string) => Object.freeze(deployments.filter((d) => d.chain === chain && d.kind !== "native" && d.approvalRequired).map((d) => d.address)),
  });
}
