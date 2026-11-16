#!/usr/bin/env node
// Node ≥ 22.18 runs .ts without a build step (type stripping).
import { main } from '../src/main.ts';

// `kedit ... | head`: the reader closed the pipe — exit quietly.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

process.exitCode = await main(process.argv.slice(2));
