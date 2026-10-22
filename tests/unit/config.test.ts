import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, parseCli } from "../../src/config.js";

test("loadConfig reports every missing variable", () => {
  assert.throws(
    () => loadConfig({}),
    /RENDER_API_KEY.*ANTHROPIC_ENVIRONMENT_KEY/,
  );
});

test("parseCli accepts prompt, timeout, and output", () => {
  const parsed = parseCli(["build", "it", "--timeout", "12.5", "--output", "./artifacts"]);
  assert.equal(parsed.prompt, "build it");
  assert.equal(parsed.timeoutMs, 12_500);
  assert.equal(parsed.outputPath, `${process.cwd()}/artifacts`);
});
