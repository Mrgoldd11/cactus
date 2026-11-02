import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePo, type PoFile } from '../locale/po.ts';
import { parseGameSchema, type GameSchema } from '../schema/game-schema.ts';
import type { GamePaths } from './paths.ts';

export const SCHEMA_FILES = { fcsDef: 'fcs.def', fcsEnums: 'fcs_enums.def', fcsLayout: 'fcs_layout.def' } as const;

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** Прочитать fcs.def (обязателен), fcs_enums.def и fcs_layout.def из папки игры. */
export function loadGameSchema(paths: GamePaths): GameSchema {
  const fcsEnums = readOptional(join(paths.kenshi, SCHEMA_FILES.fcsEnums));
  const fcsLayout = readOptional(join(paths.kenshi, SCHEMA_FILES.fcsLayout));
  return parseGameSchema({
    fcsDef: readFileSync(join(paths.kenshi, SCHEMA_FILES.fcsDef), 'utf8'),
    ...(fcsEnums !== undefined && { fcsEnums }),
    ...(fcsLayout !== undefined && { fcsLayout }),
  });
}

export function gamedataPoPath(paths: GamePaths, language = 'ru_RU'): string {
  return join(paths.kenshi, 'locale', language, 'gamedata.po');
}

/** Прочитать перевод игры `locale/<язык>/gamedata.po`. */
export function loadGamedataPo(paths: GamePaths, language = 'ru_RU'): PoFile {
  return parsePo(readFileSync(gamedataPoPath(paths, language), 'utf8'));
}
