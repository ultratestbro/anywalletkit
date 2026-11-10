/**
 * One deposit per order: the ids already cleared, for the whole JS realm — every provider instance and every remote
 * stub share it, so a second instance cannot be handed the order the first one already signed for.
 */
import {RELAY_CLOCK_SKEW_S, RELAY_MAX_ORDER_AGE_S} from "./config.js";
import {RelayRefusal} from "./order.js";

// Order ids already cleared, per stage, for the whole JS realm (every provider instance and every remote stub): the
// same order is never built or signed for twice while it could still pass the age check. An entry outlives the
// order's own acceptance window (age + skew), after which the order is stale anyway.
const CLEARED_TTL_MS = (RELAY_MAX_ORDER_AGE_S + 2 * RELAY_CLOCK_SKEW_S) * 1000;
const CLEARED_MAX = 4096;
const clearedOrders = new Map<string, number>();

/**
 * Record that `id` is being used at `stage` ("build" on the client of a remote provider, "sign" right before a
 * signature); throws `order-reused` when it already was. Fail-closed when the record is full of live entries.
 */
export function relayClearOrder(id: string, stage: "build" | "sign", nowMs: number = Date.now()): void {
  const key = `${stage}:${id.toLowerCase()}`;
  const until = clearedOrders.get(key);
  if (until !== undefined && until > nowMs) throw new RelayRefusal("order-reused", `order ${id} was already cleared for a deposit — quote again`);
  if (clearedOrders.size >= CLEARED_MAX) {
    for (const [k, t] of clearedOrders) if (t <= nowMs) clearedOrders.delete(k);
    if (clearedOrders.size >= CLEARED_MAX) throw new RelayRefusal("order-reused", "too many deposits cleared in the last minutes — try again later");
  }
  clearedOrders.set(key, nowMs + CLEARED_TTL_MS);
}

/** Tests only; the package index leaves it out. */
export function forgetClearedOrders(): void {
  clearedOrders.clear();
}
