import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { cleanupRun } from "../../src/cleanup.js";
import { RunStore, type RunState } from "../../src/state.js";

test("cleanup attempts sandbox termination after session deletion fails", async () => {
  const root = join(process.cwd(), ".test-tmp", `cleanup-${process.pid}-${Date.now()}`);
  const state: RunState = {
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
