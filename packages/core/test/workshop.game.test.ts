/**
 * `_<mod>.info` files on the author's disk (game mods folder and Workshop downloads) come back
 * byte for byte. Without the game the test is skipped.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatWorkshopInfo, parseWorkshopInfo } from '../src/index.ts';
import { hasGame, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);

function infoFiles(): string[] {
  const out: string[] = [];
  for (const root of [join(paths.kenshi, 'mods'), paths.workshop]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = join(root, d.name);
      for (const f of readdirSync(dir)) if (/^_.*\.info$/i.test(f)) out.push(join(dir, f));
    }
  }
  return out;
}

describe.skipIf(!game)('Workshop .info files of the installed game', () => {
  it('every real .info file is rewritten byte for byte', () => {
    const files = infoFiles();
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      try {
        if (formatWorkshopInfo(parseWorkshopInfo(text).info, parseWorkshopInfo(text)) !== text) bad.push(f);
      } catch (e) {
        bad.push(`${f}: ${String(e)}`);
      }
    }
    expect(bad).toEqual([]);
    expect(files.length).toBeGreaterThan(0);
  });
});
