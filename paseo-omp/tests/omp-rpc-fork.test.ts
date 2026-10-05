import { describe, expect, test } from "vitest";
import { INSTEAD_HINTS } from "../server/provider/instead-hints";
import { OmpForkParamsSchema, OmpForkResultSchema } from "../server/provider/omp-rpc-protocol";
import { isOmpPublicError } from "../server/provider/security";
import {
  FakeRpcChild,
  observeCommands,
  READY_FRAME,
  runtimeFor,
} from "./helpers/omp-rpc-harness";

function observeFork(
  child: FakeRpcChild,
  forks: Array<Record<string, unknown>>,
  onFork: (command: Record<string, unknown>) => void,
): void {
  observeCommands(child, (command) => {
    if (command.type === "negotiate_protocol") {
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: { protocolVersion: 2 },
      });
      return;
    }
    if (command.type !== "fork") return;
    forks.push(command);
    onFork(command);
  });
}
describe("OMP RPC fork", () => {
  test("accepts fork with an entry id", async () => {
    const child = new FakeRpcChild();
    const forks: Array<Record<string, unknown>> = [];
    observeFork(child, forks, (command) => {
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: { cancelled: false },
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.fork("user-root")).resolves.toEqual({ cancelled: false });
    expect(forks).toEqual([expect.objectContaining({ type: "fork", entryId: "user-root" })]);
    await session.close();
  });

  test("accepts fork without an entry id for the whole session", async () => {
    const child = new FakeRpcChild();
    const forks: Array<Record<string, unknown>> = [];
    observeFork(child, forks, (command) => {
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: { cancelled: true },
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.fork()).resolves.toEqual({ cancelled: true });
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({ type: "fork" });
    expect(forks[0]).not.toHaveProperty("entryId");
    await session.close();
  });

  test("rejects malformed fork params without sending a request", async () => {
    expect(() => OmpForkParamsSchema.parse({ entryId: 42 })).toThrow();
    expect(() => OmpForkParamsSchema.parse({ unexpected: true })).toThrow();
    expect(() => OmpForkResultSchema.parse({})).toThrow();
    expect(() => OmpForkResultSchema.parse({ cancelled: false, text: "replayed" })).toThrow();

    const child = new FakeRpcChild();
    const forks: Array<Record<string, unknown>> = [];
    observeFork(child, forks, (command) => {
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: { cancelled: false },
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.fork("x".repeat(257))).rejects.toThrow(
      "Invalid OMP fork entry identifier",
    );
    expect(forks).toHaveLength(0);
    await session.close();
  });

  test("surfaces a typed fork-needs-floor rejection on floor binaries", async () => {
    const child = new FakeRpcChild();
    const types: string[] = [];
    observeCommands(child, (command) => {
      if (typeof command.type === "string") types.push(command.type);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "fork") return;
      child.write({
        type: "response",
        command: "fork",
        success: false,
        error: "Unknown command: fork",
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    const error: unknown = await session.fork("user-root").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected fork to reject");
    expect(error.message).toBe("OMP fork requires OMP past 18.4.11");
    expect(isOmpPublicError(error)).toBe(true);
    expect("diagnostic" in error ? error.diagnostic : undefined).toBe(
      INSTEAD_HINTS["fork-needs-floor"],
    );
    expect(types).toEqual(["negotiate_protocol", "fork"]);
    expect(types).not.toContain("branch");
    await session.close();
  });

  test("never maps fork onto branch results", async () => {
    const child = new FakeRpcChild();
    const types: string[] = [];
    observeCommands(child, (command) => {
      if (typeof command.type === "string") types.push(command.type);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "fork") return;
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: { text: "replayed question", cancelled: false },
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.fork("user-root")).rejects.toThrow("OMP RPC response is invalid");
    expect(types).toEqual(["negotiate_protocol", "fork"]);
    await session.close();
  });
});
