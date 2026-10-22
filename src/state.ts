import { appendFile, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export type CleanupStatus = "pending" | "complete" | "failed";

export interface RunState {
  schema_version: 1;
  run_id: string;
  phase: string;
  sandbox_id?: string;
  anthropic_session_id?: string;
  anthropic_agent_id: string;
  anthropic_environment_id: string;
  started_at: string;
  deadline: string;
  effective_egress_policy?: string[];
  ambiguous_mutation?: string;
  cleanup: {
    anthropic_session: CleanupStatus;
    sandbox: CleanupStatus;
  };
}

export function createRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `run_${stamp}_${randomBytes(3).toString("hex")}`;
}

export class RunStore {
  readonly runDir: string;
  readonly eventsPath: string;
  readonly resultPath: string;
  private readonly statePath: string;

  constructor(root: string, readonly state: RunState) {
    this.runDir = join(root, state.run_id);
    this.statePath = join(this.runDir, "run.json");
    this.eventsPath = join(this.runDir, "events.jsonl");
    this.resultPath = join(this.runDir, "result.txt");
  }

  async initialize(): Promise<void> {
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    await chmod(this.runDir, 0o700);
    await this.save();
  }

  async save(): Promise<void> {
    const tempPath = `${this.statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.statePath);
    await chmod(this.statePath, 0o600);
  }

  async update(patch: Partial<RunState>): Promise<void> {
    Object.assign(this.state, patch);
    await this.save();
  }

  async appendEvent(event: unknown): Promise<void> {
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  async writeResult(text: string): Promise<void> {
    await writeFile(this.resultPath, `${text.trimEnd()}\n`, { mode: 0o600 });
  }
}
