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

test("redactSecrets traverses nested payloads", () => {
  assert.deepEqual(redactSecrets({ nested: ["abc-token-xyz"] }, ["token"]), {
    nested: ["abc-[REDACTED]-xyz"],
  });
});
