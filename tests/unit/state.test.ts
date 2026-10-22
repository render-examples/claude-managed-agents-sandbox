import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { RunStore, type RunState } from "../../src/state.js";

test("RunStore writes state atomically with mode 0600 and no credentials", async () => {
  const root = join(process.cwd(), ".test-tmp", `state-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const state: RunState = {
    schema_version: 1,
    run_id: "run_test",
    phase: "preflight",
    anthropic_agent_id: "agent_test",
    anthropic_environment_id: "env_test",
    started_at: "2026-10-21T00:00:00.000Z",
    deadline: "2026-10-21T00:10:00.000Z",
    cleanup: { anthropic_session: "pending", sandbox: "pending" },
  };

  try {
    const store = new RunStore(root, state);
    await store.initialize();
    state.anthropic_session_id = "sesn_test";
    await store.save();

    const path = join(root, "run_test", "run.json");
    const contents = await readFile(path, "utf8");
    assert.equal(JSON.parse(contents).anthropic_session_id, "sesn_test");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.doesNotMatch(contents, /sk-ant/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
