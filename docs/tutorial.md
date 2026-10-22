# Build a coding agent with Claude Managed Agents and Render Sandboxes

In this tutorial, you build a coding agent that accepts a prompt, streams
Claude's work, and returns its response and output files.

Anthropic runs the Claude agent loop through Claude Managed Agents. A Managed
Agents worker runs the coding agent's commands and file edits in an isolated
Render Sandbox in your Render workspace.

You will learn how to:

- connect a Claude Managed Agents Session to a worker in a Render Sandbox;
- send a coding task as a prompt and follow native session events;
- copy files the agent writes to `/workspace/output`; and
- clean up the Session and sandbox without deleting shared configuration.

Time to complete: about 20 minutes.

## Prerequisites

You need:

- A Render workspace with Render Sandboxes enabled
- A Render API key and workspace ID
- Claude Managed Agents beta access
- An Anthropic application API key
- An existing Managed Agent
- An existing self-hosted Environment and Environment key
- Node.js 20 or newer and Git

The Managed Agent and self-hosted Environment are shared configuration. This
template creates and deletes only the per-run Session.

Claude Managed Agents is beta and currently uses the
`managed-agents-2026-04-01` beta API. Generate the Environment key in the Claude
Console; the API can create an Environment but does not generate its key.

## Get the template

```bash
git clone --branch v1.0.0 --depth 1 \
  https://github.com/render-examples/claude-managed-agents-sandbox
cd claude-managed-agents-sandbox
npm ci
```

## Configure credentials

Copy the example environment file:

```bash
cp .env.example .env
```

Set:

```text
RENDER_API_KEY=
RENDER_WORKSPACE_ID=
ANTHROPIC_API_KEY=
ANTHROPIC_AGENT_ID=
ANTHROPIC_ENVIRONMENT_ID=
ANTHROPIC_ENVIRONMENT_KEY=
```

`ANTHROPIC_API_KEY` stays with the application. Only the restricted Environment
ID and key enter the sandbox. The current public Render SDK materializes that
key as a creation-time environment variable; see the compatibility note below.

## Run the coding agent

Make sure another worker is not polling the example Environment, then run:

```bash
npm run agent -- "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

Expected summary:

```text
preflight     passed
provision     sbx-...
worker        polling
session       submitted
agent         created and tested the server
result        task completed
outputs       copied 1 file to runs/run_.../output
cleanup       session deleted; sandbox terminated
```

## What happened

The template:

1. Checks the configured Managed Agent and self-hosted Environment.
2. Creates a Render Sandbox with the required egress policy.
3. Starts the Managed Agents worker for the configured Environment.
4. Confirms worker readiness through Anthropic's Environment work stats.
5. Creates a Session targeting the configured Agent and Environment.
6. Opens the native session event stream and sends your prompt.
7. Streams the final result and copies files from `/workspace/output`.
8. Deletes the per-run Session and terminates the Render Sandbox.

The implementation uses Anthropic's native Agent, Environment, work, Session,
and event APIs directly. It does not use a cross-provider adapter.

## How the template is organized

- [`src/agent.ts`](../src/agent.ts) coordinates the one-shot lifecycle.
- [`src/anthropic.ts`](../src/anthropic.ts) uses native Managed Agents beta
  resources and Environment work stats.
- [`src/render.ts`](../src/render.ts) preserves Render's asynchronous creation,
  streamed exec, in-memory download, and idempotent termination semantics.
- [`src/policy.ts`](../src/policy.ts) contains the egress and credential
  compatibility seam.
- [`src/outputs.ts`](../src/outputs.ts) lists regular files in
  `/workspace/output` and writes downloaded bytes locally.
- [`scripts/install-executor.sh`](../scripts/install-executor.sh) installs
  `ant` 2.1.0 after checking the pinned Linux amd64 or arm64 SHA-256.

## What you built

You built a one-shot Claude runner that accepts a prompt, routes one Managed
Agents Session to a worker in a Render Sandbox, streams native session events,
and copies optional output files back to your machine.

## Security

The Anthropic application key never enters the sandbox. Code the agent runs can
read any credential materialized in the same sandbox, so the Environment key
must be restricted to the worker's task and the Environment should be dedicated
to this example.

The Render egress policy is a default-deny hostname allow-list for
`api.anthropic.com` and the pinned GitHub release download hosts. Tool inputs
and outputs pass through Anthropic because Anthropic hosts the agent loop.

`@renderinc/sdk` 1.3.0 exposes this hostname policy but does not expose a public
credential-broker field. The template therefore injects only the restricted
Environment credential with the SDK's documented `env` field. This behavior is
isolated in `src/policy.ts` so a public broker field can replace it without
changing the agent lifecycle. No unverified SDK fields are used.

Do not use production credentials or sensitive source code with this example
until you have reviewed its policy and credential settings.

## Customize the template

You can change:

- prompt handling in `src/agent.ts`;
- the worker version and installation in `scripts/install-executor.sh`;
- the sandbox lifetime in `src/agent.ts` and egress policy in `src/policy.ts`;
  and
- output collection in `src/outputs.ts`.

## Clean up

Cleanup runs automatically on success, failure, timeout, SIGINT, and SIGTERM.
If cleanup is incomplete, the command prints the Anthropic Session ID, Render
Sandbox ID, and exact manual cleanup commands.

The template retains the shared Managed Agent and self-hosted Environment.

## Troubleshooting

### The Agent or Environment cannot be read

Confirm Managed Agents beta access, application-key permissions, and the
configured IDs.

### The worker never starts polling

Check the worker stream, Environment key, Environment ID, and egress policy.

### The Session stays queued

Confirm the Render worker is the intended worker for this Environment and that
another worker has not claimed the work.

### The agent produces no output files

Inspect `runs/<run_id>/events.jsonl` and the final result. Output files are
optional; prompts that need files should tell Claude to write them under
`/workspace/output`.

### Cleanup is incomplete

Run the commands printed by the agent runner. Delete the per-run Session and terminate
the Render Sandbox. Do not delete the shared Agent or Environment.

The fallback commands use:

```bash
curl -X DELETE "https://api.anthropic.com/v1/sessions/$SESSION_ID" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01"
render ea sandboxes stop "$SANDBOX_ID" --confirm
```

## Next steps

- [Claude Managed Agents self-hosted sandbox documentation](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
- [Claude Managed Agents session event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)
- [Render Sandboxes documentation](https://render.com/docs/sandboxes)
- [Template source](https://github.com/render-examples/claude-managed-agents-sandbox)
