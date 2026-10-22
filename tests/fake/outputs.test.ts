import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { collectOutputs, type OutputSandbox } from "../../src/outputs.js";

test("collectOutputs downloads regular files and preserves relative paths", async () => {
  const root = join(process.cwd(), ".test-tmp", `outputs-${process.pid}-${Date.now()}`);
  const paths = ["/workspace/output/app.ts", "/workspace/output/nested/readme.md"];
  const listing = Buffer.from(`${paths.join("\0")}\0`).toString("base64");
  const sandbox: OutputSandbox = {
    execBuffered: async () => ({ stdout: listing, stderr: "", exitCode: 0 }),
    download: async (_id, path) => Buffer.from(`contents:${path}`),
  };

  try {
    const copied = await collectOutputs(sandbox, "sbx-test", root);
    assert.deepEqual(copied, ["app.ts", "nested/readme.md"]);
    assert.equal(
      await readFile(join(root, "nested", "readme.md"), "utf8"),
      "contents:/workspace/output/nested/readme.md",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collectOutputs refuses artifacts containing configured secrets", async () => {
  const root = join(process.cwd(), ".test-tmp", `secret-output-${process.pid}-${Date.now()}`);
  const listing = Buffer.from("/workspace/output/leak.txt\0").toString("base64");
  const sandbox: OutputSandbox = {
    execBuffered: async () => ({ stdout: listing, stderr: "", exitCode: 0 }),
    download: async () => Buffer.from("leaked-worker-secret"),
  };

  try {
    await assert.rejects(
      collectOutputs(sandbox, "sbx-test", root, undefined, ["worker-secret"]),
      /contains configured secret material/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
