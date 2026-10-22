import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliOptions, Config } from "./config.js";
import { ClaudeManagedAgents } from "./anthropic.js";
import { cleanupRun } from "./cleanup.js";
import { consumeSessionEvents } from "./events.js";
import { collectOutputs } from "./outputs.js";
import { buildPublicSandboxLaunch } from "./policy.js";
import { RenderSandbox, type WorkerProcess } from "./render.js";
import { createRunId, RunStore, type RunState } from "./state.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sourceDirectory, "..");

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw errorValue(signal.reason ?? "Run aborted");
}

export async function runAgent(
  config: Config,
  options: CliOptions,
  externalSignal?: AbortSignal,
): Promise<void> {
  const startedAt = new Date();
  const deadline = startedAt.getTime() + options.timeoutMs;
  const deadlineController = new AbortController();
  const timeout = setTimeout(
    () => deadlineController.abort(new Error(`Run exceeded ${options.timeoutMs / 1000}s deadline`)),
    options.timeoutMs,
  );
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, deadlineController.signal])
    : deadlineController.signal;

  const state: RunState = {
    schema_version: 1,
    run_id: createRunId(startedAt),
    phase: "preflight",
    anthropic_agent_id: config.anthropicAgentId,
    anthropic_environment_id: config.anthropicEnvironmentId,
    started_at: startedAt.toISOString(),
    deadline: new Date(deadline).toISOString(),
    cleanup: {
      anthropic_session: "pending",
      sandbox: "pending",
    },
  };
  const store = new RunStore(join(repositoryRoot, "runs"), state);
  await store.initialize();

  const claude = new ClaudeManagedAgents(config.anthropicApiKey);
  const render = new RenderSandbox(config.renderApiKey, config.renderWorkspaceId);
  const launch = buildPublicSandboxLaunch({
    environmentId: config.anthropicEnvironmentId,
    environmentKey: config.anthropicEnvironmentKey,
  });
  let worker: WorkerProcess | undefined;
  let failure: Error | undefined;

  try {
    const baselineWorkers = await claude.preflight(
      config.anthropicAgentId,
      config.anthropicEnvironmentId,
    );
    console.log("preflight     passed");
    console.log(`policy        ${launch.policySummary}`);
    console.log(`credential    ${launch.credentialSummary}`);

    await store.update({ phase: "provision" });
    const sandbox = await render.createAndWait(
      {
        timeoutSeconds: Math.min(86_400, Math.max(300, Math.ceil(options.timeoutMs / 1000) + 120)),
        networkPolicy: launch.networkPolicy,
        env: launch.env,
      },
      async (sandboxId) => {
        state.sandbox_id = sandboxId;
        await store.save();
        console.log(`provision     ${sandboxId}`);
      },
      Math.min(deadline, Date.now() + 90_000),
    );
    throwIfAborted(signal);

    await store.update({ phase: "install" });
    await render.uploadInstallScript(
      sandbox.id,
      join(repositoryRoot, "scripts", "install-executor.sh"),
    );
    const install = await render.execBuffered(
      sandbox.id,
      "bash /tmp/install-executor.sh",
      signal,
    );
    if (install.stdout) process.stdout.write(install.stdout);
    if (install.stderr) process.stderr.write(install.stderr);
    if (install.exitCode !== 0) {
      throw new Error(`ant installation failed with exit code ${install.exitCode}`);
    }

    await store.update({ phase: "worker" });
    worker = await render.startWorker(sandbox.id, signal, [
      config.anthropicApiKey,
      config.anthropicEnvironmentKey,
      config.renderApiKey,
    ]);
    const unexpectedWorkerExit = worker.done.then((exitCode) => {
      throw new Error(`Managed Agents worker exited unexpectedly with code ${exitCode}`);
    });
    await Promise.race([
      claude.waitForWorker(
        config.anthropicEnvironmentId,
        baselineWorkers,
        Math.min(deadline, Date.now() + 60_000),
        signal,
      ),
      unexpectedWorkerExit,
    ]);
    console.log("worker        polling");

    await store.update({ phase: "session" });
    const sessionId = await claude.createSession(
      config.anthropicAgentId,
      config.anthropicEnvironmentId,
      async (id) => {
        state.anthropic_session_id = id;
        await store.save();
        console.log(`session       ${id}`);
      },
    );

    const stream = await claude.openEventStream(sessionId, signal);
    const consume = consumeSessionEvents(stream, store, [
      config.anthropicApiKey,
      config.anthropicEnvironmentKey,
      config.renderApiKey,
    ]);
    await claude.sendPrompt(sessionId, options.prompt);
    console.log("session       submitted");

    await store.update({ phase: "run" });
    const result = await Promise.race([consume, unexpectedWorkerExit]);
    await store.writeResult(result || "(Session completed without a text response.)");
    console.log(`result        ${result || "task completed"}`);

    await store.update({ phase: "outputs" });
    const outputRoot = options.outputPath ?? join(store.runDir, "output");
    const outputs = await collectOutputs(render, sandbox.id, outputRoot, signal, [
      config.anthropicApiKey,
      config.anthropicEnvironmentKey,
      config.renderApiKey,
    ]);
    console.log(`outputs       copied ${outputs.length} file(s) to ${outputRoot}`);
  } catch (error) {
    failure = errorValue(error);
  } finally {
    clearTimeout(timeout);
    worker?.abort();
    state.phase = "cleanup";
    await store.save();
    const cleanup = await cleanupRun(store, {
      deleteSession: (sessionId) => claude.interruptAndDelete(sessionId),
      terminateSandbox: (sandboxId) => render.terminate(sandboxId),
    });
    console.log(
      `cleanup       session ${cleanup.session}; sandbox ${cleanup.sandbox}`,
    );
    if (cleanup.session === "failed" || cleanup.sandbox === "failed") {
      const cleanupError = new Error("Cleanup was incomplete; run the manual commands above");
      failure = failure ? new AggregateError([failure, cleanupError]) : cleanupError;
    }
  }

  if (failure) throw failure;
}
