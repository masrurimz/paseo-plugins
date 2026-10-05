import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import {
  resolveDescriptorTitleForOpen,
  sanitizeNativeTitle,
} from "../server/provider/session-descriptors";
import { OmpTimelineProjector } from "../server/provider/timeline-projector";
import {
  createHarness,
  EventLog,
  FakeOmpRuntime,
  ManualScheduler,
  NATIVE_SESSION_ID,
} from "./helpers/provider-harness";

function titleProjector(events: ProviderEvent[]): OmpTimelineProjector {
  return new OmpTimelineProjector("title-session", (event) => events.push(event));
}

describe("OMP native session titles", () => {
  test("projectPassive re-emits native setTitle as a Provider session notice", () => {
    const events: ProviderEvent[] = [];
    const projector = titleProjector(events);

    projector.projectPassive({
      type: "extension_ui_request",
      id: "title-1",
      method: "setTitle",
      title: "  Live\nTitle\u0007  ",
    });

    expect(events).toEqual([
      {
        type: "session.notice",
        sessionId: "title-session",
        notice: { id: "omp:session-title", severity: "info", title: "Live Title" },
      },
    ]);
  });

  test("setTitle arm dedupes repeats and drops blank titles", () => {
    const events: ProviderEvent[] = [];
    const projector = titleProjector(events);

    projector.projectPassive({
      type: "extension_ui_request",
      id: "title-1",
      method: "setTitle",
      title: "Same title",
    });
    projector.projectPassive({
      type: "extension_ui_request",
      id: "title-2",
      method: "setTitle",
      title: "Same title",
    });
    projector.projectPassive({
      type: "extension_ui_request",
      id: "title-3",
      method: "setTitle",
      title: "   ",
    });

    expect(events).toHaveLength(1);
  });

  test("native title sanitize cap matches the descriptor 512-byte rule", () => {
    expect(sanitizeNativeTitle("x".repeat(512))).toBe("x".repeat(512));
    expect(sanitizeNativeTitle("x".repeat(513))).toBeUndefined();
    expect(sanitizeNativeTitle("  padded  ")).toBe("padded");
    expect(sanitizeNativeTitle("a\0b")).toBeUndefined();
    expect(sanitizeNativeTitle(42)).toBeUndefined();
  });

  test("open seeding prefers descriptor title, then first and last prompt previews", () => {
    expect(
      resolveDescriptorTitleForOpen({
        title: "Native",
        firstPromptPreview: "First",
        lastPromptPreview: "Last",
      }),
    ).toBe("Native");
    expect(
      resolveDescriptorTitleForOpen({ firstPromptPreview: "First", lastPromptPreview: "Last" }),
    ).toBe("First");
    expect(resolveDescriptorTitleForOpen({ lastPromptPreview: "Last" })).toBe("Last");
    expect(resolveDescriptorTitleForOpen({})).toBeUndefined();
    expect(resolveDescriptorTitleForOpen(undefined)).toBeUndefined();
  });

  test("sessions-list title mapping is unchanged", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      title: "Native Title",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.list",
      "session.persistence",
    ]);
    const log = new EventLog();
    connection.onEvent((event) => {
      events.push(event);
      log.push(event);
    });

    await connection.send({ type: "sessions", requestId: "title-list", cwd: "/repo" });
    await log.waitFor((event) => event.type === "sessions" && event.requestId === "title-list");

    expect(
      log.find((event) => event.type === "sessions" && event.requestId === "title-list"),
    ).toEqual({
      type: "sessions",
      requestId: "title-list",
      sessions: [
        {
          persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
          cwd: "/repo",
          title: "Native Title",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    await connection.close();
  });
});
