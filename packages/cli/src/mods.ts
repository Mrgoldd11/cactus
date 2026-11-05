/**
 * kedit mods — установленные моды и порядок загрузки (`data/mods.cfg`).
 */
import { applyModsCfgChange, describeOrderChange, type ModPlace, type ModsCfgChange } from '@kenshi-editor/core';
import { listInstalledMods, modsCfgPath, readModSummary, writeModsCfg, type InstalledMod } from '@kenshi-editor/core/node';
import { UsageError, type Workspace } from './workspace.ts';

export interface ModsOut {
  out(line: string): void;
}

function where(m: InstalledMod): string {
  return m.source === 'workshop' ? `мастерская ${m.workshopId}` : 'mods';
}

/** Строка мода для списка: место, имя, откуда; с `full` — автор, записей, зависимости. */
function line(m: InstalledMod, full: boolean): string {
  const pos = m.loadIndex !== undefined ? `${String(m.loadIndex + 1).padStart(3)}.` : '    ';
  let s = `${pos} ${m.fileName}  [${where(m)}]`;
  if (m.shadowedBy) s += '  (не грузится: есть такой же в mods/)';
  if (full) {
    const h = readModSummary(m.path);
    if (h.error) s += `  ошибка: ${h.error}`;
    else {
      s += `  записей ${h.recordCount ?? '?'}`;
      if (h.author) s += `, автор ${h.author}`;
      if (h.dependencies?.length) s += `, зависит от ${h.dependencies.join(', ')}`;
    }
  }
  return s;
}

/** `kedit mods [list]`: включённые по порядку (поздний побеждает), затем выключенные. */
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
    ...active.map((m) => ({ index: m.loadIndex!, text: line(m, options.full ?? false) })),
    ...missing.map((e) => ({ index: e.loadIndex, text: `${String(e.loadIndex + 1).padStart(3)}. ${e.fileName}  [нет файла]` })),
  ].sort((a, b) => a.index - b.index);
  io.out(`Порядок загрузки (${ws.paths.kenshi}\\data\\mods.cfg): ниже — грузится позже и побеждает`);
  for (const r of rows) io.out(r.text);
  const off = mods.filter((m) => !m.enabled || m.shadowedBy);
  if (off.length) {
    io.out('Выключены:');
    for (const m of off) io.out(line(m, options.full ?? false));
  }
  io.out(`включено ${order.length}, установлено ${mods.length}${missing.length ? `, нет файлов ${missing.length}` : ''}`);
  return 0;
}

export interface ModsChangeOptions {
  top?: boolean;
  bottom?: boolean;
  after?: string;
  before?: string;
  force?: boolean;
}

/** Имя файла мода: `X` → `X.mod`. */
function modFileName(spec: string): string {
  return /\.mod$/i.test(spec) ? spec : `${spec}.mod`;
}

function placeOf(o: ModsChangeOptions): ModPlace | undefined {
  const given = [o.top, o.bottom, o.after !== undefined, o.before !== undefined].filter(Boolean).length;
  if (given > 1) throw new UsageError('место одно: --top, --bottom, --after X или --before X');
  if (o.top) return { top: true };
  if (o.bottom) return { bottom: true };
  if (o.after !== undefined) return { after: modFileName(o.after) };
  if (o.before !== undefined) return { before: modFileName(o.before) };
  return undefined;
}

/**
 * `kedit mods move|enable|disable <мод>`: новый порядок `mods.cfg`. Без `--force` — только
 * показать, что изменится; с `--force` — записать (копия рядом, игра должна быть закрыта).
 */
export function modsChange(ws: Workspace, io: ModsOut, op: 'move' | 'enable' | 'disable', spec: string | undefined, o: ModsChangeOptions): number {
  ws.requireGame();
  if (spec === undefined) throw new UsageError(`mods ${op}: нужно имя мода`);
  const { mods, order } = listInstalledMods(ws.paths);
  const name = modFileName(spec);
  const installed = mods.find((m) => m.fileName.toLowerCase() === name.toLowerCase() && !m.shadowedBy);
  const inCfg = order.find((n) => n.toLowerCase() === name.toLowerCase());
  const fileName = inCfg ?? installed?.fileName ?? name;
  const place = placeOf(o);
  let change: ModsCfgChange;
  if (op === 'move') {
    if (!place) throw new UsageError('mods move: куда? --top, --bottom, --after X или --before X');
    change = { op, name: fileName, place };
  } else if (op === 'enable') {
    if (!installed) throw new UsageError(`Мод не установлен: ${name} (нет в mods/ и в мастерской)`);
    change = { op, name: fileName, ...(place ? { place } : {}) };
  } else {
    if (place) throw new UsageError('mods disable: место не нужно');
    change = { op, name: fileName };
  }
  let next: string[];
  try {
    next = applyModsCfgChange(order, change);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const diff = describeOrderChange(order, next);
  const path = modsCfgPath(ws.paths);
  if (diff.length === 0) {
    io.out(`${path}: без изменений`);
    return 0;
  }
  for (const d of diff) io.out(d);
  if (!o.force) {
    io.out(`${path} не изменён: это файл игры — чтобы записать, добавьте --force (игра и лаунчер должны быть закрыты)`);
    return 0;
  }
  let r: ReturnType<typeof writeModsCfg>;
  try {
    r = writeModsCfg(ws.paths, next);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  io.out(`${r.path}: записан${r.backup ? `, копия: ${r.backup}` : ''}`);
  return 0;
}
