import Anthropic from "@anthropic-ai/sdk";
import { setTimeout as sleep } from "node:timers/promises";

const CLEANUP_REQUEST = { timeout: 15_000, maxRetries: 1 } as const;

/** Anthropic errors expose `status`; Render SDK errors expose `statusCode`. */
function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  if (typeof status === "number") return status;
  return typeof statusCode === "number" ? statusCode : undefined;
}

/**
 * True when a failed mutation may still have taken effect on the server, so its
 * resource must be reconciled before retrying.
 */
export function isAmbiguousMutationError(error: unknown): boolean {
  const status = statusCode(error);
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
}

export class ClaudeManagedAgents {
  readonly client: Anthropic;

  constructor(apiKey: string, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey });
  }

  async preflight(agentId: string, environmentId: string, signal: AbortSignal): Promise<void> {
    const [agent, environment, stats] = await Promise.all([
      this.client.beta.agents.retrieve(agentId, {}, { signal }),
      this.client.beta.environments.retrieve(environmentId, {}, { signal }),
      this.client.beta.environments.work.stats(environmentId, {}, { signal }),
    ]);

    if (agent.archived_at) throw new Error(`Configured Agent ${agentId} is archived`);
    if (environment.archived_at) {
      throw new Error(`Configured Environment ${environmentId} is archived`);
    }
    if (environment.config.type !== "self_hosted") {
      throw new Error(`Configured Environment ${environmentId} is not self_hosted`);
    }

    const workers = stats.workers_polling ?? 0;
    if (workers > 0) {
      throw new Error(
        `Environment ${environmentId} already has ${workers} polling worker(s); use a dedicated Environment so this run cannot be claimed elsewhere`,
      );
    }
  }

  async waitForWorker(environmentId: string, deadline: number, signal: AbortSignal): Promise<void> {
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const stats = await this.client.beta.environments.work.stats(environmentId, {}, { signal });
      if ((stats.workers_polling ?? 0) > 0) return;
      await sleep(1_000, undefined, { signal });
    }
    throw new Error(`Timed out waiting for a worker to poll Environment ${environmentId}`);
  }

  async createSession(
    agentId: string,
    environmentId: string,
    onCreated: (sessionId: string) => Promise<void>,
  ): Promise<string> {
    // Session creation has no idempotency key, so a retry could create a
    // second, untracked Session.
    const session = await this.client.beta.sessions.create(
      { agent: agentId, environment_id: environmentId },
      { maxRetries: 0 },
    );
    await onCreated(session.id);
    return session.id;
  }

  async openEventStream(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>> {
    return await this.client.beta.sessions.events.stream(sessionId, {}, { signal });
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    // A retried send could deliver the prompt twice.
    await this.client.beta.sessions.events.send(
      sessionId,
      {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: prompt }],
          },
        ],
      },
      { maxRetries: 0 },
    );
  }

  async interruptAndDelete(sessionId: string): Promise<void> {
    let session;
    try {
      session = await this.client.beta.sessions.retrieve(sessionId, {}, CLEANUP_REQUEST);
    } catch (error) {
      if (statusCode(error) === 404) return;
      throw error;
    }

    if (session.status === "running" || session.status === "rescheduling") {
      await this.client.beta.sessions.events.send(
        sessionId,
        { events: [{ type: "user.interrupt" }] },
        CLEANUP_REQUEST,
      );

      const interruptDeadline = Date.now() + 30_000;
      while (Date.now() < interruptDeadline) {
        session = await this.client.beta.sessions.retrieve(sessionId, {}, CLEANUP_REQUEST);
        if (session.status === "idle" || session.status === "terminated") break;
        await sleep(500);
      }
    }

    if (session.status === "running" || session.status === "rescheduling") {
      throw new Error(`Session ${sessionId} did not become idle after interrupt`);
    }
    await this.client.beta.sessions.delete(sessionId, {}, CLEANUP_REQUEST);
  }
}
