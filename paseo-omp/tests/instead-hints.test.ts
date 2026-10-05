import { describe, expect, test } from "vitest";
import {
  INSTEAD_HINTS,
  insteadHint,
  type RejectCode,
  rejectDetails,
  rejectErrorDetails,
  rejectWithHint,
  withHint,
} from "../server/provider/instead-hints";
import { isOmpPublicError } from "../server/provider/security";

const REJECT_CODES: readonly RejectCode[] = [
  "toolPolicy-at-open",
  "toolPolicy-host-tools",
  "outputSchema",
  "live-settings",
  "live-mode",
  "revert-scope",
  "archive-absent",
];

describe("instead-hint registry", () => {
  test("every reject code carries a non-empty substitute workflow", () => {
    for (const code of REJECT_CODES) {
      expect(INSTEAD_HINTS[code]).toBeTruthy();
      expect(insteadHint(code)).toBe(INSTEAD_HINTS[code]);
    }
  });

  test("rejectWithHint keeps the exact message and attaches the hint as a public error", () => {
    const error = rejectWithHint("live-mode", "OMP approval mode cannot change live");
    expect(isOmpPublicError(error)).toBe(true);
    expect(error.message).toBe("OMP approval mode cannot change live");
    expect(error.diagnostic).toBe(INSTEAD_HINTS["live-mode"]);
  });
});

describe("hint transport shape", () => {
  test("hints stay out of JSON serialization and key enumeration", () => {
    const error = rejectWithHint("outputSchema", "OMP does not support structured output");
    expect(JSON.stringify(error)).not.toContain(INSTEAD_HINTS.outputSchema);
    expect(Object.keys(error)).not.toContain("diagnostic");
    expect(JSON.stringify(rejectDetails(error, error.message))).not.toContain(
      INSTEAD_HINTS.outputSchema,
    );
    expect(error.diagnostic).toBe(INSTEAD_HINTS.outputSchema);
  });

  test("the mapper transfer preserves the previous message-only shape for old clients", () => {
    const error = rejectWithHint("revert-scope", "OMP supports conversation rewind only");
    const details = rejectDetails(error, "OMP supports conversation rewind only");
    expect(details).toEqual({ message: "OMP supports conversation rewind only" });
    expect(details.diagnostic).toBe(INSTEAD_HINTS["revert-scope"]);
  });

  test("a plain error still maps to the fallback without inventing a hint", () => {
    const details = rejectDetails(new Error("native failure"), "OMP provider request failed");
    expect(details).toEqual({ message: "OMP provider request failed" });
    expect(details.diagnostic).toBeUndefined();
  });

  test("direct-emit details carry the hint for the revert reject path", () => {
    const details = rejectErrorDetails("revert-scope", "OMP supports conversation rewind only");
    expect(details).toEqual({ message: "OMP supports conversation rewind only" });
    expect(details.diagnostic).toBe(INSTEAD_HINTS["revert-scope"]);
  });

  test("withHint is idempotent and keeps the first code's hint", () => {
    const error = withHint(new Error("x"), "archive-absent");
    expect(error.diagnostic).toBe(INSTEAD_HINTS["archive-absent"]);
  });
});
