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
  const parsed = parseCli(["build", "it", "--timeout", "90", "--output", "./artifacts"]);
  assert.equal(parsed.prompt, "build it");
  assert.equal(parsed.timeoutMs, 90_000);
  assert.equal(parsed.outputPath, `${process.cwd()}/artifacts`);
});

test("parseCli rejects fractional and non-positive timeouts", () => {
  for (const value of ["12.5", "0", "-1", "abc"]) {
    assert.throws(() => parseCli(["prompt", "--timeout", value]), /positive integer/);
  }
});
