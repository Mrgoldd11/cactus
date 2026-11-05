/**
 * kedit strings — тексты мода для перевода: таблица со статусами, выгрузка в CSV/JSON/PO и
 * сборка мода-перевода из файла перевода.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import {
  applyTranslationRows,
  formatApplyReport,
  formatTranslationCsv,
  formatTranslationJson,
  formatTranslationPo,
  isVanillaLayer,
  parseTranslationFile,
  summarizeTranslation,
  translationExtras,
  translationRows,
  type ModContext,
  type TranslationRow,
} from '@kenshi-editor/core';
import { isInGameFolders, isInWorkshop, saveModContext } from '@kenshi-editor/core/node';
import type { Io } from './main.ts';
import { UsageError, type Workspace } from './workspace.ts';

export interface StringsOptions {
  /** Мод-перевод, поверх которого смотреть статусы (путь или имя). */
  mod?: string;
  deps?: string[];
  /** Файл выгрузки (.csv, .json, .po) или, с `import`, файл мода-перевода (.mod). */
  out?: string;
  /** Файл перевода для сборки мода-перевода. */
  import?: string;
  name?: string;
  todo: boolean;
  force: boolean;
  json: boolean;
}

const STATUS_RU = { todo: 'нет', same: 'как в оригинале', done: 'есть' } as const;

function modFileName(spec: string): string {
  const b = basename(spec);
  return b.toLowerCase().endsWith('.mod') ? b : `${b}.mod`;
}

function checkOut(ws: Workspace, path: string, force: boolean): void {
  if (isInWorkshop(ws.paths, path)) throw new UsageError(`${path} — в мастерской Steam; туда не пишем никогда`);
  if (!force && isInGameFolders(ws.paths, path)) throw new UsageError(`${path} — в папке игры; запись туда только с --force`);
}

/** Контекст мода-перевода: ваниль → оригинал (и зависимости перевода) → перевод. */
function openTranslation(ws: Workspace, source: string, o: StringsOptions): { ctx: ModContext; source: string } {
  const name = o.name ?? (o.out !== undefined && o.import !== undefined ? basename(o.out) : `${source.slice(0, -4)} RUS.mod`);
  const open = (deps?: string[]): ModContext => {
    const r = ws.open({ ...(o.mod !== undefined ? { mod: o.mod } : { name }), ...(deps ? { dependencies: deps } : {}), po: false, schema: false });
    if (r.missingDependencies.length) throw new UsageError(`нет модов: ${r.missingDependencies.join(', ')}`);
    return r.ctx;
  };
  let ctx = open(o.deps ?? (o.mod === undefined ? [source] : undefined));
  const layer = ctx.layers.find((l) => l.name.toLowerCase() === source.toLowerCase());
  if (!layer) ctx = open([...ctx.info.dependencies, source]);
  return { ctx, source: ctx.layers.find((l) => l.name.toLowerCase() === source.toLowerCase())?.name ?? source };
}

export function runStrings(ws: Workspace, io: Io, sourceSpec: string, o: StringsOptions): number {
  const source0 = modFileName(sourceSpec);
  if (isVanillaLayer(source0)) throw new UsageError('strings: ваниль переводит перевод игры; укажите мод');
  const { ctx, source } = openTranslation(ws, source0, o);

  if (o.import !== undefined) {
    if (o.out === undefined || extname(o.out).toLowerCase() !== '.mod') throw new UsageError('strings --import: нужен --out <перевод.mod>');
    const outPath = resolve(ws.cwd, o.out);
    checkOut(ws, outPath, o.force);
    const file = parseTranslationFile(readFileSync(resolve(ws.cwd, o.import), 'utf8'));
    if (file.source !== undefined && file.source.toLowerCase() !== source.toLowerCase()) io.err(`файл перевода сделан для ${file.source}, а не для ${source}`);
    const rep = applyTranslationRows(ctx, source, file.rows);
    for (const l of formatApplyReport(rep)) io.out(l);
    const saved = saveModContext(ctx, outPath);
    io.out(`${outPath}: записей ${saved.records.length}; зависит от ${ctx.info.dependencies.join(', ')}`);
    return 0;
  }

  const all = translationRows(ctx, source);
  const rows = o.todo ? all.filter((r) => r.status === 'todo') : all;
  if (o.out !== undefined) {
    const outPath = resolve(ws.cwd, o.out);
    checkOut(ws, outPath, o.force);
    const ext = extname(outPath).toLowerCase();
    const text = ext === '.json' ? formatTranslationJson(source, rows) : ext === '.po' || ext === '.pot' ? formatTranslationPo(source, rows) : ext === '.csv' ? formatTranslationCsv(rows) : undefined;
    if (text === undefined) throw new UsageError('strings --out: файл .csv, .json или .po');
    writeFileSync(outPath, text);
    io.out(`${outPath}: строк ${rows.length}`);
    return 0;
  }

  const s = summarizeTranslation(all);
  const ex = translationExtras(ctx, [source]);
  if (o.json) {
    io.out(JSON.stringify({ source, translation: ctx.modName, summary: s, rows, extras: ex }, null, 1));
    return 0;
  }
  io.out(`${source} → ${ctx.modName}: текстов ${s.total}, переведено ${s.done}, как в оригинале ${s.same}, нет перевода ${s.todo}`);
  const line = (r: TranslationRow): string => `  [${STATUS_RU[r.status]}] ${r.id} ${r.field} (${r.record}): ${JSON.stringify(r.original)}${r.translation !== undefined ? ` → ${JSON.stringify(r.translation)}` : ''}`;
  for (const r of rows) io.out(line(r));
  if (ex.orphans.length) io.out(`тексты не из оригинала: ${ex.orphans.length}`);
  for (const x of ex.orphans.slice(0, 20)) io.out(`  ${x.id} ${x.field}: ${JSON.stringify(x.text)}`);
  if (ex.nonText.length) io.out(`правки не текстов (мод-перевод их не должен делать): ${ex.nonText.length}`);
  for (const x of ex.nonText.slice(0, 20)) io.out(`  ${x.id}: ${x.what}`);
  return 0;
}
