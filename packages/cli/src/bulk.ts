/**
 * `kedit bulk` — массовая правка: записи типа по условиям → задать / умножить / прибавить /
 * заменить текст. По умолчанию только предпросмотр «было → станет»; запись — с `--apply`
 * (в `--out` или в сам `--mod`). В мастерскую не пишем никогда, в папку игры — с `--force`.
 */
import { basename, resolve } from 'node:path';
import { applyBulk, formatBulkPreview, previewBulk, validateMod, type BulkKind, type BulkOperation, type FieldFilter, type ModContext } from '@kenshi-editor/core';
import { isInGameFolders, isInWorkshop, saveModContext } from '@kenshi-editor/core/node';
import { UsageError, type Workspace } from './workspace.ts';

export interface BulkRequest {
  type: string;
  text?: string;
  fields: FieldFilter[];
  modOnly: boolean;
  set?: string;
  mul?: string;
  add?: string;
  replace?: string;
  find?: string;
  with?: string;
  regex: boolean;
  caseSensitive: boolean;
  apply: boolean;
  mod?: string;
  out?: string;
  force: boolean;
}

/** `ПОЛЕ=ЗНАЧЕНИЕ` → [поле, значение]. */
function fieldValue(spec: string, flag: string): [string, string] {
  const i = spec.indexOf('=');
  if (i <= 0) throw new UsageError({ en: `--${flag}: FIELD=VALUE expected, not “${spec}”`, ru: `--${flag}: нужно ПОЛЕ=ЗНАЧЕНИЕ, а не «${spec}»` });
  return [spec.slice(0, i).trim(), spec.slice(i + 1)];
}

export function bulkOperation(r: BulkRequest): BulkOperation {
  const given = (['set', 'mul', 'add', 'replace'] as const).filter((k) => r[k] !== undefined);
  if (given.length !== 1) throw new UsageError({ en: 'bulk: exactly one operation is needed: --set, --mul, --add (FIELD=VALUE) or --replace FIELD --find … --with …', ru: 'bulk: нужна ровно одна операция: --set, --mul, --add (ПОЛЕ=ЗНАЧЕНИЕ) или --replace ПОЛЕ --find … --with …' });
  const kind: BulkKind = given[0]!;
  if (kind === 'replace') {
    if (r.find === undefined) throw new UsageError({ en: 'bulk --replace: --find is needed (what to look for)', ru: 'bulk --replace: нужен --find (что искать)' });
    return { kind, field: r.replace!, value: r.with ?? '', find: r.find, regex: r.regex, caseSensitive: r.caseSensitive };
  }
  const [field, value] = fieldValue(r[kind]!, kind);
  return { kind, field, value };
}

export function runBulk(ws: Workspace, ctx: ModContext, r: BulkRequest, limit: number, out: (line: string) => void): number {
  const op = bulkOperation(r);
  const p = previewBulk(ctx, { type: r.type, fields: r.fields, modOnly: r.modOnly, ...(r.text !== undefined ? { text: r.text } : {}) }, op, ws.lang);
  for (const l of formatBulkPreview(p, limit, ws.lang)) out(l);
  if (!r.apply) {
    out(ws.t({ en: 'this is a preview: nothing is written (--apply — write)', ru: 'это предпросмотр: ничего не записано (--apply — записать)' }));
    return 0;
  }
  const target = r.out ?? r.mod;
  if (target === undefined) throw new UsageError({ en: 'bulk --apply: where to write? --out <file.mod> or --mod <mod>', ru: 'bulk --apply: куда писать? --out <файл.mod> или --mod <мод>' });
  const path = r.out !== undefined ? resolve(ws.cwd, r.out) : ws.modPath(r.mod!);
  if (isInWorkshop(ws.paths, path)) throw new UsageError({ en: `${path} is in the Steam workshop; the editor never writes there. Make a copy: kedit mods copy <mod>`, ru: `${path} — в мастерской Steam; туда не пишем никогда. Сделайте копию: kedit mods copy <мод>` });
  if (!r.force && isInGameFolders(ws.paths, path)) throw new UsageError({ en: `${path} is in the game folder; writing there needs --force`, ru: `${path} — в папке игры; запись туда только с --force` });
  if (p.changes.length === 0) {
    out(ws.t({ en: 'nothing to change: the file is not written', ru: 'менять нечего: файл не записан' }));
    return 0;
  }
  applyBulk(ctx, p);
  saveModContext(ctx, path);
  const errors = validateMod(ctx).filter((i) => i.severity === 'error').length;
  const n = ctx.modRecords().length;
  out(ws.t({ en: `written: ${path} (${basename(path)}), records in the mod ${n}${errors ? `, validation errors ${errors}` : ''}`, ru: `записано: ${path} (${basename(path)}), записей в моде ${n}${errors ? `, ошибок проверки ${errors}` : ''}` }));
  return 0;
}
