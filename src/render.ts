import { Render } from "@renderinc/sdk";
import type { SandboxCreateInput } from "@renderinc/sdk/experimental";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

export interface SandboxInfo {
  id: string;
  status: string;
}

export type ExecEvent =
  | { type: "output"; stream: "stdout" | "stderr"; data: string }
  | { type: "exit"; exit_code: number };

export interface SandboxApi {
  create(input: SandboxCreateInput): Promise<SandboxInfo>;
  get(id: string): Promise<SandboxInfo>;
  exec(
    id: string,
    command: string,
    ownerId?: `tea-${string}`,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<ExecEvent>>;
  upload(id: string, path: string, data: Uint8Array | string): Promise<void>;
  download(
    id: string,
    path: string,
    ownerId?: `tea-${string}`,
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array }>;
  terminate(id: string): Promise<void>;
}

export interface WorkerProcess {
  done: Promise<number>;
  abort: () => void;
}

export interface BufferedExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class RenderSandbox {
  private readonly api: SandboxApi;

  constructor(apiKey: string, workspaceId: string, api?: SandboxApi) {
    this.api =
      api ??
      (new Render({
        token: apiKey,
        ownerId: workspaceId,
      }).experimental.sandboxes as unknown as SandboxApi);
  }

  /**
   * The create request itself is not aborted: an abandoned request could create
   * a sandbox whose ID is never recorded. The signal stops only the polling.
   */
  async createAndWait(
    input: SandboxCreateInput,
    onCreated: (sandboxId: string) => Promise<void>,
    deadline: number,
    signal: AbortSignal,
  ): Promise<SandboxInfo> {
    const sandbox = await this.api.create(input);
    await onCreated(sandbox.id);

    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const current = await this.api.get(sandbox.id);
      if (current.status === "running") return current;
      if (current.status === "errored" || current.status === "terminated") {
        throw new Error(`Render sandbox ${sandbox.id} became ${current.status}`);
      }
      await sleep(1_500, undefined, { signal });
    }

    throw new Error(`Timed out waiting for Render sandbox ${sandbox.id}`);
  }

  async uploadInstallScript(sandboxId: string, localPath: string): Promise<void> {
    const script = await readFile(localPath);
    await this.api.upload(sandboxId, "/tmp/install-executor.sh", script);
  }

  async execBuffered(
    sandboxId: string,
    command: string,
    signal?: AbortSignal,
    maxBytes = 1_048_576,
  ): Promise<BufferedExecResult> {
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    const stream = await this.api.exec(sandboxId, command, undefined, signal);

    for await (const event of stream) {
      if (event.type === "output") {
        const current = event.stream === "stdout" ? stdout : stderr;
        if (Buffer.byteLength(current) < maxBytes) {
          const remaining = maxBytes - Buffer.byteLength(current);
          const chunk = Buffer.from(event.data).subarray(0, remaining).toString();
          if (event.stream === "stdout") stdout += chunk;
          else stderr += chunk;
        }
      } else {
        exitCode = event.exit_code;
      }
    }

    if (exitCode === undefined) throw new Error("Render exec stream ended without an exit event");
    return { stdout, stderr, exitCode };
  }

  async startWorker(
    sandboxId: string,
    parentSignal: AbortSignal,
    secrets: readonly string[] = [],
  ): Promise<WorkerProcess> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });

    const stream = await this.api.exec(
      sandboxId,
      "/workspace/.managed-agent/bin/ant beta:worker poll --workdir /workspace --log-format json",
      undefined,
      controller.signal,
    );

    const done = (async (): Promise<number> => {
      try {
        for await (const event of stream) {
          if (event.type === "output") {
            const destination = event.stream === "stdout" ? process.stdout : process.stderr;
            const redacted = secrets
              .filter(Boolean)
              .reduce((text, secret) => text.split(secret).join("[REDACTED]"), event.data);
            destination.write(`[worker:${event.stream}] ${redacted}`);
          } else {
            return event.exit_code;
          }
        }
        throw new Error("Managed Agents worker stream ended without an exit event");
      } finally {
        parentSignal.removeEventListener("abort", abort);
      }
    })();

    return {
      done,
      abort: () => controller.abort(new Error("worker stopped")),
    };
  }

  async download(sandboxId: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
    return (await this.api.download(sandboxId, path, undefined, signal)).data;
  }

  async terminate(sandboxId: string): Promise<void> {
    await this.api.terminate(sandboxId);
  }
}
