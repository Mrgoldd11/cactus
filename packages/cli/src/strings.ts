/**
 * kedit strings — mod texts for translation: a table with statuses, export to CSV/JSON/PO and
 * building a translation mod from a translation file.
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
  /** Translation mod to view statuses on top of (path or name). */
  mod?: string;
  deps?: string[];
  /** Export file (.csv, .json, .po) or, with `import`, the translation mod file (.mod). */
  out?: string;
  /** Translation file for building the translation mod. */
  import?: string;
  name?: string;
  todo: boolean;
  force: boolean;
  json: boolean;
}

/** Translation status labels per output language. */
const STATUS_TEXT: Record<string, Record<'todo' | 'same' | 'done', string>> = {
  en: { todo: 'no', same: 'as original', done: 'yes' },
  ru: { todo: 'нет', same: 'как в оригинале', done: 'есть' },
};

function modFileName(spec: string): string {
  const b = basename(spec);
  return b.toLowerCase().endsWith('.mod') ? b : `${b}.mod`;
}

function checkOut(ws: Workspace, path: string, force: boolean): void {
  if (isInWorkshop(ws.paths, path)) throw new UsageError({ en: `${path} is in the Steam workshop; the editor never writes there`, ru: `${path} — в мастерской Steam; туда не пишем никогда` });
  if (!force && isInGameFolders(ws.paths, path)) throw new UsageError({ en: `${path} is in the game folder; writing there needs --force`, ru: `${path} — в папке игры; запись туда только с --force` });
}

/** Translation mod context: vanilla → original (and translation dependencies) → translation. */
function openTranslation(ws: Workspace, source: string, o: StringsOptions): { ctx: ModContext; source: string } {
  const name = o.name ?? (o.out !== undefined && o.import !== undefined ? basename(o.out) : `${source.slice(0, -4)} RUS.mod`);
  const open = (deps?: string[]): ModContext => {
    const r = ws.open({ ...(o.mod !== undefined ? { mod: o.mod } : { name }), ...(deps ? { dependencies: deps } : {}), po: false, schema: false });
    if (r.missingDependencies.length) throw new UsageError({ en: `missing mods: ${r.missingDependencies.join(', ')}`, ru: `нет модов: ${r.missingDependencies.join(', ')}` });
    return r.ctx;
  };
  let ctx = open(o.deps ?? (o.mod === undefined ? [source] : undefined));
  const layer = ctx.layers.find((l) => l.name.toLowerCase() === source.toLowerCase());
  if (!layer) ctx = open([...ctx.info.dependencies, source]);
  return { ctx, source: ctx.layers.find((l) => l.name.toLowerCase() === source.toLowerCase())?.name ?? source };
}

export function runStrings(ws: Workspace, io: Io, sourceSpec: string, o: StringsOptions): number {
  const source0 = modFileName(sourceSpec);
  if (isVanillaLayer(source0)) throw new UsageError({ en: 'strings: vanilla is translated by the game translation; pass a mod', ru: 'strings: ваниль переводит перевод игры; укажите мод' });
  const { ctx, source } = openTranslation(ws, source0, o);

  if (o.import !== undefined) {
    if (o.out === undefined || extname(o.out).toLowerCase() !== '.mod') throw new UsageError({ en: 'strings --import: --out <translation.mod> is needed', ru: 'strings --import: нужен --out <перевод.mod>' });
    const outPath = resolve(ws.cwd, o.out);
    checkOut(ws, outPath, o.force);
    const file = parseTranslationFile(readFileSync(resolve(ws.cwd, o.import), 'utf8'));
    if (file.source !== undefined && file.source.toLowerCase() !== source.toLowerCase()) io.err(ws.t({ en: `the translation file was made for ${file.source}, not for ${source}`, ru: `файл перевода сделан для ${file.source}, а не для ${source}` }));
    const rep = applyTranslationRows(ctx, source, file.rows);
    for (const l of formatApplyReport(rep, ws.lang)) io.out(l);
    const saved = saveModContext(ctx, outPath);
    io.out(ws.t({ en: `${outPath}: records ${saved.records.length}; depends on ${ctx.info.dependencies.join(', ')}`, ru: `${outPath}: записей ${saved.records.length}; зависит от ${ctx.info.dependencies.join(', ')}` }));
    return 0;
  }

  const all = translationRows(ctx, source);
  const rows = o.todo ? all.filter((r) => r.status === 'todo') : all;
  if (o.out !== undefined) {
    const outPath = resolve(ws.cwd, o.out);
    checkOut(ws, outPath, o.force);
    const ext = extname(outPath).toLowerCase();
    const text = ext === '.json' ? formatTranslationJson(source, rows) : ext === '.po' || ext === '.pot' ? formatTranslationPo(source, rows) : ext === '.csv' ? formatTranslationCsv(rows) : undefined;
    if (text === undefined) throw new UsageError({ en: 'strings --out: a .csv, .json or .po file', ru: 'strings --out: файл .csv, .json или .po' });
    writeFileSync(outPath, text);
    io.out(ws.t({ en: `${outPath}: rows ${rows.length}`, ru: `${outPath}: строк ${rows.length}` }));
    return 0;
  }

  const s = summarizeTranslation(all);
  const ex = translationExtras(ctx, [source], ws.lang);
  if (o.json) {
    io.out(JSON.stringify({ source, translation: ctx.modName, summary: s, rows, extras: ex }, null, 1));
    return 0;
  }
  io.out(ws.t({
    en: `${source} → ${ctx.modName}: texts ${s.total}, translated ${s.done}, as original ${s.same}, untranslated ${s.todo}`,
    ru: `${source} → ${ctx.modName}: текстов ${s.total}, переведено ${s.done}, как в оригинале ${s.same}, нет перевода ${s.todo}`,
  }));
  const status = STATUS_TEXT[ws.lang] ?? STATUS_TEXT.en!;
  const line = (r: TranslationRow): string => `  [${status[r.status]}] ${r.id} ${r.field} (${r.record}): ${JSON.stringify(r.original)}${r.translation !== undefined ? ` → ${JSON.stringify(r.translation)}` : ''}`;
  for (const r of rows) io.out(line(r));
  if (ex.orphans.length) io.out(ws.t({ en: `texts not from the original: ${ex.orphans.length}`, ru: `тексты не из оригинала: ${ex.orphans.length}` }));
  for (const x of ex.orphans.slice(0, 20)) io.out(`  ${x.id} ${x.field}: ${JSON.stringify(x.text)}`);
  if (ex.nonText.length) io.out(ws.t({ en: `non-text edits (a translation mod should not make them): ${ex.nonText.length}`, ru: `правки не текстов (мод-перевод их не должен делать): ${ex.nonText.length}` }));
  for (const x of ex.nonText.slice(0, 20)) io.out(`  ${x.id}: ${x.what}`);
  return 0;
}
