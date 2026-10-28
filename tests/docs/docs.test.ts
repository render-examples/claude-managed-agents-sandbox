import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

const root = process.cwd();

test("documentation and example configuration use the implemented variables", async () => {
  const [example, readme] = await Promise.all([
    readFile(join(root, ".env.example"), "utf8"),
    readFile(join(root, "README.md"), "utf8"),
  ]);
  const names = [
    "RENDER_API_KEY",
    "RENDER_WORKSPACE_ID",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AGENT_ID",
    "ANTHROPIC_ENVIRONMENT_ID",
    "ANTHROPIC_ENVIRONMENT_KEY",
  ];

  for (const name of names) {
    assert.match(example, new RegExp(`^${name}=`, "m"));
  }
  assert.match(readme, /npm run agent --/);
  assert.match(readme, /managed-agents-2026-04-01/);
});

test("the worker installer pins a version and both Linux checksums", async () => {
  const installer = await readFile(join(root, "scripts", "install-executor.sh"), "utf8");
  assert.match(installer, /VERSION="2\.1\.0"/);
  assert.match(installer, /32d15351a159b0b882aa42e1a47183b3a3d1fec1056d1a874e324bc582dd87b9/);
  assert.match(installer, /5f91d98884a8c15ca9f197a900128c66138fb06dcf900d4ee744fdd31dfdb687/);
  assert.match(installer, /sha256sum --check/);
});
