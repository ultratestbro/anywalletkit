// Execution scenarios for the approval policy (allowanceReuse / revokeUnspentApproval): a provider and an account that
// record every call the engine makes — quotes, allowance reads, gas checks, sends with their full payloads, waits,
// signatures, journal writes, reviews, phases — on a fixed clock, so two engines can be compared call for call.
// `runScenario` takes the engine class, so the same scenarios run against another build of this package.
import {createHash} from "node:crypto";
import {vi} from "vitest";
import {GPV2_ORDER_FIELDS, GPV2_SETTLEMENT, GPV2_VAULT_RELAYER} from "../../src/swap2/gpv2.js";
import {PERMIT2_ADDRESS} from "../../src/permit2.js";
import type {Swap2Operation, Swap2OperationStore} from "../../src/operation.js";
import type {CrossChainProvider, Quote, QuoteParams, TxRequest, UnsignedTx} from "../../src/types.js";

/** Every scenario starts at this time (fake `Date` only; timers stay real). */
export const START = 1_900_000_000_000;
export const SELF = "0x4444444444444444444444444444444444444444";
export const ROUTER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
export const OTHER = "0x9999999999999999999999999999999999999999";
export const SETTLER = "0x1035029091415555555555555555555555550001";
export const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const AMOUNT = 1_000_000n;

const NAMES: Record<string, string> = {
  [ROUTER.toLowerCase()]: "router", [OTHER.toLowerCase()]: "other", [SETTLER.toLowerCase()]: "settler",
  [PERMIT2_ADDRESS.toLowerCase()]: "permit2", [GPV2_VAULT_RELAYER.toLowerCase()]: "relayer", [GPV2_SETTLEMENT.toLowerCase()]: "settlement",
  [USDC_ETH.toLowerCase()]: "USDC", [USDT_ETH.toLowerCase()]: "USDT", [USDC_BASE.toLowerCase()]: "USDC",
};
const name = (address: unknown) => (typeof address === "string" ? NAMES[address.toLowerCase()] ?? address : String(address));

export interface ProviderSpec {
  kind: "call" | "permit2" | "gpv2";
  /** Quote lifetime by quote number (1-based), ms. Default 60 s (permit2: 30 s). */
  ttlMs?: (n: number) => number;
  /** Per-quote overrides of the transaction (call / permit2 kinds); `null` → no quote. */
  tx?: (n: number) => Partial<TxRequest> | null;
  /** Per-quote overrides of the quote itself. */
  quote?: (n: number) => Partial<Quote>;
  preflight?: () => Error | undefined;
  ownGasEstimate?: boolean;
  /** gpv2: the allowance target the build declares. */
  approvalAmount?: string;
  /** gpv2: registerSignedOrder failure. */
  register?: () => Error | undefined;
}

export interface AccountSpec {
  /** undefined: the account has no getAllowance. */
  allowance?: bigint | "throws";
  /** getBalance + quoteSendTransaction (the native-gas check, dry runs). */
  gas?: boolean;
  /** A send that throws: by its decoded kind ("approve <amount>", "revoke", "deposit") and how many sends came before. */
  failSend?: (kind: string, index: number) => Error | undefined;
  /** The approval takes this long to mine (the clock moves on). */
  mineMs?: number;
  /** A dry run (quoteSendTransaction without a gas limit) that throws, by its 1-based number. */
  dryRun?: (n: number) => Error | undefined;
  /** signTypedData failure by its 1-based number. */
  sign?: (n: number) => Error | undefined;
}

export interface Scenario {
  name: string;
  provider: ProviderSpec;
  account: AccountSpec;
  token?: "USDC" | "USDT";
  /** Review gate: a throw (the user cancelled) by review number; `false` = no reviewExecution configured. */
  review?: false | ((n: number) => Error | undefined);
  journal?: boolean;
}

export interface Run {
  log: unknown[][];
  summary: string[];
  sha256: string;
  result?: Record<string, unknown>;
  error?: unknown;
}

/** JSON with bigints written as `<digits>n`, and keys in insertion order. */
export const canonical = (value: unknown) => JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
const clone = (value: unknown) => JSON.parse(canonical(value)) as unknown;

function decodeSend(tx: {to?: string; data?: string}): string {
  const data = tx.data ?? "";
  if (data.startsWith("0x095ea7b3")) {
    const spender = `0x${data.slice(34, 74)}`;
    const amount = BigInt(`0x${data.slice(74, 138)}`);
    return amount === 0n ? `revoke ${name(spender)}` : `approve ${name(spender)} ${amount}`;
  }
  return `send ${name(tx.to)} ${data.slice(0, 10) || "-"}`;
}

const ORDER_DOMAIN_TYPE = [{name: "name", type: "string"}, {name: "version", type: "string"}, {name: "chainId", type: "uint256"}, {name: "verifyingContract", type: "address"}];
function gpv2Order(): string {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    domain: {name: "Gnosis Protocol", version: "v2", chainId: 1, verifyingContract: GPV2_SETTLEMENT},
    primaryType: "Order",
    types: {EIP712Domain: ORDER_DOMAIN_TYPE, Order: GPV2_ORDER_FIELDS},
    message: {
      sellToken: USDC_ETH, buyToken: WETH, receiver: SELF, sellAmount: AMOUNT.toString(), buyAmount: "400", validTo: now + 1200, appData: `0x${"11".repeat(32)}`,
      feeAmount: "0", kind: "sell", partiallyFillable: false, sellTokenBalance: "erc20", buyTokenBalance: "erc20",
    },
  });
}
function permit2Typed(): string {
  return JSON.stringify({
    domain: {name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS},
    types: {
      EIP712Domain: [{name: "name", type: "string"}, {name: "chainId", type: "uint256"}, {name: "verifyingContract", type: "address"}],
      PermitTransferFrom: [{name: "permitted", type: "TokenPermissions"}, {name: "spender", type: "address"}, {name: "nonce", type: "uint256"}, {name: "deadline", type: "uint256"}],
      TokenPermissions: [{name: "token", type: "address"}, {name: "amount", type: "uint256"}],
    },
    primaryType: "PermitTransferFrom",
    message: {permitted: {token: USDC_BASE.toLowerCase(), amount: AMOUNT.toString()}, spender: SETTLER, nonce: "2241959297937691820908574931991575", deadline: String(Math.floor(Date.now() / 1000) + 300)},
  });
}

/** The engine class to run: this package's `SingleProviderSwap2`, or another build's. */
export type EngineClass = abstract new (account: never, config: never) => {swap2(options: never, config?: never): Promise<unknown>};

export interface RunConfig {
  /** Engine config added to the scenario's. */
  engine?: Record<string, unknown>;
  /** `swap2()`'s second argument. */
  execution?: Record<string, unknown>;
}

export async function runScenario(Single: EngineClass, s: Scenario, cfg: RunConfig = {}): Promise<Run> {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime(START);
  try {
    return await execute(Single, s, cfg);
  } finally {
    vi.useRealTimers();
  }
}

async function execute(Single: EngineClass, s: Scenario, cfg: RunConfig): Promise<Run> {
  const log: unknown[][] = [];
  const summary: string[] = [];
  const note = (entry: unknown[], line: string) => { log.push(entry); summary.push(line); };
  const p = s.provider;
  const chain = p.kind === "permit2" ? "eip155:8453" : "eip155:1";
  const chainId = p.kind === "permit2" ? 8453 : 1;
  let quotes = 0;

  const txOf = (n: number): TxRequest | null => {
    const over = p.tx?.(n);
    if (over === null) return null;
    const base: TxRequest = p.kind === "permit2"
      ? {to: SETTLER, data: `0x1fff991f${"00".repeat(96)}`, value: "0", chainId, gasLimit: "400000", approvalAddress: PERMIT2_ADDRESS, permit2Transfer: permit2Typed()}
      : {to: ROUTER, data: "0xdeadbeef", value: "0", chainId, gasLimit: "210000", approvalAddress: ROUTER};
    return {...base, ...over};
  };
  const provider: CrossChainProvider = {
    name: "scn", enabled: () => true, supportsRoute: () => true, supportsSameChain: true,
    ...(p.ownGasEstimate ? {ownGasEstimate: true} : {}),
    getQuote: async (params: QuoteParams) => {
      const n = ++quotes;
      const {onRefusal: _r, ...shown} = params;
      note(["quote", n, clone(shown)], `quote #${n}`);
      const ttl = p.ttlMs?.(n) ?? (p.kind === "permit2" ? 30_000 : 60_000);
      const common = {provider: "scn", intentId: `i-${n}`, depositMemo: null, sourceAmount: params.amountIn, feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + ttl};
      if (p.kind === "gpv2") return {...common, depositAddress: "", destAmount: "410", minDestAmount: "400", ...p.quote?.(n)} as Quote;
      const tx = txOf(n);
      if (!tx) return null;
      const out = p.kind === "permit2" ? {destAmount: "400000000000000", minDestAmount: "396000000000000"} : {destAmount: "990000", minDestAmount: "980000"};
      return {...common, depositAddress: "", txRequest: tx, ...out, ...p.quote?.(n)} as Quote;
    },
    buildDeposit: async (q: Quote): Promise<UnsignedTx> => {
      if (p.kind === "gpv2") {
        return {chain, to: GPV2_SETTLEMENT, value: "0", chainId, approvalAddress: GPV2_VAULT_RELAYER, typedData: gpv2Order(), ...(p.approvalAmount ? {approvalAmount: p.approvalAmount} : {})};
      }
      const {to, value, nativeFee: _fee, ...rest} = q.txRequest!;
      return {chain, to: to!, value: value ?? "0", ...rest};
    },
    preflightDeposit: async () => {
      note(["preflight"], "preflight");
      const e = p.preflight?.();
      if (e) throw e;
    },
    registerSignedOrder: async (intentId: string, signature: string) => {
      note(["register", intentId, signature], "register");
      const e = p.register?.();
      if (e) throw e;
    },
    trackIntent: async () => ({state: "pending"}),
  };

  let sends = 0;
  let dryRuns = 0;
  let signs = 0;
  const a = s.account;
  const account: Record<string, unknown> = {
    getAddress: async () => SELF,
    getChainId: async () => chainId,
    sendTransaction: async (tx: {to?: string; data?: string; value?: bigint; gasLimit?: bigint; chainId?: number}) => {
      const index = sends++;
      const kind = decodeSend(tx);
      note(["send", clone(tx)], kind);
      const e = a.failSend?.(kind.startsWith("send") ? "deposit" : kind.startsWith("revoke") ? "revoke" : `approve ${kind.split(" ").at(-1)}`, index);
      if (e) throw e;
      return {hash: `0x${String(index + 1).padStart(64, "0")}`};
    },
    waitForTransaction: async (hash: string) => {
      note(["wait", hash], "wait");
      if (a.mineMs) vi.setSystemTime(Date.now() + a.mineMs);
    },
    signTypedData: async (args: {primaryType?: string}) => {
      const n = ++signs;
      note(["sign", clone(args)], `sign ${args.primaryType}`);
      const e = a.sign?.(n);
      if (e) throw e;
      return `0x${"cd".repeat(65)}`;
    },
  };
  if (a.allowance !== undefined) {
    const allowance = a.allowance;
    account.getAllowance = async (token: string, spender: string) => {
      note(["allowance", token, spender], `allowance ${name(spender)}`);
      if (allowance === "throws") throw new Error("rpc down");
      return allowance;
    };
  }
  if (a.gas) {
    account.getBalance = async () => { note(["balance"], "balance"); return 10n ** 30n; };
    account.quoteSendTransaction = async (tx: {to?: string; data?: string; gasLimit?: bigint}) => {
      const dry = tx.gasLimit === undefined;
      note(["estimate", clone(tx)], `estimate ${decodeSend(tx)}${dry ? "" : " +gas"}`);
      if (dry && !(tx.data ?? "").startsWith("0x095ea7b3")) {
        const e = a.dryRun?.(++dryRuns);
        if (e) throw e;
      }
      return {fee: 1n};
    };
  }

  let reviews = 0;
  const engine: Record<string, unknown> = {
    fromChain: chain,
    onExecutionPhase: (phase: string, detail?: unknown) => note(["phase", phase, clone(detail ?? null)], `phase ${phase}`),
    ...(s.review === false ? {} : {reviewExecution: (plan: unknown) => {
      const n = ++reviews;
      const shown = plan as {approvals: {amount: bigint}[]; reusedAllowance?: {amount: bigint}; requoted?: true};
      note(["review", clone(plan)], `review approvals=[${shown.approvals.map((x) => x.amount).join(",")}]${shown.reusedAllowance ? ` reused=${shown.reusedAllowance.amount}` : ""}${shown.requoted ? " requoted" : ""}`);
      const e = typeof s.review === "function" ? s.review(n) : undefined;
      if (e) throw e;
    }}),
    ...cfg.engine,
  };
  if (s.journal) {
    const records = new Map<string, Swap2Operation>();
    const store: Swap2OperationStore = {
      load: async (id) => records.get(id) ?? null,
      compareAndSet: async (id, expected, next) => {
        const current = records.get(id);
        if ((current?.revision ?? null) !== expected) return false;
        records.set(id, next);
        const last = next.steps.at(-1);
        note(["journal", next.phase, clone(next.steps)], `journal ${next.phase}${last ? ` ${last.kind}:${last.state}` : ""}`);
        return true;
      },
    };
    engine.operationStore = store;
  }

  class P extends (Single as unknown as abstract new (account: unknown, config: unknown) => {swap2(o: unknown, c?: unknown): Promise<unknown>}) {
    protected readonly provider = provider;
    protected chainSupported(): boolean { return true; }
  }
  const options = p.kind === "permit2"
    ? {fromToken: "USDC", toToken: "0x0000000000000000000000000000000000000000", toChain: 8453, recipient: SELF, fromTokenAmount: AMOUNT, minAmountOut: 396_000_000_000_000n}
    : p.kind === "gpv2"
      ? {fromToken: "USDC", toToken: WETH, toChain: 1, recipient: SELF, fromTokenAmount: AMOUNT, minAmountOut: 400n}
      : {fromToken: s.token ?? "USDC", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161, recipient: SELF, fromTokenAmount: AMOUNT, minAmountOut: 980_000n};
  const run: Run = {log, summary, sha256: ""};
  try {
    const result = await new P(account, engine).swap2({...options, ...(s.journal ? {operationId: "op-1"} : {})}, cfg.execution);
    run.result = result as Record<string, unknown>;
    note(["result", clone(result)], "ok");
  } catch (error) {
    run.error = error;
    const e = error as {name?: unknown; message?: unknown; code?: unknown; reason?: unknown; hash?: unknown; id?: unknown; maybeSent?: unknown};
    note(["error", clone({name: e.name, message: e.message, code: e.code, reason: e.reason, hash: e.hash, id: e.id, maybeSent: e.maybeSent})], `error ${String(e.name)}: ${String(e.message)}`);
  }
  run.sha256 = createHash("sha256").update(canonical(log)).digest("hex");
  return run;
}

const fail = (message: string) => () => new Error(message);
const once = (message: string) => (n: number) => (n === 1 ? new Error(message) : undefined);
const reverted = () => Object.assign(new Error("execution reverted: TooMuchSlippage"), {code: 3});

/**
 * The matrix the 0.17.0 comparison runs: every approval decision (no reader, a zero / equal / larger / smaller / stale
 * allowance, mainnet USDT), every place a swap stops after an approval (preflight, deposit, a lost approval answer,
 * the second review, the re-quote that finds no route or another spender, a dry run), Permit2 signature transfers,
 * CoW orders and a journaled execution.
 */
export const SCENARIOS: readonly Scenario[] = Object.freeze([
  {name: "usdc no allowance reader: approve, deposit", provider: {kind: "call"}, account: {}},
  {name: "usdc allowance read fails: approve, deposit", provider: {kind: "call"}, account: {allowance: "throws"}},
  {name: "usdc zero allowance: approve, deposit", provider: {kind: "call"}, account: {allowance: 0n, gas: true}},
  {name: "usdc equal allowance: deposit only", provider: {kind: "call"}, account: {allowance: AMOUNT, gas: true}},
  {name: "usdc larger allowance: overwritten, deposit", provider: {kind: "call"}, account: {allowance: 500_000_000n, gas: true}},
  {name: "usdc smaller allowance: overwritten, deposit", provider: {kind: "call"}, account: {allowance: 400_000n}},
  {name: "usdt stale allowance: reset, approve, deposit", token: "USDT", provider: {kind: "call"}, account: {allowance: 5n}},
  {name: "usdt larger allowance: reset, approve, deposit", token: "USDT", provider: {kind: "call"}, account: {allowance: 500_000_000n}},
  {name: "usdt zero allowance: one approve", token: "USDT", provider: {kind: "call"}, account: {allowance: 0n}},
  {name: "usdt no reader: reset, approve", token: "USDT", provider: {kind: "call"}, account: {}},
  {name: "usdc larger allowance, deposit fails: revoked", provider: {kind: "call"}, account: {allowance: 500_000_000n, failSend: (k) => (k === "deposit" ? new Error("network dropped") : undefined)}},
  {name: "usdt larger allowance, deposit fails: revoked", token: "USDT", provider: {kind: "call"}, account: {allowance: 500_000_000n, failSend: (k) => (k === "deposit" ? new Error("network dropped") : undefined)}},
  {name: "usdc zero allowance, preflight fails: revoked", provider: {kind: "call", preflight: fail("halted")}, account: {allowance: 0n}},
  {name: "usdc equal allowance, preflight fails: left alone", provider: {kind: "call", preflight: fail("halted")}, account: {allowance: AMOUNT}},
  {name: "usdc smaller allowance, preflight fails: revoked to 0", provider: {kind: "call", preflight: fail("halted")}, account: {allowance: 400_000n}},
  {name: "usdc zero allowance, approval rejected", provider: {kind: "call"}, account: {allowance: 0n, failSend: (k, i) => (k.startsWith("approve") && i === 0 ? new Error("user rejected the request") : undefined)}},
  {name: "usdc zero allowance, approval answer lost", provider: {kind: "call"}, account: {allowance: 0n, failSend: (k, i) => (k.startsWith("approve") && i === 0 ? new TypeError("fetch failed") : undefined)}},
  {name: "first review cancelled: nothing sent", provider: {kind: "call"}, account: {allowance: 0n}, review: once("user cancelled")},
  {name: "quote expires while the approval mines: re-quote, deposit", provider: {kind: "call", ttlMs: (n) => (n === 1 ? 40 : 60_000)}, account: {allowance: 0n, mineMs: 100}},
  {name: "re-quote reviewed again and cancelled: revoked", provider: {kind: "call", ttlMs: (n) => (n === 1 ? 40 : 60_000), tx: (n) => (n === 2 ? {data: "0xbadc0de5"} : {})}, account: {allowance: 0n, mineMs: 100}, review: (n) => (n === 2 ? new Error("user cancelled") : undefined)},
  {name: "re-quote finds no route: revoked", provider: {kind: "call", ttlMs: (n) => (n === 1 ? 40 : 60_000), tx: (n) => (n === 2 ? null : {})}, account: {allowance: 0n, mineMs: 100}},
  {name: "re-quote moves the spender: revoked", provider: {kind: "call", ttlMs: (n) => (n === 1 ? 40 : 60_000), tx: (n) => (n === 2 ? {approvalAddress: OTHER} : {})}, account: {allowance: 0n, mineMs: 100}},
  {name: "dry run reverts once after the approval: re-quote, deposit", provider: {kind: "call", ownGasEstimate: true}, account: {allowance: 0n, gas: true, dryRun: once("reverted")}},
  {name: "dry run reverts twice: revoked", provider: {kind: "call", ownGasEstimate: true}, account: {allowance: 0n, gas: true, dryRun: () => reverted()}},
  {name: "permit2 zero allowance: approve, sign, send", provider: {kind: "permit2"}, account: {allowance: 0n, gas: true}},
  {name: "permit2 covering allowance: sign, send", provider: {kind: "permit2"}, account: {allowance: 500_000_000n, gas: true}},
  {name: "permit2 smaller allowance, signature declined: left", provider: {kind: "permit2"}, account: {allowance: 400_000n, gas: true, sign: once("user rejected the signature")}},
  {name: "permit2 zero allowance, signed call reverts twice: left", provider: {kind: "permit2"}, account: {allowance: 0n, gas: true, dryRun: () => reverted()}},
  {name: "cow zero allowance: approve, sign, register", provider: {kind: "gpv2"}, account: {allowance: 0n}},
  {name: "cow sufficient target: sign, register", provider: {kind: "gpv2", approvalAmount: "3000000"}, account: {allowance: 5_000_000n}},
  {name: "cow partial allowance, register fails: restored", provider: {kind: "gpv2", approvalAmount: "3000000", register: fail("orderbook down")}, account: {allowance: 500_000n}},
  {name: "journaled: approve, deposit fails, revoked", provider: {kind: "call"}, account: {allowance: 0n, failSend: (k) => (k === "deposit" ? new Error("insufficient funds for gas") : undefined)}, journal: true},
  {name: "journaled: equal allowance, deposit", provider: {kind: "call"}, account: {allowance: AMOUNT}, journal: true},
] satisfies Scenario[]);

export const scenario = (name: string): Scenario => {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario '${name}'`);
  return s;
};
