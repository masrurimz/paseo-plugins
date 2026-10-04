import { describe, expect, test } from "vitest";
import { classifySettingImpact, deriveRestartRequired } from "../shared/restart-required";

describe("OMP setting impact classification", () => {
  test("classifies model and thinking as live", () => {
    expect(classifySettingImpact("model")).toBe("live");
    expect(classifySettingImpact("thinking")).toBe("live");
    expect(classifySettingImpact("defaultThinkingLevel")).toBe("restart");
  });

  test("classifies approval mode as new-session only", () => {
    expect(classifySettingImpact("mode")).toBe("new-sessions");
    expect(classifySettingImpact("tools.approvalMode")).toBe("new-sessions");
    expect(classifySettingImpact("approval-mode")).toBe("new-sessions");
  });

  test("defaults every other setting to restart", () => {
    expect(classifySettingImpact("theme.name")).toBe("restart");
    expect(classifySettingImpact("modelRoles")).toBe("restart");
    expect(classifySettingImpact("retry.fallbackChains")).toBe("restart");
    expect(classifySettingImpact("tools.mcp.enabled")).toBe("restart");
  });
});

describe("restart-required derivation", () => {
  test("reports no restart when every draft is live", () => {
    expect(deriveRestartRequired(["model", "thinking"])).toEqual({
      requiresRestart: false,
      reason: null,
      affectedPaths: [],
    });
  });

  test("reports no restart for an empty draft set", () => {
    expect(deriveRestartRequired([])).toEqual({
      requiresRestart: false,
      reason: null,
      affectedPaths: [],
    });
  });

  test("reports approval-mode reason and drops live paths", () => {
    expect(deriveRestartRequired(["model", "mode"])).toEqual({
      requiresRestart: true,
      reason: "approval-mode",
      affectedPaths: ["mode"],
    });
  });

  test("reports settings reason for launch-read settings", () => {
    expect(deriveRestartRequired(["theme.name", "modelRoles"])).toEqual({
      requiresRestart: true,
      reason: "settings-live-reject",
      affectedPaths: ["theme.name", "modelRoles"],
    });
  });

  test("reports both when approval and settings drafts mix, deduplicated in order", () => {
    expect(
      deriveRestartRequired(["mode", "theme.name", "mode", "model", "tools.approvalMode"]),
    ).toEqual({
      requiresRestart: true,
      reason: "both",
      affectedPaths: ["mode", "theme.name", "tools.approvalMode"],
    });
  });
});
