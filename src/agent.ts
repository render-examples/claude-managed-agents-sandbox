import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliOptions, Config } from "./config.js";
import { ClaudeManagedAgents, isAmbiguousMutationError } from "./anthropic.js";
import { cleanupRun } from "./cleanup.js";
import { consumeSessionEvents } from "./events.js";
import { collectOutputs } from "./outputs.js";
import { buildPublicSandboxLaunch } from "./policy.js";
import { RenderSandbox, type WorkerProcess } from "./render.js";
import { createRunId, RunStore, type RunState } from "./state.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sourceDirectory, "..");

export interface Dependencies {
  claude?: ClaudeManagedAgents;
  render?: RenderSandbox;
  runsRoot?: string;
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function runAgent(
  config: Config,
  options: CliOptions,
  externalSignal?: AbortSignal,
  dependencies: Dependencies = {},
): Promise<void> {
  const startedAt = new Date();
  const deadline = startedAt.getTime() + options.timeoutMs;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new Error(`Run exceeded ${options.timeoutMs / 1000}s deadline`)),
    options.timeoutMs,
  );
  const runController = new AbortController();
  const signal = AbortSignal.any([
    runController.signal,
    deadlineController.signal,
    ...(externalSignal ? [externalSignal] : []),
  ]);
  const secrets = [
    config.anthropicApiKey,
    config.anthropicEnvironmentKey,
    config.renderApiKey,
  ];

  const launch = buildPublicSandboxLaunch({
    environmentId: config.anthropicEnvironmentId,
    environmentKey: config.anthropicEnvironmentKey,
  });
  const state: RunState = {
    schema_version: 1,
    run_id: createRunId(startedAt),
    phase: "preflight",
    anthropic_agent_id: config.anthropicAgentId,
    anthropic_environment_id: config.anthropicEnvironmentId,
    started_at: startedAt.toISOString(),
    deadline: new Date(deadline).toISOString(),
    effective_egress_policy: launch.egressDestinations,
    cleanup: {
      anthropic_session: "pending",
      sandbox: "pending",
    },
  };
  const store = new RunStore(dependencies.runsRoot ?? join(repositoryRoot, "runs"), state);
  await store.initialize();

  const claude = dependencies.claude ?? new ClaudeManagedAgents(config.anthropicApiKey);
  const render =
    dependencies.render ?? new RenderSandbox(config.renderApiKey, config.renderWorkspaceId);
  let worker: WorkerProcess | undefined;
  let failure: Error | undefined;

  try {
    await claude.preflight(config.anthropicAgentId, config.anthropicEnvironmentId, signal);
    console.log("preflight     passed");
    console.log(`policy        ${launch.policySummary}`);
    console.log(`credential    ${launch.credentialSummary}`);

    await store.update({ phase: "provision" });
    const sandbox = await recordAmbiguousCreate(
      store,
      render.createAndWait(
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
        signal,
      ),
      () => !state.sandbox_id,
      "Render Sandbox creation may have succeeded without returning an ID. Reconcile before retrying: render ea sandboxes list",
    );

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
    worker = await render.startWorker(sandbox.id, signal, secrets);
    const unexpectedWorkerExit = worker.done.then((exitCode) => {
      throw new Error(`Managed Agents worker exited unexpectedly with code ${exitCode}`);
    });
    void unexpectedWorkerExit.catch(() => undefined);
    await Promise.race([
      claude.waitForWorker(
        config.anthropicEnvironmentId,
        Math.min(deadline, Date.now() + 60_000),
        signal,
      ),
      unexpectedWorkerExit,
    ]);
    console.log("worker        polling");

    await store.update({ phase: "session" });
    const sessionId = await recordAmbiguousCreate(
      store,
      claude.createSession(
        config.anthropicAgentId,
        config.anthropicEnvironmentId,
        async (id) => {
          state.anthropic_session_id = id;
          await store.save();
          console.log(`session       ${id}`);
        },
      ),
      () => !state.anthropic_session_id,
      `Anthropic Session creation may have succeeded without returning an ID. Reconcile before retrying: curl -g "https://api.anthropic.com/v1/sessions?agent_id=${config.anthropicAgentId}&created_at[gte]=${state.started_at}" -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "anthropic-beta: managed-agents-2026-04-01"`,
    );
    signal.throwIfAborted();

    const stream = await claude.openEventStream(sessionId, signal);
    const consume = consumeSessionEvents(stream, store, secrets);
    void consume.catch(() => undefined);
    await claude.sendPrompt(sessionId, options.prompt);
    console.log("session       submitted");

    await store.update({ phase: "run" });
    const result = await Promise.race([consume, unexpectedWorkerExit]);
    await store.writeResult(result || "(Session completed without a text response.)");
    console.log("result        task completed");

    await store.update({ phase: "outputs" });
    const outputRoot = options.outputPath ?? join(store.runDir, "output");
    const outputs = await collectOutputs(render, sandbox.id, outputRoot, signal, secrets);
    console.log(
      `outputs       copied ${outputs.length} file${outputs.length === 1 ? "" : "s"} to ${outputRoot}`,
    );
  } catch (error) {
    failure = errorValue(signal.aborted ? signal.reason : error);
  } finally {
    clearTimeout(deadlineTimer);
    runController.abort(new Error("Run finished"));
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
    if (state.ambiguous_mutation) console.error(`reconcile     ${state.ambiguous_mutation}`);
    if (cleanup.session === "failed" || cleanup.sandbox === "failed") {
      const cleanupError = new Error("Cleanup was incomplete; run the manual commands above");
      failure = failure ? new AggregateError([failure, cleanupError]) : cleanupError;
    }
  }

  if (failure) throw failure;
}

/**
 * Records a reconciliation step when a create call fails ambiguously before
 * its resource ID was persisted.
 */
async function recordAmbiguousCreate<T>(
  store: RunStore,
  create: Promise<T>,
  idMissing: () => boolean,
  reconcile: string,
): Promise<T> {
  try {
    return await create;
  } catch (error) {
    if (idMissing() && isAmbiguousMutationError(error)) {
      await store.update({ ambiguous_mutation: reconcile });
    }
    throw error;
  }
}
