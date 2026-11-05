/**
 * kedit mods — установленные моды и порядок загрузки (`data/mods.cfg`).
 */
import { listInstalledMods, readModSummary, type InstalledMod } from '@kenshi-editor/core/node';
import type { Workspace } from './workspace.ts';

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
