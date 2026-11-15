import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parsePo, type PoFile } from '../locale/po.ts';
import { indexTranslation, type TranslationIndex } from '../locale/translation.ts';
import { readDataFile } from '../format/read.ts';
import { applyExtensionLayers, prepareSchemaBase, type SchemaBase } from '../schema/extensions.ts';
import type { GameSchema } from '../schema/game-schema.ts';
import { changesSchema, extensionsCacheKey, readExtensionLayers, type FoundExtension } from './extensions.ts';
import type { GamePaths } from './paths.ts';

export const SCHEMA_FILES = { fcsDef: 'fcs.def', fcsEnums: 'fcs_enums.def', fcsLayout: 'fcs_layout.def' } as const;

export interface LoadSchemaOptions {
  /** Schema extensions to apply, in load order (`extensionsFor`). Default: none. */
  extensions?: readonly FoundExtension[];
}

/** How many parsed schemas are kept: the game's own and those of the last sets of extensions. */
const SCHEMA_CACHE_SIZE = 8;
const baseCache = new Map<string, SchemaBase>();
const extendedCache = new Map<string, GameSchema>();

function cached<T>(cache: Map<string, T>, key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Move to the end: the first entry is the one unused the longest.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const value = make();
  cache.set(key, value);
  if (cache.size > SCHEMA_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return value;
}

/** Forget the schemas kept in memory. */
export function clearSchemaCache(): void {
  baseCache.clear();
  extendedCache.clear();
}

/** Size and time of a file as a cache key part; `-` for a missing file. */
function stateOf(path: string): string {
  try {
    const st = statSync(path);
    return `${st.size}|${st.mtimeMs}`;
  } catch {
    return '-';
  }
}

/**
 * The schema of the game: fcs.def (required), fcs_enums.def and fcs_layout.def from the game
 * folder, plus the given schema extensions.
 *
 * The result is kept in memory under the size and time of every file it was built from: a
 * second call with unchanged files costs three `stat` calls and returns the same object, a
 * changed file gives a fresh schema. The game's files are parsed once for all sets of
 * extensions. A schema is shared between callers and must not be changed in place.
 */
export function loadGameSchema(paths: GamePaths, options: LoadSchemaOptions = {}): GameSchema {
  const files = [SCHEMA_FILES.fcsDef, SCHEMA_FILES.fcsEnums, SCHEMA_FILES.fcsLayout].map((name) => join(paths.kenshi, name));
  const states = files.map(stateOf);
  const baseKey = files.map((path, i) => `${path}|${states[i]!}`).join('\n');
  const base = cached(baseCache, baseKey, () => {
    const fcsEnums = states[1] !== '-' ? readFileSync(files[1]!, 'utf8') : undefined;
    const fcsLayout = states[2] !== '-' ? readFileSync(files[2]!, 'utf8') : undefined;
    return prepareSchemaBase({
      fcsDef: readFileSync(files[0]!, 'utf8'),
      ...(fcsEnums !== undefined && { fcsEnums }),
      ...(fcsLayout !== undefined && { fcsLayout }),
    });
  });
  const extensions = (options.extensions ?? []).filter(changesSchema);
  if (extensions.length === 0) return base.schema;
  const key = [baseKey, '', extensionsCacheKey(extensions)].join('\n');
  return cached(extendedCache, key, () => applyExtensionLayers(base, readExtensionLayers(extensions)));
}

export function gamedataPoPath(paths: GamePaths, language = 'ru_RU'): string {
  return join(paths.kenshi, 'locale', language, 'gamedata.po');
}

/** Прочитать перевод игры `locale/<язык>/gamedata.po`. */
export function loadGamedataPo(paths: GamePaths, language = 'ru_RU'): PoFile {
  return parsePo(readFileSync(gamedataPoPath(paths, language), 'utf8'));
}

/** Перевод текстов записей (реплик и др.) `locale/<язык>/<язык>.translation`. */
export function translationFilePath(paths: GamePaths, language = 'ru_RU'): string {
  return join(paths.kenshi, 'locale', language, `${language}.translation`);
}

/** Прочитать перевод текстов записей; без файла — undefined. */
export function loadTranslation(paths: GamePaths, language = 'ru_RU'): TranslationIndex | undefined {
  const path = translationFilePath(paths, language);
  return existsSync(path) ? indexTranslation(readDataFile(readFileSync(path))) : undefined;
}
