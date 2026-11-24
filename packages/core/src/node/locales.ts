/**
 * Game translations in `<Kenshi>/locale/<code>/`. Not every folder is a full translation:
 * `en_GB` holds only the `gamedata.pot` template, and some `gamedata.po` files carry no record
 * names at all (`fr_FR` has its texts only in `fr_FR.translation`). The "data language" is the
 * locale whose record names and texts the tools show next to the English originals.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GamePaths } from './paths.ts';

export interface GameLocale {
  /** Folder name, e.g. `de_DE`. */
  code: string;
  /** `gamedata.po` exists: record names and some fields. */
  names: boolean;
  /** `<code>.translation` exists: dialogue lines and other texts. */
  texts: boolean;
}

export function localeDir(paths: GamePaths, code: string): string {
  return join(paths.kenshi, 'locale', code);
}

/** Locale folders of the game that hold a translation (`gamedata.po` or `<code>.translation`). */
export function listGameLocales(paths: GamePaths): GameLocale[] {
  const root = join(paths.kenshi, 'locale');
  let dirs: string[];
  try {
    dirs = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
  } catch {
    return [];
  }
  const out: GameLocale[] = [];
  for (const code of dirs.sort()) {
    const names = existsSync(join(root, code, 'gamedata.po'));
    const texts = existsSync(join(root, code, `${code}.translation`));
    if (names || texts) out.push({ code, names, texts });
  }
  return out;
}

/** `language=` from the game's `settings.cfg` (the language the game itself runs in). */
export function gameLanguage(paths: GamePaths): string | undefined {
  try {
    const text = readFileSync(join(paths.kenshi, 'settings.cfg'), 'utf8');
    const m = /^\s*language\s*=\s*(\S+)\s*$/im.exec(text);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** Values that mean "no translation, show only the English originals". */
const NONE = new Set(['', 'none', 'off', 'en', 'en_gb', 'en_us']);

/**
 * Data language for tools without a window (CLI, MCP): `wanted` if given (a locale code or
 * `none`), otherwise the language of the game's `settings.cfg`. Undefined when that locale has
 * no translation folder.
 */
export function resolveDataLocale(paths: GamePaths, wanted?: string): string | undefined {
  const code = wanted ?? gameLanguage(paths);
  if (code === undefined || NONE.has(code.toLowerCase())) return undefined;
  const found = listGameLocales(paths).find((l) => l.code.toLowerCase() === code.toLowerCase());
  return found?.code;
}
