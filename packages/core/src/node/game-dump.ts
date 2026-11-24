/**
 * World dump of the Kenshi Bridge plugin on disk (see `world/game-dump.ts` for the formats).
 * The plugin writes to `%LOCALAPPDATA%\KenshiBridge\world`; `KENSHI_BRIDGE_DUMP` overrides the
 * folder for both the plugin and the editor.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dumpFileName, parseDumpFileName } from '../world/game-dump.ts';

/** Bigger than this is not a zone file of the dump. */
const MAX_DUMP_FILE = 64 * 1024 * 1024;

export interface GameDumpZone {
  x: number;
  y: number;
  /** Size + modification time: changes when the plugin rewrites the file. */
  stamp: string;
}

export interface GameDumpIndex {
  /** Folder of the dump, or '' when the place is unknown (no LOCALAPPDATA). */
  dir: string;
  foliage: GameDumpZone[];
  buildings: GameDumpZone[];
}

/** Folder the plugin dumps to, or undefined when it cannot be told. */
export function gameDumpDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const set = env['KENSHI_BRIDGE_DUMP'];
  if (set) return set;
  const local = env['LOCALAPPDATA'];
  return local ? join(local, 'KenshiBridge', 'world') : undefined;
}

/** Which zones the dump holds. A missing folder is an empty dump. */
export function listGameDump(dir: string | undefined = gameDumpDir()): GameDumpIndex {
  const out: GameDumpIndex = { dir: dir ?? '', foliage: [], buildings: [] };
  if (!dir || !existsSync(dir)) return out;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const z = parseDumpFileName(name);
    if (!z) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile() || st.size > MAX_DUMP_FILE) continue;
      out[z.kind].push({ x: z.x, y: z.y, stamp: `${st.size}:${Math.round(st.mtimeMs)}` });
    } catch {
      // deleted meanwhile
    }
  }
  return out;
}

/** Bytes of one zone file of the dump, or null. */
export function readGameDumpFile(kind: 'foliage' | 'buildings', x: number, y: number, dir: string | undefined = gameDumpDir()): Uint8Array | null {
  if (!dir || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 63 || y > 63) return null;
  const full = join(dir, dumpFileName(kind, x, y));
  try {
    if (!existsSync(full) || statSync(full).size > MAX_DUMP_FILE) return null;
    return readFileSync(full);
  } catch {
    return null;
  }
}
