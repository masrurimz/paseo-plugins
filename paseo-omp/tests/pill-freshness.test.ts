import { describe, expect, test } from "vitest";
import {
  createFreshnessStore,
  freshnessKey,
  freshnessNotice,
  INITIAL_PILL_FRESHNESS,
  isStale,
  PILL_POLL_MS,
  type PillFreshness,
  pillLabelFor,
  STALE_AFTER_POLLS,
  transition,
} from "../client/pill-freshness";

const base: PillFreshness = { state: "fresh", lastSuccessAt: 1_000, consecutiveFailures: 0 };

describe("pill freshness transitions", () => {
  test("a success resets failures and stamps the clock", () => {
    const failed = transition(base, { type: "poll:error", at: 5_000 });
    expect(failed).toEqual({ state: "error", lastSuccessAt: 1_000, consecutiveFailures: 1 });
    expect(transition(failed, { type: "poll:success", at: 6_000 })).toEqual({
      state: "fresh",
      lastSuccessAt: 6_000,
      consecutiveFailures: 0,
    });
  });

  test("failures accumulate and retain the last success", () => {
    let state = base;
    for (const at of [2_000, 3_000, 4_000]) {
      state = transition(state, { type: "poll:error", at });
    }
    expect(state).toEqual({ state: "error", lastSuccessAt: 1_000, consecutiveFailures: 3 });
  });

  test("start and retry never clear an error on their own", () => {
    const failed = transition(base, { type: "poll:error", at: 5_000 });
    expect(transition(failed, { type: "poll:start" })).toBe(failed);
    expect(transition(failed, { type: "retry" })).toBe(failed);
    expect(transition(INITIAL_PILL_FRESHNESS, { type: "retry" })).toBe(INITIAL_PILL_FRESHNESS);
  });

  test("staleness is three poll intervals after the last success", () => {
    const hub = PILL_POLL_MS.hub;
    expect(STALE_AFTER_POLLS).toBe(3);
    expect(isStale(base, hub, 1_000 + 3 * hub)).toBe(false);
    expect(isStale(base, hub, 1_000 + 3 * hub + 1)).toBe(true);
    expect(isStale({ ...base, lastSuccessAt: null }, hub, 10_000_000)).toBe(false);
  });
});

describe("pill labels", () => {
  test("annotates the last-known label without clearing it", () => {
    const label = { visible: true, label: "Hub · 2" };
    const fresh = { state: "fresh" as const, lastSuccessAt: 10_000, consecutiveFailures: 0 };
    expect(pillLabelFor("hub", label, fresh, 10_000)).toEqual(label);
    expect(
      pillLabelFor("hub", label, transition(fresh, { type: "poll:error", at: 1 }), 10_000),
    ).toEqual({ visible: true, label: "Hub · 2 · !" });
    expect(isStale(fresh, PILL_POLL_MS.hub, 10_000 + 3 * PILL_POLL_MS.hub + 1)).toBe(true);
  });

  test("stale annotates a hidden pill without making it visible", () => {
    const hidden = { visible: false, label: "Quota" };
    const stale = {
      state: "fresh" as const,
      lastSuccessAt: 0,
      consecutiveFailures: 0,
    };
    expect(pillLabelFor("quota", hidden, stale, 3 * PILL_POLL_MS.quota + 1)).toEqual({
      visible: false,
      label: "Quota · stale",
    });
  });

  test("error takes precedence over stale", () => {
    const label = { visible: true, label: "Hub · 1" };
    const errored = { state: "error" as const, lastSuccessAt: 0, consecutiveFailures: 2 };
    expect(pillLabelFor("hub", label, errored, 999_999)).toEqual({
      visible: true,
      label: "Hub · 1 · !",
    });
  });

  test("quota uses its own interval for staleness", () => {
    const label = { visible: true, label: "Quotas · 50%" };
    const fresh = { state: "fresh" as const, lastSuccessAt: 0, consecutiveFailures: 0 };
    const now = 3 * PILL_POLL_MS.hub + 1;
    expect(pillLabelFor("hub", label, fresh, now).label).toBe("Quotas · 50% · stale");
    expect(pillLabelFor("quota", label, fresh, now).label).toBe("Quotas · 50%");
  });
});

describe("freshness notices", () => {
  test("renders nothing while fresh and names the failure count", () => {
    const fresh = { state: "fresh" as const, lastSuccessAt: 1, consecutiveFailures: 0 };
    expect(freshnessNotice(fresh, "hub", 2)).toBeNull();
    const once = transition(fresh, { type: "poll:error", at: 2 });
    expect(freshnessNotice(once, "hub", 2)).toEqual({
      text: "Could not refresh (1 failure). Showing last known state.",
      tone: "danger",
    });
    const twice = transition(once, { type: "poll:error", at: 3 });
    expect(freshnessNotice(twice, "hub", 3)?.text).toBe(
      "Could not refresh (2 failures). Showing last known state.",
    );
  });

  test("stale notice names the derived window, never a hardcoded constant", () => {
    const fresh = { state: "fresh" as const, lastSuccessAt: 0, consecutiveFailures: 0 };
    const now = 3 * PILL_POLL_MS.quota + 1;
    expect(freshnessNotice(fresh, "quota", now)).toEqual({
      text: "No successful refresh for over 90s. Showing last known state.",
      tone: "warning",
    });
  });
});

describe("freshness store", () => {
  test("defaults to fresh, notifies only its own key, and forgets on removal", () => {
    const store = createFreshnessStore();
    expect(store.get("a:hub")).toBe(INITIAL_PILL_FRESHNESS);
    expect(store.has("a:hub")).toBe(false);
    let notified = 0;
    const unsubscribe = store.subscribe("a:hub", () => {
      notified += 1;
    });
    const next = transition(INITIAL_PILL_FRESHNESS, { type: "poll:success", at: 7 });
    store.set("a:hub", next);
    store.set("a:quota", next);
    expect(notified).toBe(1);
    expect(store.get("a:hub")).toBe(next);
    expect(store.has("a:hub")).toBe(true);
    unsubscribe();
    store.set("a:hub", INITIAL_PILL_FRESHNESS);
    expect(notified).toBe(1);
    store.remove("a:hub");
    expect(store.get("a:hub")).toBe(INITIAL_PILL_FRESHNESS);
    expect(store.has("a:hub")).toBe(false);
    expect(freshnessKey("a", "hub")).toBe("a:hub");
  });
});
