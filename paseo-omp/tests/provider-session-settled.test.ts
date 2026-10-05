import { describe, expect, test } from "vitest";
import {
  invalidEventDiagnosticMetadata,
  type OmpRpcEvent,
} from "../server/provider/omp-rpc-protocol";
import {
  createHarness,
  openSession,
  sessionAt,
  startPrompt,
  turnIdFrom,
} from "./helpers/provider-harness";

async function flushAsyncTurns(): Promise<void> {
  for (let count = 0; count < 3; count += 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

describe("session_settled diagnostics", () => {
  test("unknown types self-identify while session_settled classifies as lifecycle", () => {
    expect(
      invalidEventDiagnosticMetadata({ type: "future_unknown_xyz" }, "future_unknown_xyz"),
    ).toEqual({
      reason: "unknown-event-type",
      field: "frame.type",
      expected: "known-event-type",
      actualType: "string",
      unknownType: "future_unknown_xyz",
    });
    expect(invalidEventDiagnosticMetadata({ type: "session_settled" }, "session_settled")).toEqual({
      reason: "lifecycle-event-schema",
      eventType: "session_settled",
      field: "event",
      expected: "valid-lifecycle-event",
      actualType: "object",
    });
  });
});

describe("session_settled turn handling", () => {
  test("ignores settled on a turn with no agent_end yet", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "settled-fresh-1", "hello"));
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: "partial",
        entryId: "settled-assistant-fresh-1",
        stopReason: "stop",
      },
    });
    session.emit({ type: "session_settled" } as unknown as OmpRpcEvent);
    await flushAsyncTurns();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);
    await connection.close();
  });
  test("leaves a turn with an in-flight tool call untouched", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "settled-guard-1", "hello"));
    session.emit({
      type: "tool_execution_start",
      toolCallId: "settled-tool-1",
      toolName: "read",
      args: { path: "a.txt" },
    });
    session.emit({ type: "session_settled" } as unknown as OmpRpcEvent);
    await flushAsyncTurns();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);
    session.emit({
      type: "tool_execution_end",
      toolCallId: "settled-tool-1",
      toolName: "read",
      result: { content: "ok" },
    });
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: "done",
        entryId: "settled-assistant-guard-1",
        stopReason: "stop",
      },
    });
    await connection.close();
  });
});
