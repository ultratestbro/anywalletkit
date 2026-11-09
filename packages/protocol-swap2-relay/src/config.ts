// Relay (relay.link) — the pins this module signs against. Nothing here is read from the API at run time: the API (or
// an app's own proxy in front of it) is untrusted, and a deposit is signed only for a depository, a chain mapping and
// a solver signer written in this file.
//
// Sources, all read on 2026-11-10:
//  - `GET https://api.relay.link/chains` — per chain: `id`, `protocol.v2.chainId` (the chain's name inside an order,
//    which is NOT always `name`: BNB Chain is "bnb" in orders and "bsc" as `name`, World Chain "worldchain" /
//    "world-chain"), `protocol.v2.depository`, `solverAddresses`.
//  - On chain, over the SDK's public RPCs, for every row below: the depository has code, `allocator()` =
//    {@link RELAY_ALLOCATOR}, `owner()` = {@link RELAY_OWNER}, its EIP-712 domain reports the row's chain id, and the
//    bytecode carries the three deposit selectors. The runtime code is the same 8 628 bytes everywhere apart from the
//    immutables (the Mantle / Linea deployment is a second build, 8 777 bytes, at its own address).
//  - The contract: github.com/relayprotocol/relay-depository, packages/ethereum-vm/src/RelayDepository.sol.
//  - The order: github.com/relayprotocol/relay-protocol-sdk, src/order/index.ts (types and hashing), and Relay's own
//    "input validation" page (docs.relay.link), which names the solver below and tells integrators to take the
//    depository from `/chains` rather than from a quote.
//
// Only chains the SDK ships are listed, plus Elysium (99901), whose catalog entry is added separately. Relay also
// serves chains the SDK does not carry; the SDK's Flare (14) and Sei (1329) are not on Relay.

export interface RelayChain {
  caip2: string;
  chainId: number;
  /** The chain's name inside a Relay order (`/chains[].protocol.v2.chainId`). */
  slug: string;
  name: string;
  /** RelayDepository on that chain: the only contract a deposit calls and the only spender an approval names. */
  depository: string;
}

const DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
/** Mantle and Linea run a second deployment. */
const DEPOSITORY_B = "0x59916da825d2d2ec1bf878d71c88826f6633ecca";

const c = (chainId: number, slug: string, name: string, depository: string = DEPOSITORY): RelayChain =>
  Object.freeze({caip2: `eip155:${chainId}`, chainId, slug, name, depository});

/** CAIP-2 → the chain as Relay knows it. A null-prototype map: `RELAY_CHAINS["constructor"]` is undefined. */
export const RELAY_CHAINS: Readonly<Record<string, RelayChain>> = Object.freeze(Object.assign(Object.create(null) as Record<string, RelayChain>, Object.fromEntries([
  c(1, "ethereum", "Ethereum"),
  c(10, "optimism", "OP Mainnet"),
  c(56, "bnb", "BNB Chain"),
  c(100, "gnosis", "Gnosis"),
  c(130, "unichain", "Unichain"),
  c(137, "polygon", "Polygon"),
  c(143, "monad", "Monad"),
  c(146, "sonic", "Sonic"),
  c(196, "xlayer", "X Layer"),
  c(324, "zksync", "zkSync Era"),
  c(480, "worldchain", "World Chain"),
  c(999, "hyperevm", "HyperEVM"),
  c(2818, "morph", "Morph"),
  c(4326, "megaeth", "MegaETH"),
  c(4663, "robinhood", "Robinhood Chain"),
  c(5000, "mantle", "Mantle", DEPOSITORY_B),
  c(5042, "arc", "Arc"),
  c(8453, "base", "Base"),
  c(9745, "plasma", "Plasma"),
  c(42161, "arbitrum", "Arbitrum"),
  c(42220, "celo", "Celo"),
  c(43114, "avalanche", "Avalanche"),
  c(57073, "ink", "Ink"),
  c(59144, "linea", "Linea", DEPOSITORY_B),
  c(80094, "berachain", "Berachain"),
  c(98866, "plume", "Plume"),
  c(99901, "elysium", "Elysium"),
  c(534352, "scroll", "Scroll"),
  c(747474, "katana", "Katana"),
].map((x) => [x.caip2, x]))));

/** The chain for a CAIP-2 id, or undefined — own keys only. */
export function relayChain(caip2: string): RelayChain | undefined {
  return typeof caip2 === "string" && Object.prototype.hasOwnProperty.call(RELAY_CHAINS, caip2) ? RELAY_CHAINS[caip2] : undefined;
}

/**
 * The solver whose signature makes an order worth depositing for: `order.solver` on `order.solverChainId`, the signer of
 * `orderSignature`. One pair today (every order seen, Relay's validation page, first in `/chains[].solverAddresses`).
 * An order naming any other solver, or this address on another solver chain, is refused.
 */
export const RELAY_SOLVERS: readonly {readonly chainId: string; readonly address: string}[] = Object.freeze([
  Object.freeze({chainId: "base", address: "0xf70da97812cb96acdf810712aa562db8dfa3dbef"}),
]);

/** `allocator()` of every pinned depository (the key that authorises withdrawals from it) — a watched fact, not used in checks. */
export const RELAY_ALLOCATOR = "0x63c1d3e9c646184529c5694630a01c00df171b56";
/** `owner()` of every pinned depository — a watched fact, not used in checks. */
export const RELAY_OWNER = "0xf61a305199fa1135d76ffab3752d42f55cbd775a";

/** Relay's API. An app may point the provider at its own proxy instead (`baseUrl`); either is untrusted. */
export const RELAY_API = "https://api.relay.link";

/** The native coin in a Relay order and in the API: twenty zero bytes. */
export const RELAY_NATIVE = "0x0000000000000000000000000000000000000000";

/** `depositNative(address depositor, bytes32 id)` payable. */
export const RELAY_DEPOSIT_NATIVE = "0x49290c1c";
/** `depositErc20(address depositor, address token, uint256 amount, bytes32 id)`. */
export const RELAY_DEPOSIT_ERC20 = "0xe8017952";
/**
 * `depositErc20(address depositor, address token, bytes32 id)` — deposits the caller's WHOLE allowance. Never built and
 * always refused: the amount is not in the calldata.
 */
export const RELAY_DEPOSIT_ERC20_ALLOWANCE = "0x5a1ee3ac";

/** The only order version this module reads. */
export const RELAY_ORDER_VERSION = "v1";

/**
 * How long Relay gives an order: the output deadline and every refund deadline are the quote time + 7 days (every
 * order seen, 2026-11-02 … 2026-11-10). The verifier holds a deadline to this lifetime, which is also what makes an
 * old order stale: one issued more than {@link RELAY_MAX_ORDER_AGE_S} ago is refused even when everything else fits.
 */
export const RELAY_ORDER_LIFETIME_S = 604_800;
/** An order older than this is refused (the quote itself lives for `quoteTtlMs`, 60 s by default, 5 min at most). */
export const RELAY_MAX_ORDER_AGE_S = 600;
/** Tolerated clock difference between the device and Relay, forwards. */
export const RELAY_CLOCK_SKEW_S = 300;

export const relay = {
  supportsChain(chain: string): boolean {
    return relayChain(chain) !== undefined;
  },
  /** Two different pinned EVM chains. */
  supports(from: string, to: string): boolean {
    return from !== to && relayChain(from) !== undefined && relayChain(to) !== undefined;
  },
};
