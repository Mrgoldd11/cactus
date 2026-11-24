/**
 * `kedit validate --fix` and `kedit cleanup`: fixes for validation problems and mod cleanup.
 * Both show a preview by default; writing — with `--apply` (into `--out` or the `--mod` itself).
 * Never writes into the Workshop, into the game folder — only with `--force`.
 */
import { basename, resolve } from 'node:path';
import {
  applyCleanup,
  applyFixPlan,
  CLEANUP_GROUPS,
  FIX_KINDS,
  formatCleanup,
  formatFix,
  planFixes,
  scanCleanup,
  validateMod,
  type CleanupGroup,
  type FixKind,
  type ModContext,
} from '@kenshi-editor/core';
import { isInGameFolders, isInWorkshop, saveModContext } from '@kenshi-editor/core/node';
import { UsageError, type Workspace } from './workspace.ts';
import { splitList } from './merge.ts';

export interface WriteTarget {
  apply: boolean;
  mod?: string;
  out?: string;
  force: boolean;
}

export interface FixRequest extends WriteTarget {
  /** Fix kind; without it — the recommended fix of each problem. */
  kind?: string;
  /** Only problems with these codes (comma-separated). */
  codes?: string;
}

export interface CleanupRequest extends WriteTarget {
  /** Only these groups (comma-separated). */
  groups?: string;
}

/** Where `--apply` writes; throws on the Workshop and (without --force) the game folder. */
function writePath(ws: Workspace, cmd: string, r: WriteTarget): string {
  const target = r.out ?? r.mod;
  if (target === undefined) throw new UsageError({ en: `${cmd} --apply: where to write? --out <file.mod> or --mod <mod>`, ru: `${cmd} --apply: куда писать? --out <файл.mod> или --mod <мод>` });
  const path = r.out !== undefined ? resolve(ws.cwd, r.out) : ws.modPath(r.mod!);
  if (isInWorkshop(ws.paths, path)) throw new UsageError({ en: `${path} is in the Steam workshop; the editor never writes there. Make a copy: kedit mods copy <mod>`, ru: `${path} — в мастерской Steam; туда не пишем никогда. Сделайте копию: kedit mods copy <мод>` });
  if (!r.force && isInGameFolders(ws.paths, path)) throw new UsageError({ en: `${path} is in the game folder; writing there needs --force`, ru: `${path} — в папке игры; запись туда только с --force` });
  return path;
}

function written(ws: Workspace, ctx: ModContext, path: string): string {
  const errors = validateMod(ctx).filter((i) => i.severity === 'error').length;
  const n = ctx.modRecords().length;
  return ws.t({ en: `written: ${path} (${basename(path)}), records in the mod ${n}${errors ? `, validation errors ${errors}` : ''}`, ru: `записано: ${path} (${basename(path)}), записей в моде ${n}${errors ? `, ошибок проверки ${errors}` : ''}` });
}

function previewNote(ws: Workspace): string {
  return ws.t({ en: 'this is a preview: nothing is written (--apply — write)', ru: 'это предпросмотр: ничего не записано (--apply — записать)' });
}

function limited(lines: string[], limit: number, ws: Workspace, out: (line: string) => void): void {
  for (const l of lines.slice(0, limit)) out(l);
  if (lines.length > limit) out(ws.t({ en: `… ${lines.length - limit} more lines (--limit N)`, ru: `… ещё строк ${lines.length - limit} (--limit N)` }));
}

export function parseFixKind(kind: string | undefined): FixKind | undefined {
  if (kind === undefined) return undefined;
  if (!(FIX_KINDS as readonly string[]).includes(kind)) throw new UsageError({ en: `--kind: one of ${FIX_KINDS.join(', ')}`, ru: `--kind: одно из ${FIX_KINDS.join(', ')}` });
  return kind as FixKind;
}

export function parseCleanupGroups(groups: string | undefined): Set<CleanupGroup> | undefined {
  if (groups === undefined) return undefined;
  const list = splitList(groups);
  const bad = list.filter((g) => !(CLEANUP_GROUPS as readonly string[]).includes(g));
  if (bad.length) throw new UsageError({ en: `--group: unknown ${bad.join(', ')}; known: ${CLEANUP_GROUPS.join(', ')}`, ru: `--group: неизвестно ${bad.join(', ')}; есть: ${CLEANUP_GROUPS.join(', ')}` });
  return new Set(list as CleanupGroup[]);
}

export function runValidateFix(ws: Workspace, ctx: ModContext, r: FixRequest, limit: number, out: (line: string) => void): number {
  const kind = parseFixKind(r.kind);
  const codes = r.codes !== undefined ? new Set(splitList(r.codes)) : undefined;
  const issues = validateMod(ctx).filter((i) => !codes || codes.has(i.code));
  const plan = planFixes(ctx, issues, kind);
  limited(plan.fixed.map((f) => formatFix(f, ws.lang)), limit, ws, out);
  out(ws.t({ en: `problems ${issues.length}, will be fixed ${plan.fixed.length}, without a fix ${plan.skipped.length}`, ru: `проблем ${issues.length}, будет исправлено ${plan.fixed.length}, без исправления ${plan.skipped.length}` }));
  if (!r.apply) {
    out(previewNote(ws));
    return 0;
  }
  const path = writePath(ws, 'validate --fix', r);
  if (!plan.ops.length) {
    out(ws.t({ en: 'nothing to fix: the file is not written', ru: 'исправлять нечего: файл не записан' }));
    return 0;
  }
  applyFixPlan(ctx, plan);
  saveModContext(ctx, path);
  out(written(ws, ctx, path));
  return 0;
}

export function runCleanup(ws: Workspace, ctx: ModContext, r: CleanupRequest, limit: number, out: (line: string) => void): number {
  const groups = parseCleanupGroups(r.groups);
  const scan = scanCleanup(ctx);
  const items = groups ? scan.items.filter((i) => groups.has(i.group)) : scan.items;
  limited(formatCleanup(ctx, { ...scan, items }, ws.lang), limit, ws, out);
  out(ws.t({ en: `will be removed: ${items.length}`, ru: `будет убрано: ${items.length}` }));
  if (!r.apply) {
    out(previewNote(ws));
    return 0;
  }
  const path = writePath(ws, 'cleanup', r);
  if (!items.length) {
    out(ws.t({ en: 'nothing to clean: the file is not written', ru: 'убирать нечего: файл не записан' }));
    return 0;
  }
  applyCleanup(ctx, items);
  saveModContext(ctx, path);
  out(written(ws, ctx, path));
  return 0;
}
