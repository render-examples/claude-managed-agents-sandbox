# Claude coding agent on Render Sandboxes

A one-shot coding agent: send it a prompt, and Claude Managed Agents runs the
agent loop while a worker in an ephemeral Render Sandbox runs its commands and
file edits. Files the agent writes to `/workspace/output` are copied back to
your machine.

> Render Sandboxes is in early access. Claude Managed Agents is in beta and
> uses the `managed-agents-2026-04-01` API.

Follow the tutorial:
[Run Claude Managed Agents on Render Sandboxes](https://render.com/docs/sandboxes-claude-managed-agents).

## Quickstart

You need Node.js 22+, a Render workspace with Sandboxes enabled, Claude Managed
Agents access, an existing Managed Agent, and a dedicated `self_hosted`
Environment with a Console-generated Environment key.

```bash
npm ci
cp .env.example .env   # fill in your credentials
npm run agent -- "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

Options:

```text
--timeout <seconds>  Override the 600-second deadline
--output <path>      Copy /workspace/output files to this local directory
```

Each run writes `run.json`, `events.jsonl`, and `result.txt` under
`runs/<run_id>/`. The runner deletes only its per-run Session and sandbox. It
never deletes the shared Agent or Environment.

## Verified versions

- `@anthropic-ai/sdk` 0.135.0
- `@renderinc/sdk` 1.3.0
- `ant` 2.1.0 for Linux amd64 and arm64, checked against a pinned SHA-256

## Development

```bash
npm run check   # typecheck and tests
```
