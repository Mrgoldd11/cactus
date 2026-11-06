/**
 * `kedit merge <источник> --mod M` — слияние: что мод-источник меняет относительно вашего мода.
 * По умолчанию только предпросмотр. Запись — с `--apply` и явным выбором (`--only`, `--type`,
 * `--kind` или `--all`); пишется в `--out` или в сам `--mod`, рядом — файл решений
 * `<мод>.kedit-merge.json`. В мастерскую не пишем никогда, в папку игры — с `--force`.
 */
import { basename, resolve } from 'node:path';
import {
  applyMerge,
  formatMergePlan,
  formatMergeResult,
  MergeError,
  planMerge,
  rejectMerge,
  selectMergeChanges,
  unrejectMerge,
  validateMod,
  type MergeChoice,
  type MergeKind,
  type ModContext,
} from '@kenshi-editor/core';
import { detectLevelData, isInGameFolders, isInWorkshop, loadMergeLedger, readMergeSource, saveMergeLedger, saveModContext } from '@kenshi-editor/core/node';
import { UsageError, type Workspace } from './workspace.ts';

export interface MergeRequest {
  /** Источник: имя установленного мода или путь. */
  source: string;
  mod: string;
  only: string[];
  types: string[];
  kinds: string[];
  all: boolean;
  recursive: boolean;
  fixRefs: boolean;
  conflicts?: string;
  reject: string[];
  unreject: string[];
  showRejected: boolean;
  levels: boolean;
  apply: boolean;
  out?: string;
  force: boolean;
  json: boolean;
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const splitList = list;

const KINDS: readonly MergeKind[] = ['new', 'changed', 'deleted'];

export function runMerge(ws: Workspace, ctx: ModContext, r: MergeRequest, limit: number, out: (line: string) => void): number {
  try {
    return merge(ws, ctx, r, limit, out);
  } catch (e) {
    if (e instanceof MergeError) throw new UsageError(e.message);
    throw e;
  }
}

function merge(ws: Workspace, ctx: ModContext, r: MergeRequest, limit: number, out: (line: string) => void): number {
  const kinds = r.kinds.map((k) => {
    if (!KINDS.includes(k as MergeKind)) throw new UsageError(`--kind: ${KINDS.join(', ')}, а не «${k}»`);
    return k as MergeKind;
  });
  let conflicts: MergeChoice | undefined;
  if (r.conflicts !== undefined) {
    if (r.conflicts !== 'source' && r.conflicts !== 'mine') throw new UsageError('--conflicts: source (взять из источника) или mine (оставить ваше)');
    conflicts = r.conflicts;
  }
  const modPath = ws.modPath(r.mod);
  const sourcePath = ws.modPath(r.source);
  const source = readMergeSource(sourcePath);
  const ledger = loadMergeLedger(modPath);
  const levelData = r.levels ? detectLevelData(sourcePath) : undefined;
  const options = { showRejected: r.showRejected, ...(levelData ? { levelData } : {}) };
  const wantsWrite = r.apply || r.reject.length > 0 || r.unreject.length > 0;

  let target = modPath;
  if (wantsWrite) {
    if (r.out !== undefined) target = resolve(ws.cwd, r.out);
    if (isInWorkshop(ws.paths, target)) throw new UsageError(`${target} — в мастерской Steam; туда не пишем никогда. Сделайте копию: kedit mods copy <мод>`);
    if (!r.force && isInGameFolders(ws.paths, target)) throw new UsageError(`${target} — в папке игры; запись туда только с --force`);
  }

  // Отклонить / вернуть: меняет только файл решений.
  if (r.reject.length > 0 || r.unreject.length > 0) {
    const done = rejectMerge(ctx, source, ledger, r.reject, options);
    unrejectMerge(ledger, source, r.unreject);
    saveMergeLedger(ctx, ledger, target);
    out(`отклонено ${done.length}, возвращено ${r.unreject.length}: решения записаны в файл рядом с ${basename(target)}`);
  }

  const plan = planMerge(ctx, source, ledger, options);
  if (r.json && !r.apply) {
    out(JSON.stringify(plan, null, 1));
    return 0;
  }
  if (!r.json) for (const l of formatMergePlan(plan, limit)) out(l);
  if (!r.apply) {
    if (!r.json) out('это предпросмотр: ничего не записано (--apply с --only / --type / --kind / --all — слить)');
    return 0;
  }

  const accept = selectMergeChanges(plan, { ids: r.only, types: r.types, kinds, all: r.all });
  if (accept.length === 0) {
    throw new UsageError('merge --apply: что сливать? Укажите --only id,id | --type ТИП | --kind new,changed,deleted | --all');
  }
  const result = applyMerge(ctx, source, ledger, { accept, recursive: r.recursive, fixReferences: r.fixRefs, levelData: r.levels, ...(conflicts ? { conflicts } : {}) }, options);
  if (r.json) out(JSON.stringify(result, null, 1));
  else for (const l of formatMergeResult(result)) out(l);
  if (result.changesetId === undefined) {
    out('менять нечего: файл не записан');
    return 0;
  }
  saveModContext(ctx, target);
  const ledgerPath = saveMergeLedger(ctx, ledger, target);
  const errors = validateMod(ctx).filter((i) => i.severity === 'error').length;
  out(`записано: ${target} (${basename(target)}), записей в моде ${ctx.modRecords().length}${errors ? `, ошибок проверки ${errors}` : ''}${ledgerPath ? `; решения: ${basename(ledgerPath)}` : ''}`);
  return errors > 0 ? 1 : 0;
}
