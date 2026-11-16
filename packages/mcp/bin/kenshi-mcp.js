#!/usr/bin/env node
// MCP server over stdio. Node ≥ 22.18 runs .ts without a build step (type stripping).
// stdout carries only the protocol; messages go to stderr.
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultWorkshopDir, resolveGamePaths } from '@kenshi-editor/core/node';
import { createServer, editorGameDir, Session } from '../src/index.ts';

const { values } = parseArgs({
  options: {
    game: { type: 'string' },
    mod: { type: 'string' },
    deps: { type: 'string' },
  },
  strict: true,
});

const paths = values.game ? { kenshi: values.game, workshop: defaultWorkshopDir(values.game) } : resolveGamePaths(process.cwd(), process.env, { preferred: editorGameDir() });
const session = new Session(paths, process.cwd());
if (values.mod !== undefined) {
  const dependencies = values.deps?.split(',').map((s) => s.trim()).filter(Boolean);
  const r = session.open({ mod: values.mod, ...(dependencies ? { dependencies } : {}) });
  process.stderr.write(`kenshi-mcp: opened ${r.path ?? r.ctx.modName}\n`);
}

await createServer(session).connect(new StdioServerTransport());
