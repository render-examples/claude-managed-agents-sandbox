import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxCreateInput } from "@renderinc/sdk/experimental";
import { RenderSandbox, type ExecEvent, type SandboxApi } from "../../src/render.js";

async function* execEvents(): AsyncGenerator<ExecEvent> {
  yield { type: "output", stream: "stdout", data: "hello" };
  yield { type: "output", stream: "stderr", data: "warning" };
  yield { type: "exit", exit_code: 3 };
}

test("fake Render flow preserves asynchronous creation, exec events, and termination", async () => {
  const calls: string[] = [];
  let createInput: SandboxCreateInput | undefined;
  const api: SandboxApi = {
    create: async (input) => {
      createInput = input;
      calls.push("create");
      return { id: "sbx-test", status: "creating" };
    },
    get: async () => {
      calls.push("get");
      return { id: "sbx-test", status: "running" };
    },
    exec: async () => execEvents(),
    upload: async () => undefined,
    download: async () => ({ data: Buffer.from("bytes") }),
    terminate: async () => void calls.push("terminate"),
  };
  const render = new RenderSandbox("unused", "unused", api);
  const sandbox = await render.createAndWait(
    {
      timeoutSeconds: 300,
      networkPolicy: {
        type: "allow-list",
        rules: [{ domain: "api.anthropic.com", protocol: "https" }],
      },
      env: { ANTHROPIC_ENVIRONMENT_KEY: "secret" },
    },
    async () => void calls.push("persist"),
    Date.now() + 1_000,
  );
  const result = await render.execBuffered(sandbox.id, "false");
  await render.terminate(sandbox.id);

  assert.deepEqual(calls, ["create", "persist", "get", "terminate"]);
  assert.equal(createInput?.networkPolicy?.type, "allow-list");
  assert.deepEqual(result, { stdout: "hello", stderr: "warning", exitCode: 3 });
});
