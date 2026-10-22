import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { runAgent } from "../../src/agent.js";
import type { ClaudeManagedAgents } from "../../src/anthropic.js";
import type { Config } from "../../src/config.js";
import { RenderSandbox, type ExecEvent, type SandboxApi } from "../../src/render.js";

const config: Config = {
  renderApiKey: "render-secret",
  renderWorkspaceId: "tea-test",
  anthropicApiKey: "anthropic-secret",
  anthropicAgentId: "agent-test",
  anthropicEnvironmentId: "env-test",
  anthropicEnvironmentKey: "environment-secret",
};

function fakeRender(calls: string[]): RenderSandbox {
  const api: SandboxApi = {
    create: async () => {
      calls.push("sandbox:create");
      return { id: "sbx-test", status: "creating" };
    },
    get: async () => ({ id: "sbx-test", status: "running" }),
    upload: async () => undefined,
    download: async () => ({ data: Buffer.from("hello") }),
    terminate: async () => void calls.push("sandbox:terminate"),
    exec: async (_id, command, _owner, signal) => {
      if (command.includes("beta:worker")) {
        return (async function* (): AsyncGenerator<ExecEvent> {
          await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
          throw signal?.reason;
        })();
      }
      return (async function* (): AsyncGenerator<ExecEvent> {
        yield { type: "exit", exit_code: 0 };
      })();
    },
  };
  return new RenderSandbox("unused", "unused", api);
}

function fakeClaude(calls: string[], overrides: Partial<ClaudeManagedAgents> = {}): ClaudeManagedAgents {
  let sessionDeleted!: () => void;
  const deleted = new Promise<void>((resolve) => {
    sessionDeleted = resolve;
  });
  return {
    preflight: async () => undefined,
    waitForWorker: async () => undefined,
    createSession: async (_agent: string, _env: string, onCreated: (id: string) => Promise<void>) => {
      calls.push("session:create");
      await onCreated("sesn-test");
      return "sesn-test";
    },
    openEventStream: async () =>
      (async function* () {
        await deleted;
      })(),
    sendPrompt: async () => undefined,
    interruptAndDelete: async () => {
      calls.push("session:delete");
      sessionDeleted();
    },
    ...overrides,
  } as unknown as ClaudeManagedAgents;
}

async function readState(root: string): Promise<Record<string, unknown>> {
  const [runId] = await readdir(root);
  return JSON.parse(await readFile(join(root, runId!, "run.json"), "utf8")) as Record<string, unknown>;
}

test("a failed prompt submission still deletes the session and terminates the sandbox", async () => {
  const root = join(process.cwd(), ".test-tmp", `lifecycle-send-${process.pid}-${Date.now()}`);
  const calls: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    await assert.rejects(
      runAgent(config, { prompt: "do it", timeoutMs: 60_000 }, undefined, {
        claude: fakeClaude(calls, {
          sendPrompt: async () => {
            throw new Error("send failed");
          },
        }),
        render: fakeRender(calls),
        runsRoot: root,
      }),
      /send failed/,
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.deepEqual(calls, ["sandbox:create", "session:create", "session:delete", "sandbox:terminate"]);
    const state = await readState(root);
    assert.deepEqual(state.cleanup, { anthropic_session: "complete", sandbox: "complete" });
    assert.ok(Array.isArray(state.effective_egress_policy));
    assert.ok((state.effective_egress_policy as string[]).includes("api.anthropic.com"));
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupt reports its signal and still cleans up", async () => {
  const root = join(process.cwd(), ".test-tmp", `lifecycle-signal-${process.pid}-${Date.now()}`);
  const calls: string[] = [];
  const controller = new AbortController();

  try {
    await assert.rejects(
      runAgent(config, { prompt: "do it", timeoutMs: 60_000 }, controller.signal, {
        claude: fakeClaude(calls, {
          waitForWorker: async (_env: string, _deadline: number, signal: AbortSignal) => {
            setTimeout(() => controller.abort(new Error("Received SIGINT")), 10);
            await sleep(60_000, undefined, { signal });
          },
        }),
        render: fakeRender(calls),
        runsRoot: root,
      }),
      /Received SIGINT/,
    );
    assert.deepEqual(calls, ["sandbox:create", "sandbox:terminate"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ambiguous session creation is reported for reconciliation", async () => {
  const root = join(process.cwd(), ".test-tmp", `lifecycle-ambiguous-${process.pid}-${Date.now()}`);
  const calls: string[] = [];

  try {
    await assert.rejects(
      runAgent(config, { prompt: "do it", timeoutMs: 60_000 }, undefined, {
        claude: fakeClaude(calls, {
          createSession: async () => {
            throw new Error("socket hang up");
          },
        }),
        render: fakeRender(calls),
        runsRoot: root,
      }),
      /socket hang up/,
    );

    assert.ok(calls.includes("sandbox:terminate"));
    const state = await readState(root);
    assert.match(String(state.ambiguous_mutation), /Reconcile before retrying/);
    assert.deepEqual(state.cleanup, { anthropic_session: "complete", sandbox: "complete" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
