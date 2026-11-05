/**
 * Папка игры, выбранная в окне Kenshi Mod Editor (`settings.json` в папке данных приложения).
 * MCP-сервер берёт её, если игра не задана явно (`--game`, KENSHI_DIR, kenshi-paths.json):
 * тогда ИИ видит ту же игру, что и пользователь в окне.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Папки данных редактора: заданная `KEDIT_USER_DATA`, собранная программа, режим разработки. */
export function editorDataDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env['KEDIT_USER_DATA']) out.push(env['KEDIT_USER_DATA']);
  const appData = env['APPDATA'];
  if (appData) out.push(join(appData, 'Kenshi Mod Editor'), join(appData, '@kenshi-editor', 'desktop'));
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
      // Повреждённые настройки — просто не используем.
    }
  }
  return undefined;
}
