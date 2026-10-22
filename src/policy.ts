import type { SandboxNetworkPolicy } from "@renderinc/sdk/experimental";

/**
 * Compatibility seam for Render's intended credential broker launch API.
 *
 * @renderinc/sdk 1.3.0 exposes the hostname allow-list used below, but only
 * ordinary creation-time environment variables for credentials. This example
 * therefore materializes only the restricted Anthropic Environment
 * credential. Replace the env portion when a public broker field ships; do not
 * add guessed fields to SandboxCreateInput.
 */
export interface WorkerCredential {
  environmentId: string;
  environmentKey: string;
}

export interface PublicSandboxLaunch {
  networkPolicy: SandboxNetworkPolicy;
  env: Record<string, string>;
  policySummary: string;
  credentialSummary: string;
}

export function buildPublicSandboxLaunch(credential: WorkerCredential): PublicSandboxLaunch {
  return {
    networkPolicy: {
      type: "allow-list",
      rules: [
        { domain: "api.anthropic.com", protocol: "https" },
        { domain: "github.com", protocol: "https" },
        { domain: "release-assets.githubusercontent.com", protocol: "https" },
        { domain: "objects.githubusercontent.com", protocol: "https" },
      ],
    },
    env: {
      ANTHROPIC_ENVIRONMENT_ID: credential.environmentId,
      ANTHROPIC_ENVIRONMENT_KEY: credential.environmentKey,
    },
    policySummary:
      "default-deny allow-list: api.anthropic.com and pinned ant release download hosts",
    credentialSummary:
      "materialized restricted Anthropic Environment key; application API key excluded",
  };
}
