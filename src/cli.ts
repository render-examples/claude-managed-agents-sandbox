import "dotenv/config";
import { runAgent } from "./agent.js";
import { loadConfig, parseCli } from "./config.js";

const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.error(`\nsignal        ${signal}; cleaning up`);
    process.exitCode = 1;
    controller.abort(new Error(`Received ${signal}`));
  });
}

try {
  const options = parseCli(process.argv.slice(2));
  const config = loadConfig();
  await runAgent(config, options, controller.signal);
} catch (error) {
  if (error instanceof AggregateError) {
    for (const item of error.errors) {
      console.error(`error         ${item instanceof Error ? item.message : String(item)}`);
    }
  } else {
    console.error(`error         ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
