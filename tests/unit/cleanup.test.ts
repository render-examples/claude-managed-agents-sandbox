import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { cleanupRun } from "../../src/cleanup.js";
import { RunStore, type RunState } from "../../src/state.js";

function runState(): RunState {
  return {
    schema_version: 1,
    run_id: "run_cleanup",
    phase: "cleanup",
    sandbox_id: "sbx-test",
    anthropic_session_id: "sesn-test",
    anthropic_agent_id: "agent-test",
    anthropic_environment_id: "env-test",
    started_at: "2026-10-21T00:00:00.000Z",
    deadline: "2026-10-21T00:10:00.000Z",
    cleanup: { anthropic_session: "pending", sandbox: "pending" },
  };
}

test("cleanup attempts sandbox termination after session deletion fails", async () => {
  const root = join(process.cwd(), ".test-tmp", `cleanup-${process.pid}-${Date.now()}`);
  const state = runState();
  const store = new RunStore(root, state);
  const calls: string[] = [];

  try {
    await store.initialize();
    const result = await cleanupRun(store, {
      deleteSession: async () => {
        calls.push("session");
        throw new Error("provider unavailable");
      },
      terminateSandbox: async () => void calls.push("sandbox"),
    });

    assert.deepEqual(calls, ["session", "sandbox"]);
    assert.deepEqual(result, { session: "failed", sandbox: "terminated" });
    assert.equal(state.cleanup.anthropic_session, "failed");
    assert.equal(state.cleanup.sandbox, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup still terminates the sandbox when session deletion hangs", async () => {
  const root = join(process.cwd(), ".test-tmp", `cleanup-hang-${process.pid}-${Date.now()}`);
  const state = runState();
  const store = new RunStore(root, state);
  let terminated = false;

  try {
    await store.initialize();
    const result = await cleanupRun(
      store,
      {
        deleteSession: () => new Promise<void>(() => undefined),
        terminateSandbox: async () => {
          terminated = true;
        },
      },
      { sessionMs: 20, sandboxMs: 20 },
    );

    assert.equal(terminated, true);
    assert.deepEqual(result, { session: "failed", sandbox: "terminated" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
