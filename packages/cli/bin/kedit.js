#!/usr/bin/env node
// Node ≥ 22.18 запускает .ts без сборки (type stripping).
import { main } from '../src/main.ts';

// `kedit ... | head`: читатель закрыл канал — тихо выходим.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

process.exitCode = await main(process.argv.slice(2));
