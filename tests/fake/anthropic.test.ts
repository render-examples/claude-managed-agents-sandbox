import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeManagedAgents, isAmbiguousMutationError } from "../../src/anthropic.js";

test("fake Managed Agents flow checks readiness, creates, submits, interrupts, and deletes", async () => {
  const calls: string[] = [];
  const requestOptions: Record<string, unknown> = {};
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
        create: async (_body: unknown, options: unknown) => {
          requestOptions.create = options;
          return { id: "sesn-test" };
        },
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
          send: async (_id: string, body: { events: Array<{ type: string }> }, options: unknown) => {
            calls.push(body.events[0]!.type);
            requestOptions[body.events[0]!.type] = options;
          },
        },
      },
    },
  };
  const signal = new AbortController().signal;
  const claude = new ClaudeManagedAgents("", fake as unknown as Anthropic);
  await claude.preflight("agent-test", "env-test", signal);
  await claude.waitForWorker("env-test", Date.now() + 5_000, signal);
  const sessionId = await claude.createSession("agent-test", "env-test", async () => {
    calls.push("persist");
  });
  await claude.sendPrompt(sessionId, "do it");
  await claude.interruptAndDelete(sessionId);

  assert.equal(sessionId, "sesn-test");
  assert.deepEqual(calls, ["persist", "user.message", "user.interrupt", "delete"]);
  assert.deepEqual(requestOptions.create, { maxRetries: 0 });
  assert.deepEqual(requestOptions["user.message"], { maxRetries: 0 });
});

test("isAmbiguousMutationError reads Anthropic status and Render statusCode", () => {
  assert.equal(isAmbiguousMutationError(new Error("socket hang up")), true);
  assert.equal(isAmbiguousMutationError(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(isAmbiguousMutationError(Object.assign(new Error("x"), { status: 400 })), false);
  assert.equal(isAmbiguousMutationError(Object.assign(new Error("x"), { statusCode: 422 })), false);
  assert.equal(isAmbiguousMutationError(Object.assign(new Error("x"), { statusCode: 502 })), true);
});
