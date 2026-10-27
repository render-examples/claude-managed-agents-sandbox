export interface EventSink {
  appendEvent(event: unknown): Promise<void>;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;
}

export function redactSecrets(value: unknown, secrets: readonly string[]): unknown {
  const active = secrets.filter(Boolean);
  if (typeof value === "string") {
    return active.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, active));
  const record = asRecord(value);
  if (!record) return value;

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, redactSecrets(entry, active)]),
  );
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const item = asRecord(block);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("");
}

function errorMessage(event: UnknownRecord): string {
  const error = asRecord(event.error);
  return typeof error?.message === "string" ? error.message : "unknown session error";
}

/**
 * A self-hosted Session goes idle with `requires_action` while the worker runs
 * each built-in tool call. Only allowed `agent.tool_use` events are resolved by
 * the worker; custom tools and tool confirmations would block forever.
 */
function blockedOnWorker(stopReason: UnknownRecord, workerToolUseIds: ReadonlySet<string>): boolean {
  const ids = stopReason.event_ids;
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((id) => typeof id === "string" && workerToolUseIds.has(id))
  );
}

export async function consumeSessionEvents(
  stream: AsyncIterable<unknown>,
  sink: EventSink,
  secrets: readonly string[],
): Promise<string> {
  let finalText = "";
  const workerToolUseIds = new Set<string>();

  for await (const rawEvent of stream) {
    const event = asRecord(rawEvent);
    await sink.appendEvent(redactSecrets(rawEvent, secrets));
    if (!event || typeof event.type !== "string") continue;

    switch (event.type) {
      case "agent.message": {
        const text = textFromContent(event.content);
        if (text) {
          finalText = text;
          process.stdout.write(`agent         ${text}\n`);
        }
        break;
      }
      case "agent.tool_use":
        if (typeof event.id === "string" && event.evaluated_permission !== "ask") {
          workerToolUseIds.add(event.id);
        }
      // falls through
      case "agent.custom_tool_use": {
        const name = typeof event.name === "string" ? event.name : "tool";
        process.stdout.write(`tool          ${name}\n`);
        break;
      }
      case "session.status_running":
        process.stdout.write("session       running\n");
        break;
      case "session.status_rescheduled":
        process.stdout.write("session       rescheduled\n");
        break;
      case "session.usage":
        process.stdout.write(`usage         ${JSON.stringify(redactSecrets(rawEvent, secrets))}\n`);
        break;
      case "session.error":
        throw new Error(`Claude Managed Agents session error: ${errorMessage(event)}`);
      case "session.status_terminated":
        throw new Error("Claude Managed Agents session terminated before completion");
      case "session.status_idle": {
        const stopReason = asRecord(event.stop_reason);
        const reason = typeof stopReason?.type === "string" ? stopReason.type : "unknown";
        if (reason === "requires_action" && blockedOnWorker(stopReason!, workerToolUseIds)) {
          break;
        }
        if (reason !== "end_turn") {
          throw new Error(`Claude Managed Agents session stopped: ${reason}`);
        }
        return finalText;
      }
    }
  }

  throw new Error("Claude Managed Agents event stream ended before session became idle");
}
