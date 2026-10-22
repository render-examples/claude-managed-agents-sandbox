import { resolve } from "node:path";

const REQUIRED_ENV = [
  "RENDER_API_KEY",
  "RENDER_WORKSPACE_ID",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AGENT_ID",
  "ANTHROPIC_ENVIRONMENT_ID",
  "ANTHROPIC_ENVIRONMENT_KEY",
] as const;

export interface Config {
  renderApiKey: string;
  renderWorkspaceId: string;
  anthropicApiKey: string;
  anthropicAgentId: string;
  anthropicEnvironmentId: string;
  anthropicEnvironmentKey: string;
}

export interface CliOptions {
  prompt: string;
  timeoutMs: number;
  outputPath?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    renderApiKey: env.RENDER_API_KEY!,
    renderWorkspaceId: env.RENDER_WORKSPACE_ID!,
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    anthropicAgentId: env.ANTHROPIC_AGENT_ID!,
    anthropicEnvironmentId: env.ANTHROPIC_ENVIRONMENT_ID!,
    anthropicEnvironmentKey: env.ANTHROPIC_ENVIRONMENT_KEY!,
  };
}

export function parseCli(argv: string[]): CliOptions {
  let timeoutSeconds = 600;
  let outputPath: string | undefined;
  const promptParts: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--timeout") {
      const value = argv[++index];
      timeoutSeconds = Number(value);
      if (!value || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error("--timeout must be a positive integer number of seconds");
      }
    } else if (arg === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a path");
      outputPath = resolve(value);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      promptParts.push(arg);
    }
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error('Usage: npm run agent -- "<prompt>" [--timeout <seconds>] [--output <path>]');
  }

  return {
    prompt,
    timeoutMs: timeoutSeconds * 1000,
    ...(outputPath ? { outputPath } : {}),
  };
}
