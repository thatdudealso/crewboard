#!/usr/bin/env node
import { run } from '../src/cli.js';

try {
  await run(process.argv.slice(2));
} catch (error) {
  if (process.argv.includes('--json')) process.stderr.write(`${JSON.stringify({ error: { message: error.message } })}\n`);
  else process.stderr.write(`crewboard: ${error.message}\n`);
  process.exitCode = 1;
}
