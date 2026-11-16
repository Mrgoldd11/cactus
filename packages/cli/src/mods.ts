/**
 * kedit mods — installed mods and load order (`data/mods.cfg`).
 */
import { applyModsCfgChange, describeOrderChange, type ModPlace, type ModsCfgChange } from '@kenshi-editor/core';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { copyModForEditing, listInstalledMods, modsCfgPath, planModCopy, readModSummary, writeModsCfg, type InstalledMod } from '@kenshi-editor/core/node';
import { UsageError, usageFrom, type Workspace } from './workspace.ts';

export interface ModsOut {
  out(line: string): void;
}

function where(m: InstalledMod, ws: Workspace): string {
  return m.source === 'workshop' ? ws.t({ en: `workshop ${m.workshopId}`, ru: `мастерская ${m.workshopId}` }) : 'mods';
}

/** Mod line for the list: position, name, origin; with `full` — author, records, dependencies. */
function line(m: InstalledMod, full: boolean, ws: Workspace): string {
  const pos = m.loadIndex !== undefined ? `${String(m.loadIndex + 1).padStart(3)}.` : '    ';
  let s = `${pos} ${m.fileName}  [${where(m, ws)}]`;
  if (m.shadowedBy) s += ws.t({ en: '  (not loaded: the same one is in mods/)', ru: '  (не грузится: есть такой же в mods/)' });
  if (full) {
    const h = readModSummary(m.path);
    if (h.error) s += ws.t({ en: `  error: ${h.error}`, ru: `  ошибка: ${h.error}` });
    else {
      s += ws.t({ en: `  records ${h.recordCount ?? '?'}`, ru: `  записей ${h.recordCount ?? '?'}` });
      if (h.author) s += ws.t({ en: `, author ${h.author}`, ru: `, автор ${h.author}` });
      if (h.dependencies?.length) s += ws.t({ en: `, depends on ${h.dependencies.join(', ')}`, ru: `, зависит от ${h.dependencies.join(', ')}` });
    }
  }
  return s;
}

/** `kedit mods [list]`: enabled in order (the later one wins), then disabled. */
export function modsList(ws: Workspace, io: ModsOut, options: { json?: boolean; full?: boolean }): number {
  ws.requireGame();
  const { mods, missing, order } = listInstalledMods(ws.paths);
  if (options.json) {
    const withSummary = options.full ? mods.map((m) => ({ ...m, summary: readModSummary(m.path) })) : mods;
    io.out(JSON.stringify({ order, mods: withSummary, missing }, null, 1));
    return 0;
  }
  const active = mods.filter((m) => m.enabled && !m.shadowedBy);
  const rows: { index: number; text: string }[] = [
    ...active.map((m) => ({ index: m.loadIndex!, text: line(m, options.full ?? false, ws) })),
    ...missing.map((e) => ({ index: e.loadIndex, text: `${String(e.loadIndex + 1).padStart(3)}. ${e.fileName}  [${ws.t({ en: 'no file', ru: 'нет файла' })}]` })),
  ].sort((a, b) => a.index - b.index);
  const cfg = `${ws.paths.kenshi}\\data\\mods.cfg`;
  io.out(ws.t({ en: `Load order (${cfg}): lower loads later and wins`, ru: `Порядок загрузки (${cfg}): ниже — грузится позже и побеждает` }));
  for (const r of rows) io.out(r.text);
  const off = mods.filter((m) => !m.enabled || m.shadowedBy);
  if (off.length) {
    io.out(ws.t({ en: 'Disabled:', ru: 'Выключены:' }));
    for (const m of off) io.out(line(m, options.full ?? false, ws));
  }
  io.out(ws.t({
    en: `enabled ${order.length}, installed ${mods.length}${missing.length ? `, missing files ${missing.length}` : ''}`,
    ru: `включено ${order.length}, установлено ${mods.length}${missing.length ? `, нет файлов ${missing.length}` : ''}`,
  }));
  return 0;
}

export interface ModsChangeOptions {
  top?: boolean;
  bottom?: boolean;
  after?: string;
  before?: string;
  force?: boolean;
}

/** Mod file name: `X` → `X.mod`. */
function modFileName(spec: string): string {
  return /\.mod$/i.test(spec) ? spec : `${spec}.mod`;
}

function placeOf(o: ModsChangeOptions): ModPlace | undefined {
  const given = [o.top, o.bottom, o.after !== undefined, o.before !== undefined].filter(Boolean).length;
  if (given > 1) throw new UsageError({ en: 'one place only: --top, --bottom, --after X or --before X', ru: 'место одно: --top, --bottom, --after X или --before X' });
  if (o.top) return { top: true };
  if (o.bottom) return { bottom: true };
  if (o.after !== undefined) return { after: modFileName(o.after) };
  if (o.before !== undefined) return { before: modFileName(o.before) };
  return undefined;
}

/**
 * `kedit mods move|enable|disable <mod>`: new `mods.cfg` order. Without `--force` — only
 * show what will change; with `--force` — write (copy next to it, the game must be closed).
 */
export function modsChange(ws: Workspace, io: ModsOut, op: 'move' | 'enable' | 'disable', spec: string | undefined, o: ModsChangeOptions): number {
  ws.requireGame();
  if (spec === undefined) throw new UsageError({ en: `mods ${op}: a mod name is needed`, ru: `mods ${op}: нужно имя мода` });
  const { mods, order } = listInstalledMods(ws.paths);
  const name = modFileName(spec);
  const installed = mods.find((m) => m.fileName.toLowerCase() === name.toLowerCase() && !m.shadowedBy);
  const inCfg = order.find((n) => n.toLowerCase() === name.toLowerCase());
  const fileName = inCfg ?? installed?.fileName ?? name;
  const place = placeOf(o);
  let change: ModsCfgChange;
  if (op === 'move') {
    if (!place) throw new UsageError({ en: 'mods move: where to? --top, --bottom, --after X or --before X', ru: 'mods move: куда? --top, --bottom, --after X или --before X' });
    change = { op, name: fileName, place };
  } else if (op === 'enable') {
    if (!installed) throw new UsageError({ en: `Mod not installed: ${name} (not in mods/ or the workshop)`, ru: `Мод не установлен: ${name} (нет в mods/ и в мастерской)` });
    change = { op, name: fileName, ...(place ? { place } : {}) };
  } else {
    if (place) throw new UsageError({ en: 'mods disable: no place is needed', ru: 'mods disable: место не нужно' });
    change = { op, name: fileName };
  }
  let next: string[];
  try {
    next = applyModsCfgChange(order, change);
  } catch (e) {
    throw usageFrom(e);
  }
  const diff = describeOrderChange(order, next, ws.lang);
  const path = modsCfgPath(ws.paths);
  if (diff.length === 0) {
    io.out(ws.t({ en: `${path}: no changes`, ru: `${path}: без изменений` }));
    return 0;
  }
  for (const d of diff) io.out(d);
  if (!o.force) {
    io.out(ws.t({ en: `${path} is not changed: it is a game file — add --force to write it (the game and the launcher must be closed)`, ru: `${path} не изменён: это файл игры — чтобы записать, добавьте --force (игра и лаунчер должны быть закрыты)` }));
    return 0;
  }
  let r: ReturnType<typeof writeModsCfg>;
  try {
    r = writeModsCfg(ws.paths, next);
  } catch (e) {
    throw usageFrom(e);
  }
  io.out(ws.t({ en: `${r.path}: written${r.backup ? `, copy: ${r.backup}` : ''}`, ru: `${r.path}: записан${r.backup ? `, копия: ${r.backup}` : ''}` }));
  return 0;
}

/**
 * `kedit mods copy <mod|path> [--name Name] [--force]`: someone else's mod (usually from the Workshop) —
 * byte for byte into `mods/<name>/<name>.mod` with `<name>.kedit-origin.json` next to it (where the copy came from).
 * The original is only read. Without `--force` — only show what will happen.
 */
export function modsCopy(ws: Workspace, io: ModsOut, spec: string | undefined, o: { name?: string; force?: boolean }): number {
  ws.requireGame();
  if (spec === undefined) throw new UsageError({ en: 'mods copy: a mod name or a path to a .mod is needed', ru: 'mods copy: нужно имя мода или путь к .mod' });
  const asPath = resolve(ws.cwd, spec);
  let src = existsSync(asPath) && statSync(asPath).isFile() ? asPath : undefined;
  if (src === undefined) {
    const name = modFileName(spec);
    const same = listInstalledMods(ws.paths).mods.filter((m) => m.fileName.toLowerCase() === name.toLowerCase());
    // There is both a copy and the original — take the original from the Workshop.
    src = (same.find((m) => m.source === 'workshop') ?? same[0])?.path;
  }
  if (src === undefined) throw new UsageError({ en: `Mod not found: ${spec} (not in mods/ or the workshop)`, ru: `Мод не найден: ${spec} (нет в mods/ и в мастерской)` });
  const plan = planModCopy(ws.paths, src, o.name !== undefined ? { name: o.name } : {});
  const wid = plan.origin.workshopId;
  io.out(ws.t({ en: `from: ${plan.source}${wid !== undefined ? ` (workshop ${wid})` : ''}`, ru: `откуда: ${plan.source}${wid !== undefined ? ` (мастерская ${wid})` : ''}` }));
  io.out(ws.t({ en: `to:   ${plan.dest}`, ru: `куда:   ${plan.dest}` }));
  for (const w of plan.warningTexts) io.out(`! ${ws.t(w)}`);
  if (plan.error !== undefined) throw new UsageError(plan.errorText ?? plan.error);
  if (!o.force) {
    io.out(ws.t({ en: 'nothing is written: this is the game folder — add --force to copy', ru: 'ничего не записано: это папка игры — чтобы скопировать, добавьте --force' }));
    return 0;
  }
  copyModForEditing(ws.paths, src, o.name !== undefined ? { name: o.name } : {});
  io.out(ws.t({ en: `copied byte for byte; where the copy came from: ${plan.originPath}`, ru: `скопирован байт в байт; откуда копия — ${plan.originPath}` }));
  return 0;
}
