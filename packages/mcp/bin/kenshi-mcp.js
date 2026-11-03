#!/usr/bin/env node
// MCP-сервер по stdio. Node ≥ 22.18 запускает .ts без сборки (type stripping).
// В stdout — только протокол; сообщения — в stderr.
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultWorkshopDir, resolveGamePaths } from '@kenshi-editor/core/node';
import { createServer, Session } from '../src/index.ts';

const { values } = parseArgs({
  options: {
    game: { type: 'string' },
    mod: { type: 'string' },
    deps: { type: 'string' },
  },
  strict: true,
});

const paths = values.game ? { kenshi: values.game, workshop: defaultWorkshopDir(values.game) } : resolveGamePaths(process.cwd(), process.env);
const session = new Session(paths, process.cwd());
if (values.mod !== undefined) {
  const dependencies = values.deps?.split(',').map((s) => s.trim()).filter(Boolean);
  const r = session.open({ mod: values.mod, ...(dependencies ? { dependencies } : {}) });
  process.stderr.write(`kenshi-mcp: открыт ${r.path ?? r.ctx.modName}\n`);
}

await createServer(session).connect(new StdioServerTransport());
