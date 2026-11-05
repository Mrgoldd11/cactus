/**
 * Панель «Отношения фракций»: таблица «фракция × фракция» с цветом (враги / нейтралы /
 * союзники). Строка — кто относится, столбец — к кому. Клик по ячейке — правка значения одной
 * отменой (можно сразу в обе стороны), точка — значение меняет мод (какой — во всплывающей
 * подсказке), фильтр по имени и по моду. Считается по слоям в памяти, без диска.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { factionMatrix, setFactionRelation, type FactionInfo, type RelationCell } from '@kenshi-editor/core';
import { useLang, useT, type Strings } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { shortcut } from '../../keys.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Фракций в таблице за раз (строк и столбцов): дальше — уточнить фильтр. */
const MAX_FACTIONS = 80;

interface Pick {
  from: string;
  to: string;
}

function cellTip(t: Strings, from: string, to: string, c: RelationCell, back: number | undefined): string {
  const lines = [`${from} → ${to}: ${c.value} (${c.explicit ? t.facExplicit : t.facDefault}, ${{ enemy: t.facEnemy, neutral: t.facNeutral, ally: t.facAlly }[c.kind]})`];
  if (back !== undefined) lines.push(t.facBack(back));
  if (c.coexist) lines.push(t.facCoexist);
  if (c.touches.length > 0) {
    lines.push(t.facChangedBy);
    for (const x of c.touches) lines.push(`  ${x.layer}: ${x.value === undefined ? t.facRemoves : x.value}`);
  }
  return lines.join('\n');
}

function FactionsPanel(): ReactNode {
  const t = useT();
  const ru = useLang() === 'ru';
  const { project, go, report } = useWorkbench();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const [query, setQuery] = useState('');
  const [onlyLinked, setOnlyLinked] = useState(true);
  const [layer, setLayer] = useState('');
  const [pick, setPick] = useState<Pick | undefined>();
  const [value, setValue] = useState('');
  const [both, setBoth] = useState(false);

  const matrix = useMemo(() => factionMatrix(ctx, { ids: project.idsByType().get('FACTION') ?? [] }), [project, ctx, version]);
  const label = (f: FactionInfo): string => (ru ? (f.ru ?? f.name) : f.name);
  const byId = useMemo(() => new Map(matrix.factions.map((f) => [f.sid, f])), [matrix]);

  const shown = useMemo(() => {
    let list = matrix.factions;
    if (onlyLinked) {
      const linked = new Set<string>();
      for (const f of list) {
        if (f.listed === 0) continue;
        linked.add(f.sid);
        for (const g of list) if (g.sid !== f.sid && matrix.cell(f.sid, g.sid).explicit) linked.add(g.sid);
      }
      list = list.filter((f) => linked.has(f.sid));
    }
    if (layer !== '') {
      const keep = new Set<string>();
      for (const f of list) {
        if (!matrix.layersOf(f.sid).includes(layer)) continue;
        keep.add(f.sid);
        for (const g of matrix.factions) if (matrix.cell(f.sid, g.sid).touches.some((x) => x.layer === layer)) keep.add(g.sid);
      }
      list = matrix.factions.filter((f) => keep.has(f.sid));
    }
    const q = query.trim().toLowerCase();
    if (q !== '') list = list.filter((f) => `${f.sid}\n${f.name}\n${f.ru ?? ''}`.toLowerCase().includes(q));
    return list;
  }, [matrix, onlyLinked, layer, query]);
  const visible = shown.slice(0, MAX_FACTIONS);

  const picked = pick ? matrix.cell(pick.from, pick.to) : undefined;
  useEffect(() => {
    if (picked) setValue(String(picked.value));
    // значение поля — от выбранной ячейки и после каждой правки
  }, [pick?.from, pick?.to, picked?.value]);

  const apply = (v: number | undefined): void => {
    if (!pick) return;
    report(tryEdit(() => { setFactionRelation(ctx, pick.from, pick.to, v, { both }); }));
  };
  const submit = (): void => {
    const n = Number(value.trim().replace('−', '-'));
    if (value.trim() === '' || !Number.isFinite(n)) {
      report(t.facValue);
      return;
    }
    apply(n);
  };

  const fromF = pick ? byId.get(pick.from) : undefined;
  const toF = pick ? byId.get(pick.to) : undefined;

  return (
    <div className="mods-panel" data-testid="factions-panel">
      <div className="mods-panel-bar">
        <input type="search" placeholder={t.facSearch} value={query} onChange={(e) => { setQuery(e.target.value); }} data-testid="fac-search" />
        <label title={t.facOnlyLinkedTip}>
          <input type="checkbox" checked={onlyLinked} onChange={(e) => { setOnlyLinked(e.target.checked); }} data-testid="fac-only-linked" /> {t.facOnlyLinked}
        </label>
        <label>
          {t.facMod}{' '}
          <select value={layer} onChange={(e) => { setLayer(e.target.value); }} data-testid="fac-layer">
            <option value="">{t.facModAll}</option>
            {matrix.layers.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <span className="muted" data-testid="fac-summary">
          {t.facSummary(shown.length, matrix.factions.length)}
        </span>
      </div>
      <div className="muted mods-panel-note">{t.facNote}</div>
      <div className="fac-edit" data-testid="fac-edit">
        {pick && fromF && toF && picked ? (
          <>
            <button className="link" onClick={() => { go(fromF.sid); }} title={`${t.facOpen}: ${fromF.sid}`}>
              {label(fromF)}
            </button>
            <span>→</span>
            <button className="link" onClick={() => { go(toF.sid); }} title={`${t.facOpen}: ${toF.sid}`}>
              {label(toF)}
            </button>
            <input
              type="number"
              min={-100}
              max={100}
              step={1}
              title={t.facValue}
              value={value}
              onChange={(e) => { setValue(e.target.value); }}
              onKeyDown={(e) => {
                const k = shortcut(e);
                if (k === 'enter') submit();
                else if (k === 'escape') setPick(undefined);
              }}
              data-testid="fac-value"
            />
            <button className="primary" onClick={submit} data-testid="fac-set">
              {t.facSet}
            </button>
            <button onClick={() => { apply(undefined); }} disabled={!picked.explicit} title={t.facResetTip} data-testid="fac-reset">
              {t.facReset}
            </button>
            <label title={t.facBothTip}>
              <input type="checkbox" checked={both} onChange={(e) => { setBoth(e.target.checked); }} data-testid="fac-both" /> {t.facBoth}
            </label>
            <span className={`fac-kind fac-${picked.kind}`}>{picked.explicit ? t.facExplicit : t.facDefault}</span>
          </>
        ) : (
          <span className="muted">{t.facPick}</span>
        )}
      </div>
      {visible.length === 0 ? (
        <Empty text={t.facNone} />
      ) : (
        <div className="table-wrap fac-wrap">
          <table className="fac-matrix" data-testid="fac-matrix">
            <thead>
              <tr>
                <th className="fac-corner" />
                {visible.map((g) => (
                  <th key={g.sid} className="fac-col" title={`${label(g)}\n${g.sid}`}>
                    <span>{label(g)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((f) => (
                <tr key={f.sid}>
                  <th className="fac-row" title={`${f.sid}\ndefault relation ${f.defaultRelation}, enemy classification ${f.enemyClassification}`}>
                    <button className="link" onClick={() => { go(f.sid); }}>
                      {label(f)}
                    </button>
                  </th>
                  {visible.map((g) => {
                    const c = matrix.cell(f.sid, g.sid);
                    const sel = pick?.from === f.sid && pick.to === g.sid;
                    const cls = ['fac-cell', `fac-${c.kind}`, c.explicit ? '' : 'fac-implicit', sel ? 'fac-sel' : '', f.sid === g.sid ? 'fac-self' : ''].filter(Boolean).join(' ');
                    return (
                      <td
                        key={g.sid}
                        className={cls}
                        title={cellTip(t, label(f), label(g), c, matrix.asymmetry(f.sid, g.sid))}
                        onClick={() => { setPick({ from: f.sid, to: g.sid }); }}
                        data-testid="fac-cell"
                        data-from={f.sid}
                        data-to={g.sid}
                        data-value={c.value}
                      >
                        {c.value}
                        {c.touches.length > 0 && <span className="fac-dot" data-testid="fac-touched" />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > MAX_FACTIONS && <div className="muted">{t.facCap(MAX_FACTIONS)}</div>}
        </div>
      )}
    </div>
  );
}

registerPanel({
  id: 'factions',
  title: (t) => t.panel_factions,
  icon: '⚑',
  component: FactionsPanel,
  area: 'center',
  order: 50,
  hint: (t) => t.factionsHint,
});
