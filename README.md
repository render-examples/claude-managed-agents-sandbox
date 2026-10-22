# Claude coding agent on Render Sandboxes

Build a one-shot coding agent that accepts a prompt, uses Claude Managed Agents
for the agent loop, and executes commands in an ephemeral Render Sandbox.

Claude Managed Agents is beta and requires the
`managed-agents-2026-04-01` API. Render Sandboxes is early access.

See the [Render tutorial](https://render.com/docs/sandboxes/hosted-agents/claude-managed-agents).
Its publication source is in [`docs/tutorial.md`](docs/tutorial.md).

## Quickstart

Requirements:

- Node.js 20 or newer
- Render Sandbox access, API key, and workspace ID
- Claude Managed Agents access and application API key
- An existing Managed Agent
- An existing `self_hosted` Environment and Console-generated Environment key

```bash
cp .env.example .env
npm ci
npm run agent -- \
  "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

Optional flags:

```text
--timeout <seconds>  Override the 600-second deadline
--output <path>      Copy /workspace/output files to this local directory
```

Each run writes mode-`0600` state and native events under `runs/<run_id>/`.
The configured Agent and Environment are retained. The runner interrupts and
deletes only its per-run Session, then idempotently terminates its Sandbox.

## Verified versions

- `@anthropic-ai/sdk` 0.135.0
- `@renderinc/sdk` 1.3.0
- `ant` 2.1.0, installed from Anthropic's GitHub release with a pinned SHA-256
  for Linux amd64 and arm64

## Security and compatibility

`ANTHROPIC_API_KEY` remains in the local process. Only
`ANTHROPIC_ENVIRONMENT_ID` and the restricted
`ANTHROPIC_ENVIRONMENT_KEY` enter the Sandbox.

The current Render SDK supports a default-deny hostname allow-list, which this
repository applies to Anthropic and the pinned worker download hosts. It does
not yet expose a public credential-broker field. `src/policy.ts` therefore
isolates the temporary creation-time environment-variable injection. The
Environment key is materialized and can be read by code running in the same
Sandbox; use a dedicated, restricted Environment.

## Development

```bash
npm run typecheck
npm test
```

Implementation entry points:

- `src/agent.ts` — native lifecycle and cleanup
- `src/anthropic.ts` — Managed Agents beta resources
- `src/render.ts` — asynchronous Sandbox and streamed exec operations
- `src/policy.ts` — egress and credential compatibility seam
- `src/outputs.ts` — regular-file collection from `/workspace/output`
