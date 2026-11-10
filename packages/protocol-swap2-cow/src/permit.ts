/**
 * The EIP-2612 permit that gives GPv2VaultRelayer its allowance without a transaction: the account signs the
 * token's `Permit` typed data, and the token's own `permit(...)` call rides in the order's appData as the one
 * pre-hook this module writes — the settlement runs it right before it pulls the tokens.
 *
 * A token gets a permit only when it proves, on-chain, that it speaks plain EIP-2612: `nonces(owner)` answers,
 * `DOMAIN_SEPARATOR()` equals the separator of a domain this module can name ({name, version, chainId,
 * verifyingContract} or the same without version), and — when the token exposes it — `PERMIT_TYPEHASH()` is
 * EIP-2612's (so DAI's own permit form is left to the approval transaction). After the account signed, the exact
 * `permit` call is simulated; a token that refuses it falls back to the approval transaction on the next try.
 */
import {decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData, keccak256, parseAbi, recoverAddress, stringToHex, type Hex} from "viem";
import {COW_VAULT_RELAYER} from "./deployments.js";
import {isRpcAnswer, type CowRpc} from "./rpc.js";

/** `keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")`. */
export const EIP2612_PERMIT_TYPEHASH = "0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9";
/** `permit(address,address,uint256,uint256,uint8,bytes32,bytes32)`. */
export const PERMIT_SELECTOR = "0xd505accf";
/** Gas the permit hook may use — the hook's `gasLimit` in appData. A token whose `permit` needs more gets the approval transaction. */
export const COW_PERMIT_HOOK_GAS = 100_000n;

const PERMIT_ABI = parseAbi([
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function PERMIT_TYPEHASH() view returns (bytes32)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
]);
const PERMIT_TYPE = [
  {name: "owner", type: "address"},
  {name: "spender", type: "address"},
  {name: "value", type: "uint256"},
  {name: "nonce", type: "uint256"},
  {name: "deadline", type: "uint256"},
] as const;

/** The EIP-712 domain of a token's permit: `version` is absent for tokens whose domain has none. */
export interface PermitDomain {
  name: string;
  version?: string;
}

export interface PermitRequest {
  chainId: number;
  token: string;
  domain: PermitDomain;
  owner: string;
  /** The allowance, base units, decimal. */
  value: string;
  /** The token's `nonces(owner)`, decimal. */
  nonce: string;
  /** Unix seconds — the order's `validTo`. */
  deadline: number;
}

export interface PermitTypedData {
  domain: {name: string; version?: string; chainId: number; verifyingContract: string};
  types: {EIP712Domain: {name: string; type: string}[]; Permit: readonly {name: string; type: string}[]};
  primaryType: "Permit";
  message: {owner: string; spender: string; value: string; nonce: string; deadline: string};
}

const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
/** A token's name or version as it may enter a signed domain: short, printable. */
const domainText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64 && !/[\u0000-\u001f\u007f]/.test(v);

function assertRequest(p: PermitRequest): void {
  if (!Number.isSafeInteger(p.chainId) || p.chainId <= 0) throw new Error("cow: permit chain id must be a positive integer");
  if (!domainText(p.domain.name) || (p.domain.version !== undefined && !domainText(p.domain.version))) throw new Error("cow: the token's permit domain is malformed");
  if (!DECIMAL.test(p.value) || !DECIMAL.test(p.nonce)) throw new Error("cow: permit value and nonce must be decimals");
  if (!Number.isSafeInteger(p.deadline) || p.deadline <= 0 || p.deadline >= 0xffffffff) throw new Error("cow: permit deadline must be a unix time");
}

/** The typed data the account signs: this owner, the GPv2 vault relayer as the spender, nothing else. */
export function permitTypedData(p: PermitRequest): PermitTypedData {
  assertRequest(p);
  const versioned = p.domain.version !== undefined;
  return {
    domain: {name: p.domain.name, ...(versioned ? {version: p.domain.version} : {}), chainId: p.chainId, verifyingContract: getAddress(p.token)},
    types: {
      EIP712Domain: [
        {name: "name", type: "string"},
        ...(versioned ? [{name: "version", type: "string"}] : []),
        {name: "chainId", type: "uint256"},
        {name: "verifyingContract", type: "address"},
      ],
      Permit: PERMIT_TYPE,
    },
    primaryType: "Permit",
    message: {owner: getAddress(p.owner), spender: COW_VAULT_RELAYER, value: p.value, nonce: p.nonce, deadline: String(p.deadline)},
  };
}

/** The digest of {@link permitTypedData}. */
export function permitDigest(p: PermitRequest): Hex {
  const td = permitTypedData(p);
  return hashTypedData({
    domain: {...td.domain, verifyingContract: td.domain.verifyingContract as Hex},
    types: {Permit: PERMIT_TYPE},
    primaryType: "Permit",
    message: {owner: td.message.owner as Hex, spender: td.message.spender as Hex, value: BigInt(p.value), nonce: BigInt(p.nonce), deadline: BigInt(p.deadline)},
  });
}

/** The token's domain separator for `domain`, computed locally. */
export function permitDomainSeparator(chainId: number, token: string, domain: PermitDomain): Hex {
  const versioned = domain.version !== undefined;
  const typeHash = keccak256(stringToHex(`EIP712Domain(string name,${versioned ? "string version," : ""}uint256 chainId,address verifyingContract)`));
  return keccak256(encodeAbiParameters(
    [{type: "bytes32"}, {type: "bytes32"}, ...(versioned ? [{type: "bytes32"} as const] : []), {type: "uint256"}, {type: "address"}],
    [typeHash, keccak256(stringToHex(domain.name)), ...(versioned ? [keccak256(stringToHex(domain.version!))] : []), BigInt(chainId), getAddress(token)] as never,
  ));
}

/** A 65-byte signature as (v, r, s); `v` 0/1 is read as 27/28. Null for anything else. */
export function splitSignature(signature: string): {v: number; r: Hex; s: Hex} | null {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  let v = parseInt(signature.slice(130), 16);
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) return null;
  return {v, r: `0x${signature.slice(2, 66)}`, s: `0x${signature.slice(66, 130)}`};
}

/** The signature with `v` as 27/28 — the form GPv2Settlement and the orderbook read. Null when it is not 65 bytes. */
export function canonicalSignature(signature: string): Hex | null {
  const parts = splitSignature(signature);
  return parts ? (`${parts.r}${parts.s.slice(2)}${parts.v.toString(16)}`.toLowerCase() as Hex) : null;
}

/** True when `signature` is `owner`'s ECDSA signature over `digest`. */
export async function signedBy(digest: Hex, signature: string, owner: string): Promise<boolean> {
  const canonical = canonicalSignature(signature);
  if (!canonical) return false;
  try {
    return (await recoverAddress({hash: digest, signature: canonical})).toLowerCase() === owner.toLowerCase();
  } catch {
    return false;
  }
}

/** `permit(owner, vaultRelayer, value, deadline, v, r, s)` calldata. */
export function encodePermitCall(p: Pick<PermitRequest, "owner" | "value" | "deadline">, signature: string): Hex {
  const parts = splitSignature(signature);
  if (!parts) throw new Error("cow: a permit signature must be 65 bytes");
  if (!DECIMAL.test(p.value)) throw new Error("cow: permit value must be a decimal");
  return encodeFunctionData({abi: PERMIT_ABI, functionName: "permit", args: [getAddress(p.owner), COW_VAULT_RELAYER, BigInt(p.value), BigInt(p.deadline), parts.v, parts.r, parts.s]});
}

/**
 * A `permit` call of the same size and shape with a stand-in signature — for the quote only, so the price already
 * counts the hook. It can authorise nothing: its signature recovers no owner.
 */
export function placeholderPermitCall(p: Pick<PermitRequest, "owner" | "value" | "deadline">): Hex {
  return encodePermitCall(p, `0x${"0".repeat(63)}1${"0".repeat(63)}11b`);
}

const word = (hex: string): Hex | null => (/^0x[0-9a-fA-F]{64}$/.test(hex) ? (hex.toLowerCase() as Hex) : null);

async function readString(rpc: CowRpc, chainId: number, token: string, fn: "name" | "version"): Promise<string | null> {
  try {
    const out = await rpc.call(chainId, token, encodeFunctionData({abi: PERMIT_ABI, functionName: fn}));
    const [text] = decodeAbiParameters([{type: "string"}], out as Hex);
    return domainText(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * The token's EIP-2612 domain and the owner's current nonce, or null when the token does not prove plain EIP-2612
 * (or an RPC did not answer — the caller then takes the approval transaction).
 */
export async function detectPermit(rpc: CowRpc, chainId: number, token: string, owner: string): Promise<{domain: PermitDomain; nonce: string} | null> {
  if (!rpc.has(chainId)) return null;
  try {
    const [nonceWord, separatorWord] = await Promise.all([
      rpc.call(chainId, token, encodeFunctionData({abi: PERMIT_ABI, functionName: "nonces", args: [getAddress(owner)]})),
      rpc.call(chainId, token, encodeFunctionData({abi: PERMIT_ABI, functionName: "DOMAIN_SEPARATOR"})),
    ]);
    const separator = word(separatorWord);
    if (!word(nonceWord) || !separator || /^0x0+$/.test(separator)) return null;
    // A token that names its permit type must name EIP-2612's (DAI's `Permit(holder,spender,nonce,expiry,allowed)` is another call).
    const typeHash = await rpc.call(chainId, token, encodeFunctionData({abi: PERMIT_ABI, functionName: "PERMIT_TYPEHASH"})).then(word, () => null);
    if (typeHash && typeHash !== EIP2612_PERMIT_TYPEHASH) return null;

    const candidates: PermitDomain[] = [];
    try {
      const out = await rpc.call(chainId, token, encodeFunctionData({abi: PERMIT_ABI, functionName: "eip712Domain"}));
      const [fields, name, version, domainChain, verifying, , extensions] = decodeAbiParameters(
        [{type: "bytes1"}, {type: "string"}, {type: "string"}, {type: "uint256"}, {type: "address"}, {type: "bytes32"}, {type: "uint256[]"}], out as Hex);
      if (fields === "0x0f" && domainChain === BigInt(chainId) && verifying.toLowerCase() === token.toLowerCase() && extensions.length === 0 && domainText(name) && domainText(version)) {
        candidates.push({name, version});
      }
    } catch {
      // no EIP-5267: the domain is found from name() / version() below
    }
    const name = await readString(rpc, chainId, token, "name");
    if (name) {
      const version = await readString(rpc, chainId, token, "version");
      for (const v of [version, "1", "2"]) if (v && !candidates.some((c) => c.name === name && c.version === v)) candidates.push({name, version: v});
      candidates.push({name});
    }
    const domain = candidates.find((c) => permitDomainSeparator(chainId, token, c) === separator);
    if (!domain) return null;
    return {domain, nonce: BigInt(nonceWord).toString()};
  } catch {
    return null;
  }
}

/**
 * Runs the exact `permit` call against the latest block. Resolves when the token accepts it within the hook's gas;
 * throws when it reverts, needs more gas than the hook has, or no RPC answered — the order is then not signed.
 */
export async function simulatePermit(rpc: CowRpc, chainId: number, token: string, from: string, callData: Hex): Promise<void> {
  let estimate: unknown;
  try {
    estimate = await rpc.request(chainId, "eth_estimateGas", [{from, to: token, data: callData}]);
  } catch (e) {
    throw new Error(isRpcAnswer(e) ? "cow: the token refused the signed permit" : "cow: the signed permit could not be checked (no RPC answered)");
  }
  if (typeof estimate !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(estimate)) throw new Error("cow: the signed permit could not be checked (malformed gas estimate)");
  const gas = BigInt(estimate);
  // The estimate is a whole transaction (21 000 of it is not the hook's); 10 % of room on top.
  const hookGas = gas > 21_000n ? ((gas - 21_000n) * 11n) / 10n : 0n;
  if (hookGas > COW_PERMIT_HOOK_GAS) throw new Error(`cow: the token's permit needs about ${hookGas} gas, more than the ${COW_PERMIT_HOOK_GAS} the order's hook has`);
}
