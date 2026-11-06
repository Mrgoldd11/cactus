/**
 * Панель «Отношения фракций»: таблица «фракция × фракция» с цветом (враги / нейтралы /
 * союзники). Строка — кто относится, столбец — к кому. Пару выбирают кликом по ячейке или вводом
 * названий в два поля с быстрым списком; правка значения — одной отменой (можно сразу в обе
 * стороны), точка — значение меняет мод (какой — во всплывающей
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

/** Сколько подсказок показывать в выпадающем списке. */
const COMBO_ROWS = 12;

interface ComboProps {
  value: string | undefined;
  factions: readonly FactionInfo[];
  label: (f: FactionInfo) => string;
  /** Второе имя (английское при русском интерфейсе и наоборот) — пояснение в подсказках. */
  alt: (f: FactionInfo) => string | undefined;
  placeholder: string;
  title: string;
  testId: string;
  onChange: (sid: string) => void;
}

/**
 * Поле фракции с быстрым списком: печатаете часть названия (англ., рус. или id) — внизу
 * появляются подходящие, ↑↓ и Enter или клик выбирают. Пока поле не в фокусе, показывает
 * выбранную фракцию.
 */
function FactionCombo({ value, factions, label, alt, placeholder, title, testId, onChange }: ComboProps): ReactNode {
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(0);
  const sel = value !== undefined ? factions.find((f) => f.sid === value) : undefined;

  const matches = useMemo(() => {
    const q = (typing ? text : '').trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const out: FactionInfo[] = [];
    for (const f of factions) {
      const hay = `${f.name}\n${f.ru ?? ''}\n${f.sid}`.toLowerCase();
      if (terms.every((x) => hay.includes(x))) out.push(f);
    }
    // Названия, начинающиеся с введённого, — выше тех, где оно в середине.
    const rank = (f: FactionInfo): number => (q !== '' && (label(f).toLowerCase().startsWith(q) || f.name.toLowerCase().startsWith(q)) ? 0 : 1);
    return out.sort((a, b) => rank(a) - rank(b)).slice(0, COMBO_ROWS);
  }, [factions, text, typing, label]);

  const finish = (): void => {
    setTyping(false);
    setOpen(false);
  };
  const choose = (f: FactionInfo | undefined): void => {
    if (f) onChange(f.sid);
    finish();
  };

  return (
    <span className="fac-combo">
      <input
        type="text"
        placeholder={placeholder}
        title={title}
        value={typing ? text : sel ? label(sel) : ''}
        data-testid={testId}
        autoComplete="off"
        onFocus={(e) => {
          e.currentTarget.select();
          setCur(0);
          setOpen(true);
        }}
        onChange={(e) => {
          setText(e.target.value);
          setTyping(true);
          setCur(0);
          setOpen(true);
        }}
        onBlur={() => {
          // Набрали название целиком и ушли из поля — считаем выбором, если оно одно.
          if (typing) {
            const exact = text.trim().toLowerCase();
            const one = exact === '' ? [] : factions.filter((f) => label(f).toLowerCase() === exact || f.name.toLowerCase() === exact || f.sid === text.trim());
            if (one.length === 1) onChange(one[0]!.sid);
          }
          finish();
        }}
        onKeyDown={(e) => {
          const k = shortcut(e);
          if (k === 'arrowdown' || k === 'arrowup') {
            e.preventDefault();
            setOpen(true);
            setCur((c) => Math.max(0, Math.min(matches.length - 1, c + (k === 'arrowdown' ? 1 : -1))));
          } else if (k === 'enter' && open && matches.length > 0) {
            e.preventDefault();
            choose(matches[Math.min(cur, matches.length - 1)]);
          } else if (k === 'escape' && open) {
            e.stopPropagation();
            finish();
          }
        }}
      />
      {open && (
        <ul className="fac-combo-list" role="listbox" data-testid={`${testId}-list`}>
          {matches.length === 0 ? (
            <li className="muted">—</li>
          ) : (
            matches.map((f, i) => (
              <li
                key={f.sid}
                role="option"
                aria-selected={i === cur}
                className={i === cur ? 'cur' : ''}
                title={f.sid}
                // mousedown, а не click: иначе поле успеет потерять фокус и закрыть список раньше.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(f);
                }}
                onMouseEnter={() => { setCur(i); }}
              >
                {label(f)}
                {alt(f) && alt(f) !== label(f) && <span className="muted"> · {alt(f)}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </span>
  );
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
  // Пара выбирается кликом по ячейке или вводом названий в два поля; правим, когда выбраны обе.
  const [fromSid, setFromSid] = useState<string | undefined>();
  const [toSid, setToSid] = useState<string | undefined>();
  const pick: Pick | undefined = fromSid !== undefined && toSid !== undefined ? { from: fromSid, to: toSid } : undefined;
  const setPick = (p: Pick | undefined): void => {
    setFromSid(p?.from);
    setToSid(p?.to);
  };
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

  const fromF = fromSid !== undefined ? byId.get(fromSid) : undefined;
  const toF = toSid !== undefined ? byId.get(toSid) : undefined;
  const alt = (f: FactionInfo): string | undefined => (ru ? f.name : f.ru);

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
      <div className="muted mods-panel-note fac-note">
        <div className="fac-help" data-testid="fac-help">
          <button className="fac-help-btn" aria-label={t.facHelpTip}>
            ?
          </button>
          <div className="fac-help-pop" role="tooltip">
            <strong>{t.facHelpTitle}</strong>
            <table>
              <thead>
                <tr>
                  <th>{t.facHelpHead[0]}</th>
                  <th>{t.facHelpHead[1]}</th>
                </tr>
              </thead>
              <tbody>
                {t.facHelpRows.map(([when, what]) => (
                  <tr key={when}>
                    <td>{when}</td>
                    <td>{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>{' '}
        {t.facNote}
      </div>
      <div className="fac-edit" data-testid="fac-edit">
        <FactionCombo value={fromSid} factions={matrix.factions} label={label} alt={alt} placeholder={t.facWho} title={t.facWhoTip} testId="fac-from" onChange={setFromSid} />
        {fromF && (
          <button className="link" onClick={() => { go(fromF.sid); }} title={`${t.facOpen}: ${fromF.sid}`}>
            ↗
          </button>
        )}
        <span>→</span>
        <FactionCombo value={toSid} factions={matrix.factions} label={label} alt={alt} placeholder={t.facWhom} title={t.facWhomTip} testId="fac-to" onChange={setToSid} />
        {toF && (
          <button className="link" onClick={() => { go(toF.sid); }} title={`${t.facOpen}: ${toF.sid}`}>
            ↗
          </button>
        )}
        <input
          type="number"
          min={-100}
          max={100}
          step={1}
          title={t.facValue}
          value={value}
          disabled={!picked}
          onChange={(e) => { setValue(e.target.value); }}
          onKeyDown={(e) => {
            const k = shortcut(e);
            if (k === 'enter') submit();
            else if (k === 'escape') setPick(undefined);
          }}
          data-testid="fac-value"
        />
        <button className="primary" onClick={submit} disabled={!picked} data-testid="fac-set">
          {t.facSet}
        </button>
        <button onClick={() => { apply(undefined); }} disabled={!picked?.explicit} title={t.facResetTip} data-testid="fac-reset">
          {t.facReset}
        </button>
        <label title={t.facBothTip}>
          <input type="checkbox" checked={both} onChange={(e) => { setBoth(e.target.checked); }} data-testid="fac-both" /> {t.facBoth}
        </label>
        {picked ? <span className={`fac-kind fac-${picked.kind}`}>{picked.explicit ? t.facExplicit : t.facDefault}</span> : <span className="muted">{t.facPick}</span>}
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
