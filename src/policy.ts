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
  egressDestinations: string[];
  policySummary: string;
  credentialSummary: string;
}

/** Hosts the Managed Agents worker needs while the Session runs. */
export const RUNTIME_DESTINATIONS = ["api.anthropic.com"] as const;

/**
 * Hosts used only to download the pinned `ant` release. The SDK cannot narrow
 * a policy after creation, so they stay allowed for this short-lived run.
 */
export const INSTALL_DESTINATIONS = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
] as const;

export function buildPublicSandboxLaunch(credential: WorkerCredential): PublicSandboxLaunch {
  const egressDestinations = [...RUNTIME_DESTINATIONS, ...INSTALL_DESTINATIONS];
  return {
    networkPolicy: {
      type: "allow-list",
      rules: egressDestinations.map((domain) => ({ domain, protocol: "https" })),
    },
    env: {
      ANTHROPIC_ENVIRONMENT_ID: credential.environmentId,
      ANTHROPIC_ENVIRONMENT_KEY: credential.environmentKey,
    },
    egressDestinations,
    policySummary:
      "default-deny allow-list: api.anthropic.com and pinned ant release download hosts",
    credentialSummary:
      "materialized restricted Anthropic Environment key; application API key excluded",
  };
}
