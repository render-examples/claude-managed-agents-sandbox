import assert from "node:assert/strict";
import { test } from "vitest";
import { consumeSessionEvents, redactSecrets } from "../../src/events.js";

async function* events(): AsyncGenerator<unknown> {
  yield { type: "session.status_running" };
  yield {
    type: "agent.message",
    content: [{ type: "text", text: "finished safely" }],
    debug: "secret-worker-key",
  };
  yield { type: "session.status_idle", stop_reason: { type: "end_turn" } };
}

test("native events are retained, redacted, and produce the final text", async () => {
  const stored: unknown[] = [];
  const result = await consumeSessionEvents(
    events(),
    { appendEvent: async (event) => void stored.push(event) },
    ["secret-worker-key"],
  );

  assert.equal(result, "finished safely");
  assert.doesNotMatch(JSON.stringify(stored), /secret-worker-key/);
  assert.match(JSON.stringify(stored), /\[REDACTED\]/);
});

const sink = { appendEvent: async () => undefined };

test("idling on a worker-run tool call waits for the worker instead of failing", async () => {
  async function* toolTurn(): AsyncGenerator<unknown> {
    yield { type: "agent.tool_use", id: "sevt_tool", name: "bash", evaluated_permission: "allow" };
    yield {
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["sevt_tool"] },
    };
    yield { type: "session.status_running" };
    yield { type: "agent.message", content: [{ type: "text", text: "server works" }] };
    yield { type: "session.status_idle", stop_reason: { type: "end_turn" } };
  }

  assert.equal(await consumeSessionEvents(toolTurn(), sink, []), "server works");
});

test("idling on an action the worker cannot resolve fails the run", async () => {
  async function* customToolTurn(): AsyncGenerator<unknown> {
    yield { type: "agent.custom_tool_use", id: "sevt_custom", name: "lookup" };
    yield {
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["sevt_custom"] },
    };
  }
  async function* confirmationTurn(): AsyncGenerator<unknown> {
    yield { type: "agent.tool_use", id: "sevt_ask", name: "bash", evaluated_permission: "ask" };
    yield {
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["sevt_ask"] },
    };
  }

  for (const stream of [customToolTurn(), confirmationTurn()]) {
    await assert.rejects(consumeSessionEvents(stream, sink, []), /stopped: requires_action/);
  }
});

test("redactSecrets traverses nested payloads", () => {
  assert.deepEqual(redactSecrets({ nested: ["abc-token-xyz"] }, ["token"]), {
    nested: ["abc-[REDACTED]-xyz"],
  });
});
