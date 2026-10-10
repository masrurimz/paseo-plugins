import { describe, expect, onTestFinished, test } from "vitest";
import type { OmpMessage, OmpRpcEvent } from "../server/provider/omp-rpc-protocol";
import { terminalOutcome } from "../server/provider/session-terminal";
import {
  createHarness,
  FakeOmpRuntime,
  openSession,
  sessionAt,
  startPrompt,
  turnIdFrom,
} from "./helpers/provider-harness";

type AgentEnd = Extract<OmpRpcEvent, { type: "agent_end" }>;

const idleTurn = {
  completedMessageCount: 0,
  lastCompletedAssistantOutcome: undefined,
} as const;

function agentEnd(event: Omit<AgentEnd, "type">): AgentEnd {
  return { type: "agent_end", ...event };
}

describe("terminalOutcome zero-evidence guard", () => {
  test("returns undefined for an unkeyed agent_end with messageCount 0", () => {
    expect(terminalOutcome(agentEnd({ messageCount: 0, isTerminal: true }), idleTurn)).toBeUndefined();
  });

  test("returns undefined for retained messages with no assistant evidence", () => {
    const user: OmpMessage = { role: "user", content: "hello" };
    expect(
      terminalOutcome(agentEnd({ messages: [user], messageCount: 1, isTerminal: true }), idleTurn),
    ).toBeUndefined();
  });

  test("keeps the request-keyed empty-turn contract from finishTurn", () => {
    expect(
      terminalOutcome(
        agentEnd({ requestId: "rpc-prompt-1", messages: [], isTerminal: true }),
        idleTurn,
      ),
    ).toBe("completed");
  });

  test("still derives the outcome from retained assistant evidence", () => {
    const assistant: OmpMessage = { role: "assistant", content: "done", stopReason: "stop" };
    expect(
      terminalOutcome(agentEnd({ messages: [assistant], isTerminal: true }), idleTurn),
    ).toBe("completed");
  });

  test("preserves the unkeyed empty-retained-list contract", () => {
    expect(
      terminalOutcome(agentEnd({ messages: [], isTerminal: true }), idleTurn),
    ).toBe("completed");
  });
});

describe("manual compaction agent_end swallow", () => {
  test("terminal assistant evidence arriving mid-compaction is dropped silently", async () => {
    const runtime = new FakeOmpRuntime();
    const compact = Promise.withResolvers<void>();
    const { connection, events } = await createHarness(runtime);
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.compactGate = compact.promise;
    session.isCompacting = true;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "compact-swallow-repro", "/compact"),
    );
    session.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: "done", stopReason: "stop" }],
      isTerminal: true,
    });
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(0);
    session.isCompacting = false;
    compact.resolve();
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
  });
});
