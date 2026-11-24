/**
 * Game folder chosen in the Cactus window (`settings.json` in the app data folder).
 * The MCP server takes it if the game is not given explicitly (`--game`, KENSHI_DIR, kenshi-paths.json):
 * then the AI sees the same game as the user in the window.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Editor data folders: the given `KEDIT_USER_DATA`, the built program, dev mode. */
export function editorDataDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env['KEDIT_USER_DATA']) out.push(env['KEDIT_USER_DATA']);
  const appData = env['APPDATA'];
  if (appData) out.push(join(appData, 'Cactus'), join(appData, 'Kenshi Mod Editor'), join(appData, '@kenshi-editor', 'desktop'));
  return out;
}

export function editorGameDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of editorDataDirs(env)) {
    const file = join(dir, 'settings.json');
    if (!existsSync(file)) continue;
    try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as { gameDir?: unknown };
      if (typeof s.gameDir === 'string' && s.gameDir) return s.gameDir;
    } catch {
      // Corrupted settings — just not used.
    }
  }
  return undefined;
}
