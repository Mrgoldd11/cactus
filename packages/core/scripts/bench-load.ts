/**
 * Бенчмарк загрузки ванили так же, как её открывает окно редактора (project.ts):
 * чтение файлов → разбор → схема → ModContext → индекс поиска → дерево категорий.
 * Запуск: node packages/core/scripts/bench-load.ts [папка игры]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCategoryTree, decodeText, itemTypeName, ModContext, parseGameSchema, parsePo, readDataFile, withInferredFields, VANILLA_FILES,
  type Layer,
} from '../src/index.ts';
import { detectGameInstalls, gamedataPoPath, SCHEMA_FILES, vanillaFilePaths } from '../src/node/index.ts';

const dir = process.argv[2];
const game = dir ? { kenshi: dir, workshop: undefined } : detectGameInstalls()[0];
if (!game) throw new Error('игра не найдена');
const t = (label: string, t0: number): number => {
  const now = performance.now();
  console.log(`${label.padEnd(34)} ${(now - t0).toFixed(0).padStart(6)} мс`);
  return now;
};
let t0 = performance.now();
const start = t0;
const bytes = vanillaFilePaths(game as never).map((p) => readFileSync(p));
const fcsDef = readFileSync(join(game.kenshi, SCHEMA_FILES.fcsDef), 'utf8');
const fcsEnums = readFileSync(join(game.kenshi, SCHEMA_FILES.fcsEnums), 'utf8');
const fcsLayout = existsSync(join(game.kenshi, SCHEMA_FILES.fcsLayout)) ? readFileSync(join(game.kenshi, SCHEMA_FILES.fcsLayout), 'utf8') : undefined;
const po = readFileSync(gamedataPoPath(game as never), 'utf8');
t0 = t('чтение файлов', t0);
const layers: Layer[] = bytes.map((b, i) => ({ name: VANILLA_FILES[i]!, file: readDataFile(b) }));
t0 = t('разбор 4 файлов ванили', t0);
const base = parseGameSchema({ fcsDef, fcsEnums, ...(fcsLayout ? { fcsLayout } : {}) });
t0 = t('схема fcs.def', t0);
const schema = withInferredFields(base, layers.map((l) => l.file));
t0 = t('withInferredFields', t0);
const poParsed = parsePo(po);
t0 = t('gamedata.po', t0);
const ctx = new ModContext({ layers, modName: 'bench.mod', schema, po: poParsed });
t0 = t('ModContext', t0);
const types = new Set<string>();
let n = 0;
for (const sid of ctx.allStringIds()) {
  const rec = ctx.headline(sid);
  if (!rec) continue;
  const name = decodeText(rec.name);
  const ru = ctx.localizedName(sid) ?? '';
  const type = itemTypeName(rec.type);
  types.add(type);
  void `${name}\n${ru}\n${sid}`.toLowerCase();
  n++;
}
t0 = t(`индекс поиска (${n} записей)`, t0);
buildCategoryTree(schema, types);
t('дерево категорий', t0);
t('ИТОГО', start);
