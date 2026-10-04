/** Explicit freshness machine for composer pills (QW3): pure transitions, label derivation, subscription store. */

export type PillFreshnessState = "fresh" | "stale" | "error";

export interface PillFreshness {
  state: PillFreshnessState;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
}

export type FreshnessEvent =
  | { type: "poll:start" }
  | { type: "poll:success"; at: number }
  | { type: "poll:error"; at: number }
  | { type: "retry" };

export const INITIAL_PILL_FRESHNESS: Readonly<PillFreshness> = Object.freeze({
  state: "fresh",
  lastSuccessAt: null,
  consecutiveFailures: 0,
});

/** A pill is stale after 3x its poll interval without a success (computed at render). */
export const STALE_AFTER_POLLS = 3;

export type PillKind = "hub" | "quota";

/**
 * The single definition of the pill poll intervals. `index.client.tsx` imports this for its
 * timers, so staleness windows cannot drift from the polls. The 15s settings read has no pill
 * and stays local to its owner.
 */
export const PILL_POLL_MS: Record<PillKind, number> = {
  hub: 4_000,
  quota: 30_000,
};

/**
 * Pure transition. `poll:start` and `retry` never clear failure state on their
 * own — the outcome (`poll:success` / `poll:error`) drives the next state, so
 * the last-known label is always retained and only annotated.
 */
export function transition(freshness: PillFreshness, event: FreshnessEvent): PillFreshness {
  switch (event.type) {
    case "poll:start":
    case "retry":
      return freshness;
    case "poll:success":
      return { state: "fresh", lastSuccessAt: event.at, consecutiveFailures: 0 };
    case "poll:error":
      return {
        state: "error",
        lastSuccessAt: freshness.lastSuccessAt,
        consecutiveFailures: freshness.consecutiveFailures + 1,
      };
  }
}

/**
 * True when `now - lastSuccessAt` exceeds 3x the poll interval. Never true
 * before the first success: a never-refreshed pill reports through `error`
 * instead of going stale on mount.
 */
export function isStale(
  freshness: PillFreshness,
  pollMs: number,
  now: number = Date.now(),
): boolean {
  if (freshness.lastSuccessAt === null) return false;
  return now - freshness.lastSuccessAt > STALE_AFTER_POLLS * pollMs;
}

export interface PillLabel {
  visible: boolean;
  label: string;
}

export const STALE_SUFFIX = " · stale";
export const ERROR_SUFFIX = " · !";

/**
 * Annotates the last-known pill label — never clears it. Error takes precedence
 * over stale; hidden pills keep their visibility flag untouched.
 */
export function pillLabelFor(
  kind: PillKind,
  base: PillLabel,
  freshness: PillFreshness,
  now: number = Date.now(),
): PillLabel {
  if (freshness.state === "error") {
    return { visible: base.visible, label: `${base.label}${ERROR_SUFFIX}` };
  }
  if (isStale(freshness, PILL_POLL_MS[kind], now)) {
    return { visible: base.visible, label: `${base.label}${STALE_SUFFIX}` };
  }
  return base;
}

export interface FreshnessNotice {
  text: string;
  tone: "warning" | "danger";
}

/** Popover banner copy; null while fresh. Derived only from the machine. */
export function freshnessNotice(
  freshness: PillFreshness,
  kind: PillKind,
  now: number = Date.now(),
): FreshnessNotice | null {
  if (freshness.state === "error") {
    const { consecutiveFailures } = freshness;
    return {
      text: `Could not refresh (${consecutiveFailures} ${
        consecutiveFailures === 1 ? "failure" : "failures"
      }). Showing last known state.`,
      tone: "danger",
    };
  }
  if (isStale(freshness, PILL_POLL_MS[kind], now)) {
    return {
      text: `No successful refresh for over ${
        (STALE_AFTER_POLLS * PILL_POLL_MS[kind]) / 1_000
      }s. Showing last known state.`,
      tone: "warning",
    };
  }
  return null;
}

export function freshnessKey(agentId: string, kind: PillKind): string {
  return `${agentId}:${kind}`;
}

/** Minimal per-key subscription store so popovers re-render without any polling of their own. */
export interface FreshnessStore {
  get(key: string): PillFreshness;
  set(key: string, next: PillFreshness): void;
  remove(key: string): void;
  /** True once a poll outcome was recorded; a never-polled pill has nothing to annotate. */
  has(key: string): boolean;
  subscribe(key: string, listener: () => void): () => void;
}

export function createFreshnessStore(): FreshnessStore {
  const records = new Map<string, PillFreshness>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get(key) {
      return records.get(key) ?? INITIAL_PILL_FRESHNESS;
    },
    set(key, next) {
      records.set(key, next);
      for (const listener of listeners.get(key) ?? []) listener();
    },
    remove(key) {
      records.delete(key);
    },
    has(key) {
      return records.has(key);
    },
    subscribe(key, listener) {
      const keyed = listeners.get(key) ?? new Set<() => void>();
      keyed.add(listener);
      listeners.set(key, keyed);
      return () => {
        keyed.delete(listener);
        if (keyed.size === 0) listeners.delete(key);
      };
    },
  };
}
