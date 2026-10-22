import assert from "node:assert/strict";
import { test } from "vitest";
import type { SandboxCreateInput } from "@renderinc/sdk/experimental";
import { RenderSandbox, type ExecEvent, type SandboxApi } from "../../src/render.js";

async function* execEvents(): AsyncGenerator<ExecEvent> {
  yield { type: "output", stream: "stdout", data: "hello" };
  yield { type: "output", stream: "stderr", data: "warning" };
  yield { type: "exit", exit_code: 3 };
}

function fakeApi(calls: string[], status: () => string): SandboxApi {
  return {
    create: async () => {
      calls.push("create");
      return { id: "sbx-test", status: "creating" };
    },
    get: async () => {
      calls.push("get");
      return { id: "sbx-test", status: status() };
    },
    exec: async () => execEvents(),
    upload: async () => undefined,
    download: async () => ({ data: Buffer.from("bytes") }),
    terminate: async () => void calls.push("terminate"),
  };
}

test("fake Render flow preserves asynchronous creation, exec events, and termination", async () => {
  const calls: string[] = [];
  let createInput: SandboxCreateInput | undefined;
  const api = fakeApi(calls, () => "running");
  const create = api.create;
  api.create = async (input) => {
    createInput = input;
    return create(input);
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
    new AbortController().signal,
  );
  const result = await render.execBuffered(sandbox.id, "false");
  await render.terminate(sandbox.id);

  assert.deepEqual(calls, ["create", "persist", "get", "terminate"]);
  assert.equal(createInput?.networkPolicy?.type, "allow-list");
  assert.deepEqual(result, { stdout: "hello", stderr: "warning", exitCode: 3 });
});

test("createAndWait records the ID, then stops polling promptly on abort", async () => {
  const calls: string[] = [];
  const render = new RenderSandbox("unused", "unused", fakeApi(calls, () => "creating"));
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("Received SIGINT")), 50);
  const started = Date.now();

  await assert.rejects(
    render.createAndWait(
      {},
      async () => void calls.push("persist"),
      Date.now() + 60_000,
      controller.signal,
    ),
    (error: Error) => error.name === "AbortError",
  );
  assert.ok(Date.now() - started < 1_000, "abort should interrupt the 1.5s poll sleep");
  assert.deepEqual(calls.slice(0, 2), ["create", "persist"]);
});
