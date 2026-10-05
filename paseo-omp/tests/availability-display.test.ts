import { describe, expect, test } from "vitest";
import {
  AVAILABILITY_COPY,
  classifyAvailability,
  toAvailabilityDisplay,
} from "../shared/availability-display";
import type { OmpProviderHealth } from "../shared/provider-diagnostics";

function health(overrides: Partial<OmpProviderHealth> = {}): OmpProviderHealth {
  return {
    binary: {
      installed: true,
      resolvedPath: "~/bin/omp",
      version: { major: 18, minor: 6, patch: 0, prerelease: null },
      versionStatus: "ok",
      processCleanupFailed: false,
    },
    rpcUi: { checked: true, supported: true },
    lsp: { status: "supported" },
    mcp: { status: "unavailable", serverCount: null, reason: null },
    process: { status: "ok", trackedCount: null },
    roots: {
      agentRoot: "~/.omp/agent",
      agentRootState: "available",
      configPath: "~/.omp/agent/config.yml",
      configState: "available",
      sessionRoot: "~/.omp/agent/sessions",
      sessionRootState: "available",
    },
    databases: { agentDbState: "available", historyDbState: "available" },
    memoryBackend: null,
    checkedAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("availability classification", () => {
  test("available only when installed, runnable, and rpc-ui is advertised", () => {
    expect(classifyAvailability(health())).toBe("available");
    expect(toAvailabilityDisplay(health())).toMatchObject({
      status: "available",
      showBadge: false,
    });
  });

  test("missing when the binary was not installed or not found", () => {
    expect(
      classifyAvailability(
        health({ binary: { ...health().binary, installed: false, versionStatus: "not-found" } }),
      ),
    ).toBe("missing");
    expect(
      classifyAvailability(
        health({ binary: { ...health().binary, installed: true, versionStatus: "not-found" } }),
      ),
    ).toBe("missing");
  });

  test("unrunnable covers probe failures, timeouts, and cleanup failure", () => {
    for (const versionStatus of ["unrunnable", "timeout", "probe-failed"] as const) {
      expect(classifyAvailability(health({ binary: { ...health().binary, versionStatus } }))).toBe(
        "unrunnable",
      );
    }
    expect(
      classifyAvailability(health({ binary: { ...health().binary, processCleanupFailed: true } })),
    ).toBe("unrunnable");
    expect(classifyAvailability(health({ rpcUi: { checked: true, supported: null } }))).toBe(
      "unrunnable",
    );
    expect(classifyAvailability(health({ rpcUi: { checked: false, supported: null } }))).toBe(
      "unrunnable",
    );
  });

  test("incompatible when the version is malformed or rpc-ui is explicitly absent", () => {
    expect(
      classifyAvailability(health({ binary: { ...health().binary, versionStatus: "malformed" } })),
    ).toBe("incompatible");
    expect(classifyAvailability(health({ rpcUi: { checked: true, supported: false } }))).toBe(
      "incompatible",
    );
  });

  test("checks run in probe order: install, cleanup, version, rpc-ui", () => {
    const binary = health().binary;
    expect(
      classifyAvailability(
        health({
          binary: { ...binary, installed: false, versionStatus: "malformed" },
          rpcUi: { checked: true, supported: false },
        }),
      ),
    ).toBe("missing");
    expect(
      classifyAvailability(
        health({ binary: { ...binary, processCleanupFailed: true, versionStatus: "not-found" } }),
      ),
    ).toBe("unrunnable");
    expect(
      classifyAvailability(
        health({
          binary: { ...binary, versionStatus: "not-found" },
          rpcUi: { checked: true, supported: false },
        }),
      ),
    ).toBe("missing");
  });
});

describe("availability display copy", () => {
  test("allowlists copy for each unavailable state and leaks no probe output", () => {
    const cases = [
      ["missing", "Not found", "danger"],
      ["unrunnable", "Cannot run", "danger"],
      ["incompatible", "Incompatible", "warning"],
    ] as const;
    const overrides: Record<(typeof cases)[number][0], Partial<OmpProviderHealth>> = {
      missing: { binary: { ...health().binary, installed: false, versionStatus: "not-found" } },
      unrunnable: { binary: { ...health().binary, versionStatus: "timeout" } },
      incompatible: {
        binary: { ...health().binary, installed: true, versionStatus: "ok" },
        rpcUi: { checked: true, supported: false },
      },
    };
    for (const [status, label, tone] of cases) {
      const display = toAvailabilityDisplay(health(overrides[status]));
      expect(display).toMatchObject({ status, label, tone, showBadge: true });
      expect(display.title.length).toBeGreaterThan(0);
      expect(display.detail).toBe(AVAILABILITY_COPY[status].detail);
      expect(display.action).toBe(AVAILABILITY_COPY[status].action);
      // Copy is fixed text, never a path/version/stdout fragment.
      expect(display.detail).not.toMatch(/[\d]+\.[\d]+\.[\d]+|\/|~|\.yml|\.db/);
    }
  });

  test("available is badge-free with no detail or action", () => {
    expect(toAvailabilityDisplay(health())).toEqual({
      status: "available",
      tone: "ok",
      label: "Available",
      title: "OMP available",
      detail: null,
      action: null,
      showBadge: false,
    });
  });
});
