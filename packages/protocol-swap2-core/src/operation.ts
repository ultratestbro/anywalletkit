import {Swap2ExecutionError, Swap2MaybeSentError} from "./errors.js";

export type Swap2OperationPhase = "prepared" | "running" | "submitted" | "unknown" | "failed";
export type Swap2OperationStepKind = "approval" | "revoke" | "order-sign" | "order-register" | "source" | "recovery";
export interface Swap2OperationStep {
  readonly index: number;
  readonly kind: Swap2OperationStepKind;
  readonly chain: string;
  readonly state: "pending" | "submitted" | "rejected" | "unknown";
  readonly hash?: string;
  /** Provider-scoped recovery identity, when this step is a recovery action. */
  readonly actionId?: string;
}

/** JSON-safe journal. No seed, private key, signed transaction or order signature belongs here. */
export interface Swap2Operation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly phase: Swap2OperationPhase;
  readonly provider: string;
  readonly routeId?: string;
  readonly intentId: string;
  readonly sourceChain: string;
  readonly sender: string;
  /** Immutable caller terms, amounts in decimal base units. */
  readonly request: Readonly<Record<string, string>>;
  readonly steps: readonly Swap2OperationStep[];
}

/**
 * Application-owned storage. compareAndSet MUST be an atomic, durable transaction
 * across all tabs/processes: null means create only if absent, otherwise match the
 * exact current revision. Return true only after persistence has committed.
 */
export interface Swap2OperationStore {
  load(id: string): Promise<Swap2Operation | null>;
  compareAndSet(id: string, expectedRevision: number | null, next: Swap2Operation): Promise<boolean>;
}

export class Swap2OperationError extends Swap2ExecutionError {
  /** This failure concerns persistence before a wallet side effect, not a lost broadcast answer. */
  readonly answered = true;
  constructor(message: string, readonly operationId: string, options?: ErrorOptions) { super(message, options); }
}

const phases = new Set(["prepared", "running", "submitted", "unknown", "failed"]);
const kinds = new Set(["approval", "revoke", "order-sign", "order-register", "source", "recovery"]);
const states = new Set(["pending", "submitted", "rejected", "unknown"]);
const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Reject corrupt/unversioned records before dispatching any provider method. */
export function validateOperation(record: Swap2Operation, id: string): void {
  const r = record;
  if (!r || r.schemaVersion !== 1 || r.id !== id || !text(id, 200) || !integer(r.revision) || !integer(r.createdAt) || !integer(r.updatedAt) || r.updatedAt < r.createdAt || !phases.has(r.phase) || !text(r.provider, 40) || !/^[A-Za-z0-9_-]+$/.test(r.provider) || !text(r.intentId, 4096) || !text(r.sourceChain, 64) || !text(r.sender, 200) || (r.routeId !== undefined && !text(r.routeId, 256))) {
    throw new Swap2OperationError("swap2: malformed operation record", id);
  }
  if (!r.request || typeof r.request !== "object" || Array.isArray(r.request) || Object.keys(r.request).length > 32 || Object.entries(r.request).some(([key, value]) => !text(key, 80) || typeof value !== "string" || value.length > 4096)) {
    throw new Swap2OperationError("swap2: malformed operation request", id);
  }
  if (!Array.isArray(r.steps) || r.steps.length > 128 || Array.from(r.steps).some((s, i) => !s || s.index !== i || !kinds.has(s.kind) || !text(s.chain, 64) || !states.has(s.state) || (s.hash !== undefined && !text(s.hash, 256)) || (s.actionId !== undefined && !text(s.actionId, 256)))) {
    throw new Swap2OperationError("swap2: malformed operation steps", id);
  }
}

function copy(record: Swap2Operation): Swap2Operation {
  return Object.freeze({...record, request: Object.freeze({...record.request}), steps: Object.freeze(record.steps.map((s) => Object.freeze({...s})))});
}

export async function loadSwap2Operation(store: Swap2OperationStore, id: string): Promise<Swap2Operation | null> {
  const record = await store.load(id);
  if (!record) return null;
  validateOperation(record, id);
  return copy(record);
}

/** Single execution's journal; a reopened record is for reconciliation, never automatic re-send. */
export class Swap2OperationJournal {
  private constructor(private readonly store: Swap2OperationStore, private record: Swap2Operation) {}

  static async create(store: Swap2OperationStore, input: Omit<Swap2Operation, "schemaVersion" | "revision" | "createdAt" | "updatedAt" | "phase" | "steps">): Promise<Swap2OperationJournal> {
    const now = Date.now();
    const record = copy({...input, schemaVersion: 1, revision: 0, createdAt: now, updatedAt: now, phase: "prepared", steps: []});
    validateOperation(record, input.id);
    const journal = new Swap2OperationJournal(store, record);
    try {
      if (!await store.compareAndSet(record.id, null, copy(record))) throw new Swap2OperationError("swap2: operation already exists — reconcile it; do not repeat the transfer", record.id);
    } catch (error) {
      if (error instanceof Swap2OperationError) throw error;
      throw new Swap2OperationError("swap2: operation storage failed before execution", record.id, {cause: error});
    }
    return journal;
  }

  get snapshot(): Swap2Operation { return copy(this.record); }

  private async save(next: Swap2Operation): Promise<void> {
    const updated = copy({...next, revision: this.record.revision + 1, updatedAt: Math.max(Date.now(), this.record.updatedAt)});
    validateOperation(updated, this.record.id);
    try {
      if (!await this.store.compareAndSet(updated.id, this.record.revision, copy(updated))) throw new Error("revision conflict");
    } catch (error) {
      throw new Swap2OperationError("swap2: operation storage failed; reconcile before continuing", updated.id, {cause: error});
    }
    this.record = updated;
  }

  /** A re-quote may change the provider's tracking id, but never the caller's pinned terms. */
  async requote(intentId: string): Promise<void> {
    if (this.record.phase === "unknown" || this.record.steps.some((s) => s.state === "pending" || s.state === "unknown" || s.kind === "source" || s.kind === "order-register")) throw new Swap2OperationError("swap2: cannot requote a possibly submitted operation", this.record.id);
    await this.save({...this.record, intentId});
  }

  /** Write-ahead marker, then exactly one side effect, then its outcome. */
  async effect<T>(
    kind: Swap2OperationStepKind, chain: string, run: () => Promise<T>,
    options: {hash?: (result: T) => string | undefined; ambiguous: (error: unknown) => {hash?: string} | null; actionId?: string},
  ): Promise<T> {
    if (this.record.phase === "unknown" || this.record.steps.some((s) => s.state === "pending" || s.state === "unknown") || this.record.steps.some((s) => s.state === "submitted" && (s.kind === "source" || s.kind === "order-register" || s.kind === "recovery"))) {
      throw new Swap2OperationError("swap2: operation may already be submitted — reconcile instead of sending again", this.record.id);
    }
    const step: Swap2OperationStep = {index: this.record.steps.length, kind, chain, state: "pending", ...(options.actionId !== undefined ? {actionId: options.actionId} : {})};
    await this.save({...this.record, phase: "running", steps: [...this.record.steps, step]});
    let result: T;
    try { result = await run(); } catch (error) {
      const unknown = options.ambiguous(error);
      await this.save({...this.record, phase: unknown ? "unknown" : "failed", steps: [...this.record.steps.slice(0, -1), {...step, state: unknown ? "unknown" : "rejected", ...(unknown?.hash ? {hash: unknown.hash} : {})}]}).catch(() => {});
      if (unknown) throw new Swap2MaybeSentError(`swap2: ${kind} outcome is unknown for operation '${this.record.id}' — reconcile; do not repeat`, unknown.hash, undefined, {cause: error});
      throw error;
    }
    const hash = options.hash?.(result);
    const terminal = kind === "source" || kind === "order-register" || kind === "recovery";
    try {
      await this.save({...this.record, phase: terminal ? "submitted" : "running", steps: [...this.record.steps.slice(0, -1), {...step, state: "submitted", ...(hash ? {hash} : {})}]});
    } catch (error) {
      // The write-ahead pending record remains: after a crash, no caller may infer that nothing happened.
      throw new Swap2MaybeSentError(`swap2: ${kind} may have completed, but operation '${this.record.id}' could not be saved — do not repeat it`, hash, undefined, {cause: error});
    }
    return result;
  }
}
