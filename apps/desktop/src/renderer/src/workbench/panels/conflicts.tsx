/**
 * Панель «Конфликты»: какие загруженные моды (зависимости, моды контекста, сам мод) задают
 * одно и то же поле одной записи по-разному, значения каждого слоя по порядку загрузки
 * и кто победит. Клик по записи — переход к ней. Считается по слоям в памяти, без диска.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { contextLayers, findConflicts, isVanillaLayer, type FieldConflict, type RecordConflict } from '@kenshi-editor/core';
import { useT, type Strings } from '../../i18n.ts';
import { useProjectVersion } from '../../hooks.ts';
import type { Project } from '../../project.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Строк в таблице за раз: дальше — уточнить поиск. */
const MAX_ROWS = 300;

export function conflictFieldLabel(t: Strings, project: Project, f: FieldConflict): string {
  switch (f.kind) {
    case 'record':
      return t.conflictWhole;
    case 'name':
      return t.conflictName;
    case 'scalar':
      return f.key!;
    case 'ref':
      return `${f.category} → ${project.ctx.name(f.target!) ?? f.target}`;
    case 'instance':
      return `${t.conflictObject} ${f.key}`;
  }
}

/** Конфликты проекта; `only` — имя мода, чьи конфликты нужны. */
export function projectConflicts(project: Project, only?: string): RecordConflict[] {
  return findConflicts(contextLayers(project.ctx), only !== undefined ? { only } : {});
}

function ConflictsPanel(): ReactNode {
  const t = useT();
  const { project, go } = useWorkbench();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const hasOwn = ctx.modRecords().length > 0;
  const [onlyMine, setOnlyMine] = useState(true);
  const [query, setQuery] = useState('');
  const mods = useMemo(() => contextLayers(ctx).filter((l) => !isVanillaLayer(l.name)).length, [ctx, version]);
  const only = onlyMine && hasOwn ? ctx.modName : undefined;
  const found = useMemo(() => projectConflicts(project, only), [project, only, version]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: { c: RecordConflict; f: FieldConflict; label: string }[] = [];
    for (const c of found) {
      for (const f of c.fields) {
        const label = conflictFieldLabel(t, project, f);
        if (q !== '' && !`${c.sid}\n${c.name}\n${label}\n${f.values.map((v) => v.layer).join('\n')}`.toLowerCase().includes(q)) continue;
        out.push({ c, f, label });
      }
    }
    return out;
  }, [found, query, t, project]);
  const fields = found.reduce((n, c) => n + c.fields.length, 0);

  return (
    <div className="mods-panel" data-testid="conflicts-panel">
      <div className="mods-panel-bar">
        <input type="search" placeholder={t.conflictsSearch} value={query} onChange={(e) => { setQuery(e.target.value); }} data-testid="conflicts-search" />
        <label title={t.conflictsOnlyMineTip}>
          <input type="checkbox" checked={onlyMine && hasOwn} disabled={!hasOwn} onChange={(e) => { setOnlyMine(e.target.checked); }} data-testid="conflicts-only-mine" />{' '}
          {t.conflictsOnlyMine}
        </label>
        <span className="muted" data-testid="conflicts-summary">
          {t.conflictsSummary(found.length, fields)}
        </span>
      </div>
      <div className="muted mods-panel-note">{t.conflictsNote}</div>
      {mods < 2 ? (
        <Empty text={t.conflictsNoMods} />
      ) : rows.length === 0 ? (
        <Empty text={t.conflictsNone} />
      ) : (
        <div className="table-wrap">
          <table className="table conflicts-table" data-testid="conflicts-table">
            <thead>
              <tr>
                <th>{t.colRecord}</th>
                <th>{t.colField}</th>
                <th>{t.colVanilla}</th>
                <th>{t.colValues}</th>
                <th>{t.colWinner}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map(({ c, f, label }) => (
                <tr key={`${c.sid}\n${f.id}`} data-sid={c.sid} data-field={f.id}>
                  <td>
                    <button className="link" onClick={() => { go(c.sid); }} title={c.sid}>
                      {c.name}
                    </button>
                  </td>
                  <td className="mono">{label}</td>
                  <td className="mono muted">{f.base !== undefined ? t.conflictValue(f.base) : ''}</td>
                  <td>
                    {f.values.map((v) => (
                      <div key={v.layer} className={v.layer === f.winner ? 'conflict-winner' : 'muted'}>
                        <span className="mono">{t.conflictValue(v.value)}</span> — {v.layer}
                      </div>
                    ))}
                  </td>
                  <td className="conflict-winner" data-testid="conflict-winner">
                    {f.winner}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > MAX_ROWS && <div className="muted">{`${MAX_ROWS} / ${rows.length}`}</div>}
        </div>
      )}
    </div>
  );
}

registerPanel({
  id: 'conflicts', group: 'mod',
  title: (t) => t.panel_conflicts,
  icon: '⚔',
  component: ConflictsPanel,
  area: 'center',
  order: 45,
  hint: (t) => t.conflictsHint,
});
