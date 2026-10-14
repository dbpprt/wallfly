import { runCli } from '../cli/index.js';

// Keep the original entry point on the same configuration and pidfile path.
process.exitCode = await runCli(['start']);
