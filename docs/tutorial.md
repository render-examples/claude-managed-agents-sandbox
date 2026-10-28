# Run Claude Managed Agents on Render Sandboxes

> **Note:** Render Sandboxes is in early access. Claude Managed Agents is in
> beta and uses the `managed-agents-2026-04-01` API.

[Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
runs the Claude agent loop on Anthropic's infrastructure and sends each command
and file edit to a worker that you host. Render Sandboxes gives that worker an
isolated, ephemeral Linux environment in your Render workspace, with outbound
traffic denied by default.

In this tutorial, you build a coding agent that accepts a prompt, runs Claude's
commands and file edits in a Render Sandbox, and copies the output files to your
machine. The [template source](https://github.com/render-examples/claude-managed-agents-sandbox)
contains everything you run here.

Time to complete: 20 minutes

## Prerequisites

1. A Render workspace with Sandboxes enabled, a
   [Render API key](https://render.com/docs/api), and your
   workspace ID (`tea-...`).
2. Claude Managed Agents beta access and an
   [Anthropic API key](https://platform.claude.com/settings/keys).
3. An existing Managed Agent and a dedicated `self_hosted` Environment, with an
   Environment key generated in the Claude Console. The API can create an
   Environment, but it cannot generate its key.
4. [Node.js](https://nodejs.org/) 22 or later and Git.

The Managed Agent and Environment are shared configuration. The template creates
and deletes only a per-run Session.

## 1. Get the template

Clone the tagged release and install its dependencies:

```bash
git clone --branch v1.0.0 --depth 1 \
  https://github.com/render-examples/claude-managed-agents-sandbox
cd claude-managed-agents-sandbox
npm ci
```

## 2. Configure credentials

Copy the example environment file:

```bash
cp .env.example .env
```

Fill in your values:

```sh
RENDER_API_KEY=rnd_your-render-api-key
RENDER_WORKSPACE_ID=tea-your-workspace-id
ANTHROPIC_API_KEY=sk-ant-your-application-key
ANTHROPIC_AGENT_ID=your-managed-agent-id
ANTHROPIC_ENVIRONMENT_ID=your-self-hosted-environment-id
ANTHROPIC_ENVIRONMENT_KEY=your-environment-key
```

`ANTHROPIC_API_KEY` stays on your machine. Only the Environment ID and its
restricted key enter the sandbox.

## 3. Run the agent

Run the agent with a prompt:

```bash
npm run agent -- "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

The runner stops before creating anything if another worker is already polling
the Environment, so that no other worker can claim this run.

You should see Claude's activity stream to the console. Installer and worker
logs are omitted here:

```text
preflight     passed
policy        default-deny allow-list: api.anthropic.com and pinned ant release download hosts
credential    materialized restricted Anthropic Environment key; application API key excluded
provision     sbx-...
worker        polling
session       sesn_...
session       submitted
session       running
tool          write
tool          bash
agent         I created /workspace/output/server.js and confirmed it responds with "Hello, world!".
result        task completed
outputs       copied 1 file to runs/run_.../output
cleanup       session deleted; sandbox terminated
```

Claude wrote the server, tested it inside the sandbox, and the runner copied it
to your machine. Then the runner deleted the Session and terminated the sandbox.

## 4. Understand how it works

[`src/agent.ts`](https://github.com/render-examples/claude-managed-agents-sandbox/blob/v1.0.0/src/agent.ts)
runs one Session from start to finish. Simplified, the lifecycle is:

```ts
await claude.preflight(agentId, environmentId, signal);
const sandbox = await render.createAndWait(launch, saveSandboxId, deadline, signal);
await render.execBuffered(sandbox.id, "bash /tmp/install-executor.sh", signal);
worker = await render.startWorker(sandbox.id, signal, secrets);
await claude.waitForWorker(environmentId, deadline, signal);

const sessionId = await claude.createSession(agentId, environmentId, saveSessionId);
const stream = await claude.openEventStream(sessionId, signal);
await claude.sendPrompt(sessionId, prompt);
const result = await consumeSessionEvents(stream, store, secrets);
await collectOutputs(render, sandbox.id, outputRoot, signal, secrets);

// In `finally`, on success, failure, timeout, or Ctrl+C:
await cleanupRun(store, { deleteSession, terminateSandbox });
```

Here is what the key pieces do:

| Piece | Purpose |
| --- | --- |
| `claude.preflight()` | Confirms that the Agent and Environment exist, that the Environment is `self_hosted`, and that no other worker is polling it. |
| `buildPublicSandboxLaunch()` | Declares the egress allow-list and the only credential that enters the sandbox, in [`src/policy.ts`](https://github.com/render-examples/claude-managed-agents-sandbox/blob/v1.0.0/src/policy.ts). |
| `render.createAndWait()` | Creates the sandbox, records its ID immediately, and polls until it is `running`. |
| `install-executor.sh` | Mounts the PTY filesystem that the worker's bash tool needs, then installs `ant` 2.1.0 after checking its pinned SHA-256, in [`scripts/install-executor.sh`](https://github.com/render-examples/claude-managed-agents-sandbox/blob/v1.0.0/scripts/install-executor.sh). |
| `render.startWorker()` | Runs `ant beta:worker poll` as a streamed foreground command in the sandbox. |
| `claude.waitForWorker()` | Waits until the Environment's work stats show the worker polling. |
| `consumeSessionEvents()` | Logs native session events and returns Claude's final message when the Session goes idle. |
| `collectOutputs()` | Copies regular files from `/workspace/output` to your machine. |
| `cleanupRun()` | Deletes the Session and terminates the sandbox, each with its own timeout. |

Each run writes its state to `runs/<run_id>/`: `run.json` (resource IDs,
egress policy, and cleanup status, but no credentials), the native
`events.jsonl`, and `result.txt`.

## What you built

You built a coding agent that:

- Accepts a natural-language coding task
- Runs Claude's commands and file edits in an isolated Render Sandbox with
  default-deny egress
- Streams native Managed Agents session events as it works
- Copies deliverable files back to your machine and cleans up every per-run
  resource

## Security

Your Anthropic application key never enters the sandbox. Any code the agent runs
can read credentials that are present in the sandbox, so restrict the
Environment key to the worker's task and dedicate the Environment to this
example. The current Render SDK has no credential broker, so the template sets
the Environment key as a creation-time environment variable. That behavior is
isolated in `src/policy.ts`, so a broker can replace it without changing the
lifecycle.

The sandbox's egress policy is a default-deny allow-list. At run time, the
worker needs only `api.anthropic.com`. The GitHub release hosts are needed only
to download `ant`, but the SDK cannot narrow a policy after the sandbox is
created, so they stay allowed for this short-lived run. Tool inputs and outputs
pass through Anthropic, because Anthropic hosts the agent loop.

Treat every prompt as untrusted. Don't use production credentials or sensitive
source code with this example until you have reviewed its policy and
credential settings.

## Customize the agent

- **Prompt and instructions:** the runner sends your prompt as written. Change
  Claude's system prompt and tools in the Managed Agent's configuration.
- **Toolchain:** install more tools in `scripts/install-executor.sh`, and add
  their download hosts to `INSTALL_DESTINATIONS` in `src/policy.ts`.
- **Egress:** add hosts the agent needs while it works to
  `RUNTIME_DESTINATIONS` in `src/policy.ts`.
- **Lifetime:** pass `--timeout <seconds>` (the default is 600). The sandbox
  lifetime is derived from it in `src/agent.ts`.
- **Outputs:** pass `--output <path>` to copy files somewhere other than
  `runs/<run_id>/output`, or change collection in `src/outputs.ts`.

## Clean up

Cleanup runs automatically after success, failure, timeout, Ctrl+C, and
SIGTERM. The runner keeps the shared Managed Agent and Environment.

If a cleanup step fails, the runner prints the exact commands to finish it:

```bash
curl -X DELETE "https://api.anthropic.com/v1/sessions/$SESSION_ID" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01"
RENDER_WORKSPACE="$RENDER_WORKSPACE_ID" render ea sandboxes stop "$SANDBOX_ID" --confirm
```

If Session creation fails without a clear answer from the API, the runner also
prints a `reconcile` command that lists recent Sessions, so you can find and
delete one that may have been created.

## Troubleshooting

### Preflight fails

Confirm your Managed Agents beta access, the API key's permissions, and the
Agent and Environment IDs. The Environment must be `self_hosted`.

### Preflight reports a polling worker

Another worker is polling the Environment and could claim this run. Stop it, or
use a dedicated Environment.

### The worker never starts polling

Check the `[worker:stderr]` lines for authentication errors. Confirm the
Environment key belongs to the configured Environment.

### The agent produces no output files

Inspect `runs/<run_id>/events.jsonl` and `result.txt`. Output files are
optional, so prompts that need files should ask Claude to write them under
`/workspace/output`.

### Cleanup is incomplete

Run the commands that the runner printed. Delete the per-run Session and
terminate the sandbox, but not the shared Agent or Environment.

## Next steps

- [Claude Managed Agents self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
- [Claude Managed Agents event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)
- [Render Sandboxes documentation](https://render.com/docs/sandboxes)
- [Run the OpenAI Agents API on Render Sandboxes](https://render.com/docs/sandboxes/hosted-agents/openai)
- [Run Cursor Cloud Agents on Render Sandboxes](https://render.com/docs/sandboxes/hosted-agents/cursor)
- [Template source](https://github.com/render-examples/claude-managed-agents-sandbox)
