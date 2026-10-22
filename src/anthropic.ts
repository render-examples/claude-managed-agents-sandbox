import Anthropic from "@anthropic-ai/sdk";

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Run aborted");
  }
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export class ClaudeManagedAgents {
  readonly client: Anthropic;

  constructor(apiKey: string, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey });
  }

  async preflight(agentId: string, environmentId: string): Promise<number> {
    const [agent, environment, stats] = await Promise.all([
      this.client.beta.agents.retrieve(agentId),
      this.client.beta.environments.retrieve(environmentId),
      this.client.beta.environments.work.stats(environmentId),
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
    return workers;
  }

  async waitForWorker(
    environmentId: string,
    baselineWorkers: number,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const stats = await this.client.beta.environments.work.stats(environmentId);
      if ((stats.workers_polling ?? 0) > baselineWorkers) return;
      await sleep(1_000);
    }
    throw new Error(`Timed out waiting for a worker to poll Environment ${environmentId}`);
  }

  async createSession(
    agentId: string,
    environmentId: string,
    onCreated: (sessionId: string) => Promise<void>,
  ): Promise<string> {
    const session = await this.client.beta.sessions.create({
      agent: agentId,
      environment_id: environmentId,
    });
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
    await this.client.beta.sessions.events.send(sessionId, {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: prompt }],
        },
      ],
    });
  }

  async interruptAndDelete(sessionId: string): Promise<void> {
    let session;
    try {
      session = await this.client.beta.sessions.retrieve(sessionId);
    } catch (error) {
      if (statusCode(error) === 404) return;
      throw error;
    }

    if (session.status === "running" || session.status === "rescheduling") {
      await this.client.beta.sessions.events.send(sessionId, {
        events: [{ type: "user.interrupt" }],
      });

      const interruptDeadline = Date.now() + 30_000;
      while (Date.now() < interruptDeadline) {
        session = await this.client.beta.sessions.retrieve(sessionId);
        if (session.status === "idle" || session.status === "terminated") break;
        await sleep(500);
      }
    }

    if (session.status === "running" || session.status === "rescheduling") {
      throw new Error(`Session ${sessionId} did not become idle after interrupt`);
    }
    await this.client.beta.sessions.delete(sessionId);
  }
}
