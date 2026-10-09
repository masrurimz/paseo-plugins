import { describe, expect, test } from "vitest";
import {
  ABORT_SETTLE_TIMEOUT_MS,
  DEFERRED_END_TIMEOUT_MS,
  INTERRUPT_ACK_TIMEOUT_MS,
  STEER_TIMEOUT_MS,
} from "../server/provider/session";
import {
  createHarness,
  establishTerminalOwnership,
  FakeOmpRuntime,
  ManualScheduler,
  openSession,
  sessionAt,
  startPrompt,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP bounded stop paths", () => {
  test("a hanging native abort still settles Stop as canceled", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "hang-abort", "work"));
    const session = sessionAt(runtime);
    session.abortGate = new Promise<void>(() => {});
    const interrupted = connection.send({
      type: "session.interrupt",
      requestId: "stop-hung-abort",
      sessionId: "session-1",
    });
    await scheduler.flush(ABORT_SETTLE_TIMEOUT_MS);
    await scheduler.flush();
    await interrupted;
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "stop-hung-abort",
    );
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "canceled" }));
    await connection.close();
  });

  test("a deferred parent with an idle child force-finishes after Stop", async () => {
    const { connection, events, runtime, scheduler } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
    );
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "deferred-stop", "work"));
    const session = sessionAt(runtime);
    session.emit({
      type: "tool_execution_start",
      toolCallId: "task-deadline",
      toolName: "task",
      args: { tasks: [{ task: "inspect" }] },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "task-deadline",
      toolName: "task",
      result: { details: { results: [{ id: "native-child-deadline", agent: "scout" }] } },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-child-deadline",
        agent: "scout",
        description: "Inspect",
        status: "started",
        sessionFile: "/sessions/root/native-child-deadline.jsonl",
        parentToolCallId: "task-deadline",
        index: 0,
      },
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await Promise.resolve();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === turnId &&
          event.state !== "started",
      ),
    ).toBe(false);
    await connection.send({
      type: "session.interrupt",
      requestId: "stop-deferred",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "stop-deferred",
    );
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "canceled" }));
    await scheduler.flush(DEFERRED_END_TIMEOUT_MS);
    await scheduler.flush();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    await connection.close();
  });

  test("a deferred parent with a live child force-finishes after Stop", async () => {
    const { connection, events, runtime, scheduler } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "deferred-live-stop", "work"));
    const child = {
      id: "deferred-live-child",
      agent: "scout",
      status: "running" as const,
      sessionFile: "/sessions/root/deferred-live.jsonl",
      parentToolCallId: "deferred-live-task",
      lastUpdate: 1,
      index: 0,
    };
    session.subagents = [child];
    session.emit({ type: "subagent_lifecycle", payload: { ...child, status: "started" } });
    establishTerminalOwnership(session);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await scheduler.flush(DEFERRED_END_TIMEOUT_MS);
    await scheduler.flush();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);
    const interrupted = connection.send({
      type: "session.interrupt",
      requestId: "stop-deferred-live",
      sessionId: "session-1",
    });
    await scheduler.flush();
    await interrupted;
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "stop-deferred-live",
    );
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "canceled" }));
    await connection.close();
  });

  test("stop on a deferred turn with a failing abort still force-finishes", async () => {
    const { connection, events, runtime, scheduler } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "deferred-dead-stop", "work"));
    const child = {
      id: "deferred-dead-child",
      agent: "scout",
      status: "running" as const,
      sessionFile: "/sessions/root/deferred-dead.jsonl",
      parentToolCallId: "deferred-dead-task",
      lastUpdate: 1,
      index: 0,
    };
    session.subagents = [child];
    session.emit({ type: "subagent_lifecycle", payload: { ...child, status: "started" } });
    establishTerminalOwnership(session);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await scheduler.flush(DEFERRED_END_TIMEOUT_MS);
    await scheduler.flush();
    session.abortError = new Error("native abort rejected");
    const interrupted = connection.send({
      type: "session.interrupt",
      requestId: "stop-deferred-dead",
      sessionId: "session-1",
    });
    await scheduler.flush();
    await interrupted;
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "stop-deferred-dead",
    );
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "canceled" }));
    await connection.close();
  });

  test("a stop-acknowledged turn that never ends is reaped", async () => {
    const { connection, events, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "reap-silent", "work"));
    const interrupted = connection.send({
      type: "session.interrupt",
      requestId: "stop-reap-silent",
      sessionId: "session-1",
    });
    await scheduler.flush();
    await interrupted;
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "stop-reap-silent",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);
    // POST_ABORT_SETTLE_MS (30s): the reaper, not any runtime event, settles the turn.
    await scheduler.flush(30_000);
    await scheduler.flush();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "canceled" }));
    await connection.close();
  });

  test("a hung branch-message lookup still lets agent_end terminalize", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "hung-branch", "hello"));
    const session = sessionAt(runtime);
    session.branchMessagesGate = new Promise<void>(() => {});
    session.emit({ type: "message_end", message: { role: "user", content: "hello" } });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.branchMessageLookups).toBe(1);
    await scheduler.flush(2_000);
    expect(scheduler.delays).toContain(2_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("a hung user correlation does not block interrupt settlement", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "hung-interrupt", "hello"));
    const session = sessionAt(runtime);
    session.branchMessagesGate = new Promise<void>(() => {});
    session.emit({ type: "message_end", message: { role: "user", content: "hello" } });
    await connection.send({
      type: "session.interrupt",
      requestId: "stop-hung-lookup",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "stop-hung-lookup",
    );
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.branchMessageLookups).toBe(1);
    await scheduler.flush(2_000);
    expect(scheduler.delays).toContain(2_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "canceled" }));
    await connection.close();
  });

  test("a hanging native steer fails bounded instead of pinning the turn", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    turnIdFrom(await startPrompt(connection, events, "steer-timeout", "work"));
    const session = sessionAt(runtime);
    session.steerGate = new Promise<void>(() => {});
    const steered = connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "timeout-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "focus" }] },
      },
    });
    await scheduler.flush(STEER_TIMEOUT_MS);
    await scheduler.flush();
    await steered;
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "timeout-steer",
    );
    expect(result).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: expect.objectContaining({ message: "OMP steer timed out" }),
        }),
      }),
    );
    await connection.close();
  });

  test("a hanging native abort still acknowledges Stop inside the daemon budget", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "hang-abort-ack", "work"));
    const session = sessionAt(runtime);
    session.abortGate = new Promise<void>(() => {});
    const interrupted = connection.send({
      type: "session.interrupt",
      requestId: "stop-hung-abort-ack",
      sessionId: "session-1",
    });
    await scheduler.flush();
    await scheduler.flush(INTERRUPT_ACK_TIMEOUT_MS);
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "stop-hung-abort-ack",
    );
    await scheduler.flush(ABORT_SETTLE_TIMEOUT_MS);
    await scheduler.flush();
    await interrupted;
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "canceled" }));
    await connection.close();
  });

  test("an abort failure against a dead runtime fails the turn instead of pinning it", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "dead-runtime-abort", "work"));
    const session = sessionAt(runtime);
    const abort = Promise.withResolvers<void>();
    session.abortGate = abort.promise;
    session.abortError = new Error("transport closed");
    session.stateGate = new Promise<void>(() => {});
    const interrupted = connection.send({
      type: "session.interrupt",
      requestId: "stop-dead-runtime",
      sessionId: "session-1",
    });
    abort.resolve();
    await scheduler.flush();
    await scheduler.flush();
    await scheduler.flush();
    await interrupted;
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "stop-dead-runtime",
    );
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "failed" }));
    await connection.close();
  });
});
