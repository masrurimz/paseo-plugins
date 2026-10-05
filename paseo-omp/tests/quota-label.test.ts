import { describe, expect, test } from "vitest";
import { historicalQuotaPillLabel, quotaSummaryForProvider } from "../client/quota-state";
import type { OmpQuota } from "../shared/quota";

const quota: OmpQuota = {
  provider: "anthropic",
  label: "Claude 5 Hour",
  windowLabel: "5 Hour",
  usedFraction: 0.25,
  status: "ok",
  resetsAt: null,
  recordedAt: 1,
};

describe("historical quota pill label", () => {
  test("appends the historical suffix to an existing summary", () => {
    const summary = quotaSummaryForProvider([quota], "anthropic");
    expect(summary).toEqual({ visible: true, label: "Anthropic · 25%" });
    expect(historicalQuotaPillLabel(summary)).toEqual({
      visible: true,
      label: "Anthropic · 25% (historical)",
    });
  });

  test("preserves the visible flag and the unknown-value label", () => {
    expect(historicalQuotaPillLabel(quotaSummaryForProvider([quota], "azure"))).toEqual({
      visible: true,
      label: "Azure · — (historical)",
    });
    expect(historicalQuotaPillLabel(quotaSummaryForProvider([quota], null))).toEqual({
      visible: false,
      label: "Quotas · — (historical)",
    });
  });

  test("is idempotent so repeated wrapping never stacks suffixes", () => {
    const once = historicalQuotaPillLabel(quotaSummaryForProvider([quota], "anthropic"));
    expect(historicalQuotaPillLabel(once)).toEqual(once);
  });
});
