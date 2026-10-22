import type { RunStore } from "./state.js";

export interface CleanupDependencies {
  deleteSession(sessionId: string): Promise<void>;
  terminateSandbox(sandboxId: string): Promise<void>;
}

export interface CleanupResult {
  session: "not-created" | "deleted" | "failed";
  sandbox: "not-created" | "terminated" | "failed";
}

export interface CleanupTimeouts {
  sessionMs: number;
  sandboxMs: number;
}

/** Session deletion may wait up to 30 seconds for an interrupt to settle. */
const DEFAULT_TIMEOUTS: CleanupTimeouts = { sessionMs: 60_000, sandboxMs: 30_000 };

export async function cleanupRun(
  store: RunStore,
  dependencies: CleanupDependencies,
  timeouts: CleanupTimeouts = DEFAULT_TIMEOUTS,
): Promise<CleanupResult> {
  const result: CleanupResult = {
    session: store.state.anthropic_session_id ? "failed" : "not-created",
    sandbox: store.state.sandbox_id ? "failed" : "not-created",
  };
  if (!store.state.anthropic_session_id) store.state.cleanup.anthropic_session = "complete";
  if (!store.state.sandbox_id) store.state.cleanup.sandbox = "complete";

  if (store.state.anthropic_session_id) {
    try {
      await withTimeout(
        dependencies.deleteSession(store.state.anthropic_session_id),
        timeouts.sessionMs,
        "Session deletion",
      );
      store.state.cleanup.anthropic_session = "complete";
      result.session = "deleted";
    } catch (error) {
      store.state.cleanup.anthropic_session = "failed";
      console.error(`cleanup       session failed: ${errorMessage(error)}`);
      console.error(
        `manual        curl -X DELETE "https://api.anthropic.com/v1/sessions/${store.state.anthropic_session_id}" -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "anthropic-beta: managed-agents-2026-04-01"`,
      );
    }
    await store.save();
  }

  if (store.state.sandbox_id) {
    try {
      await withTimeout(
        dependencies.terminateSandbox(store.state.sandbox_id),
        timeouts.sandboxMs,
        "Sandbox termination",
      );
      store.state.cleanup.sandbox = "complete";
      result.sandbox = "terminated";
    } catch (error) {
      store.state.cleanup.sandbox = "failed";
      console.error(`cleanup       sandbox failed: ${errorMessage(error)}`);
      console.error(`manual        render ea sandboxes stop ${store.state.sandbox_id} --confirm`);
    }
    await store.save();
  }

  return result;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
