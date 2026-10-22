import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeManagedAgents } from "../../src/anthropic.js";

test("fake Managed Agents flow checks readiness, creates, submits, interrupts, and deletes", async () => {
  const calls: string[] = [];
  let statsCalls = 0;
  let retrieveCalls = 0;
  const fake = {
    beta: {
      agents: {
        retrieve: async () => ({ id: "agent-test", archived_at: null }),
      },
      environments: {
        retrieve: async () => ({
          id: "env-test",
          archived_at: null,
          config: { type: "self_hosted" },
        }),
        work: {
          stats: async () => ({
            workers_polling: statsCalls++ === 0 ? 0 : 1,
          }),
        },
      },
      sessions: {
        create: async () => ({ id: "sesn-test" }),
        retrieve: async () => ({
          id: "sesn-test",
          status: retrieveCalls++ === 0 ? "running" : "idle",
        }),
        delete: async () => void calls.push("delete"),
        events: {
          stream: async () =>
            (async function* () {
              yield { type: "session.status_idle", stop_reason: { type: "end_turn" } };
            })(),
          send: async (_id: string, body: { events: Array<{ type: string }> }) => {
            calls.push(body.events[0]!.type);
          },
        },
      },
    },
  };
  const claude = new ClaudeManagedAgents("", fake as unknown as Anthropic);
  const baseline = await claude.preflight("agent-test", "env-test");
  await claude.waitForWorker(
    "env-test",
    baseline,
    Date.now() + 1_000,
    new AbortController().signal,
  );
  const sessionId = await claude.createSession("agent-test", "env-test", async () => {
    calls.push("persist");
  });
  await claude.sendPrompt(sessionId, "do it");
  await claude.interruptAndDelete(sessionId);

  assert.equal(sessionId, "sesn-test");
  assert.deepEqual(calls, ["persist", "user.message", "user.interrupt", "delete"]);
});
