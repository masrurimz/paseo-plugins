import { describe, expect, test } from "vitest";
import {
  assembleSupportBundle,
  getOmpSupportBundle,
  OMP_SUPPORT_TRANSCRIPT_MAX_BYTES,
  OMP_SUPPORT_TRANSCRIPT_TRUNCATION_MARKER,
  renderTranscriptExcerpt,
  type TranscriptSlice,
  truncateUtf8Text,
} from "../shared/support-bundle";
import { supportReportByteLength } from "../shared/support-diagnostics";

const REPORT = "OMP support diagnostics\nschema_version: 1\n";

describe("support bundle assembler", () => {
  test("passes the report through untouched and includes the transcript half", () => {
    const bundle = assembleSupportBundle(REPORT, {
      status: "included",
      text: "user: hello",
      note: null,
    });
    expect(bundle.report).toBe(REPORT);
    expect(bundle.transcript).toEqual({ status: "included", text: "user: hello", note: null });
  });

  test("defaults an unavailable transcript to an empty text and a note", () => {
    const bundle = assembleSupportBundle(REPORT, { status: "unavailable", text: "", note: null });
    expect(bundle.report).toBe(REPORT);
    expect(bundle.transcript.status).toBe("unavailable");
    expect(bundle.transcript.text).toBe("");
    expect(bundle.transcript.note).toBe("Transcript excerpt unavailable.");
  });

  test("keeps a caller-supplied unavailable note", () => {
    const bundle = assembleSupportBundle(REPORT, {
      status: "unavailable",
      text: "",
      note: "No persisted transcript exists for this session in this workspace.",
    });
    expect(bundle.transcript.note).toBe(
      "No persisted transcript exists for this session in this workspace.",
    );
  });

  test("bounds an oversized transcript to the 32 KiB transcript cap, not the 64 KiB report cap", () => {
    const oversized: TranscriptSlice = {
      status: "included",
      text: "a".repeat(OMP_SUPPORT_TRANSCRIPT_MAX_BYTES * 2),
      note: null,
    };
    const bundle = assembleSupportBundle(REPORT, oversized);
    expect(supportReportByteLength(bundle.transcript.text)).toBeLessThanOrEqual(
      OMP_SUPPORT_TRANSCRIPT_MAX_BYTES,
    );
    expect(bundle.transcript.text.endsWith(OMP_SUPPORT_TRANSCRIPT_TRUNCATION_MARKER)).toBe(true);
    expect(bundle.report).toBe(REPORT);
  });

  test("truncates on code-point boundaries for multi-byte text", () => {
    const text = "é".repeat(100);
    const truncated = truncateUtf8Text(text, 31);
    expect(supportReportByteLength(truncated)).toBeLessThanOrEqual(31);
    expect(truncated).not.toContain("\uFFFD");
  });

  test("returns empty text when the budget cannot hold the marker", () => {
    expect(truncateUtf8Text("overflow", 0)).toBe("");
    expect(truncateUtf8Text("overflow", 4)).toBe("");
  });
});

describe("transcript excerpt renderer", () => {
  test("renders role-prefixed text lines and skips content-free entries", () => {
    const excerpt = renderTranscriptExcerpt(
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
        { role: "toolResult", content: [{ type: "image", data: "ignored" }] },
        "not-an-entry",
      ],
      OMP_SUPPORT_TRANSCRIPT_MAX_BYTES,
    );
    expect(excerpt).toBe("user: first question\n\nassistant: first answer");
  });

  test("caps the rendered excerpt at the requested budget", () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      role: "user",
      content: `message ${index} ${"x".repeat(200)}`,
    }));
    const excerpt = renderTranscriptExcerpt(messages, 512);
    expect(supportReportByteLength(excerpt)).toBeLessThanOrEqual(512);
  });
});

describe("support bundle RPC contract", () => {
  test("requires a bounded selector and rejects widened input", () => {
    expect(
      getOmpSupportBundle.input.safeParse({
        cwd: "/repo",
        transcript: { source: "journal", sessionId: "session-a", maxBytes: 32_768 },
      }).success,
    ).toBe(true);
    expect(
      getOmpSupportBundle.input.safeParse({
        cwd: "/repo",
        transcript: { source: "journal", sessionId: "session-a", maxBytes: 1_000_000 },
      }).success,
    ).toBe(false);
    expect(getOmpSupportBundle.input.safeParse({ cwd: "/repo", extra: true }).success).toBe(false);
  });

  test("accepts an included bundle whose report respects the untouched 64 KiB report cap", () => {
    const bundle = assembleSupportBundle(REPORT, {
      status: "included",
      text: "user: hello",
      note: null,
    });
    expect(getOmpSupportBundle.output.safeParse(bundle).success).toBe(true);
  });

  test("accepts an unavailable transcript bundle", () => {
    const bundle = assembleSupportBundle(REPORT, {
      status: "unavailable",
      text: "",
      note: "Transcript excerpt not requested.",
    });
    expect(getOmpSupportBundle.output.safeParse(bundle).success).toBe(true);
  });
});
