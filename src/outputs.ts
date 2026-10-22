import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { BufferedExecResult } from "./render.js";

export interface OutputSandbox {
  execBuffered(
    sandboxId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<BufferedExecResult>;
  download(sandboxId: string, path: string, signal?: AbortSignal): Promise<Uint8Array>;
}

const OUTPUT_ROOT = "/workspace/output";

export async function collectOutputs(
  sandbox: OutputSandbox,
  sandboxId: string,
  localRoot: string,
  signal?: AbortSignal,
  secrets: readonly string[] = [],
): Promise<string[]> {
  const listing = await sandbox.execBuffered(
    sandboxId,
    `if [ -d ${OUTPUT_ROOT} ]; then find ${OUTPUT_ROOT} -type f -print0 | base64 -w0; fi`,
    signal,
  );
  if (listing.exitCode !== 0) {
    throw new Error(`Unable to list ${OUTPUT_ROOT}: ${listing.stderr.trim()}`);
  }
  if (!listing.stdout.trim()) return [];

  const decoded = Buffer.from(listing.stdout.trim(), "base64");
  const remotePaths = decoded
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const copied: string[] = [];

  for (const remotePath of remotePaths) {
    const relative = posix.relative(OUTPUT_ROOT, remotePath);
    if (!relative || relative.startsWith("../") || posix.isAbsolute(relative)) {
      throw new Error(`Refusing output path outside ${OUTPUT_ROOT}: ${remotePath}`);
    }
    const localPath = join(localRoot, ...relative.split("/"));
    const data = await sandbox.download(sandboxId, remotePath, signal);
    for (const secret of secrets.filter(Boolean)) {
      if (Buffer.from(data).includes(Buffer.from(secret))) {
        throw new Error(`Refusing to copy ${relative}: it contains configured secret material`);
      }
    }
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, data);
    copied.push(relative);
  }

  return copied;
}
