/**
 * Панель «Моды»: установленные моды (папка `mods/` и мастерская), их место в `mods.cfg`,
 * и какие из них лежат слоями под редактируемым модом («контекст»). Список строится по
 * заголовкам (начало файлов) при открытии панели; сами моды читаются, только когда их
 * включают в контекст — через кэш разобранных файлов, как ваниль.
 *
 * Порядок загрузки: строки включённых модов можно перетаскивать (или ▲▼), галочка «В игре»
 * включает/выключает мод. Это черновик; «Записать mods.cfg» отправляет его в main, который
 * спрашивает подтверждение (это файл игры), проверяет, что игра закрыта, и оставляет копию.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { applyModsCfgChange, describeOrderChange, isVanillaLayer, modIndex, placeMod, type ModPlace } from '@kenshi-editor/core';
import type { GameInstallInfo, ModEntry } from '../../../../shared/api.ts';
import { useT, type Strings } from '../../i18n.ts';
import { useProjectVersion } from '../../hooks.ts';
import type { Project } from '../../project.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';

/** Список модов на игру: читается один раз, «Обновить» читает заново. */
const listCache = new Map<string, Promise<ModEntry[]>>();

export function installedMods(game: GameInstallInfo, refresh = false): Promise<ModEntry[]> {
  let p = listCache.get(game.kenshi);
  if (!p || refresh) {
    p = window.kedit.listMods(game);
    listCache.set(game.kenshi, p);
    p.catch(() => listCache.delete(game.kenshi));
  }
  return p;
}

export function useInstalledMods(game: GameInstallInfo): { mods: ModEntry[] | undefined; error: string | undefined; refresh: () => void } {
  const [mods, setMods] = useState<ModEntry[]>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    installedMods(game, tick > 0).then(
      (m) => {
        if (alive) setMods(m);
      },
      (e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [game, tick]);
  return { mods, error, refresh: () => { setTick((n) => n + 1); } };
}

/** Моды, которые игра грузит: включены и не перекрыты таким же файлом из `mods/`. */
export function activeMods(mods: readonly ModEntry[]): ModEntry[] {
  return mods.filter((m) => m.enabled && !m.shadowedBy).sort((a, b) => (a.loadIndex ?? 0) - (b.loadIndex ?? 0));
}

type Role = 'self' | 'dep' | 'context' | undefined;

function roleOf(project: Project, fileName: string): Role {
  const k = fileName.toLowerCase();
  if (project.ctx.modName.toLowerCase() === k) return 'self';
  if (project.contextMods.some((n) => n.toLowerCase() === k)) return 'context';
  if (project.bundle.dependencies.some((d) => d.name.toLowerCase() === k)) return 'dep';
  return undefined;
}

export function sourceLabel(t: Strings, m: ModEntry): string {
  if (m.copyOf !== undefined) return t.modsCopyOf(m.copyOf);
  return m.source === 'workshop' ? `${t.modsWorkshop} ${m.workshopId ?? ''}`.trim() : m.source;
}

type Filter = 'all' | 'enabled' | 'context';

type OrderMsg = { text: string; error?: boolean };

/** Порядок `mods.cfg`: записанный (`saved`) и черновик правок (`order`). */
function useModOrder(game: GameInstallInfo): {
  saved: string[] | undefined;
  order: string[] | undefined;
  setOrder: (o: string[]) => void;
  markSaved: (o: string[]) => void;
  reread: () => void;
} {
  const [saved, setSaved] = useState<string[]>();
  const [order, setOrder] = useState<string[]>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    window.kedit.readModOrder(game).then(
      (o) => {
        if (!alive) return;
        setSaved(o);
        setOrder(o);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [game, tick]);
  return {
    saved,
    order,
    setOrder,
    markSaved: (o) => {
      setSaved(o);
      setOrder(o);
    },
    reread: () => { setTick((n) => n + 1); },
  };
}

function ModsPanel(): ReactNode {
  const t = useT();
  const { project, reload } = useWorkbench();
  useProjectVersion(project);
  const game = project.bundle.game;
  const { mods, error, refresh } = useInstalledMods(game);
  const { saved, order, setOrder, markSaved, reread } = useModOrder(game);
  const [orderMsg, setOrderMsg] = useState<OrderMsg>();
  const dragged = useRef<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  // Выбор до «Применить»: имена файлов в контексте.
  const current = project.contextMods;
  const [picked, setPicked] = useState<string[]>(current);
  useEffect(() => {
    setPicked(project.contextMods);
  }, [project]);
  const pickedSet = useMemo(() => new Set(picked.map((n) => n.toLowerCase())), [picked]);
  const changed = picked.length !== current.length || current.some((n) => !pickedSet.has(n.toLowerCase()));

  const shown = useMemo(() => {
    if (!mods) return [];
    const q = query.trim().toLowerCase();
    const list = mods.filter((m) => {
      if (filter === 'enabled' && !m.enabled) return false;
      if (filter === 'context' && !pickedSet.has(m.fileName.toLowerCase()) && roleOf(project, m.fileName) !== 'dep') return false;
      return q === '' || `${m.fileName}\n${m.author ?? ''}\n${m.workshopId ?? ''}`.toLowerCase().includes(q);
    });
    // Места — по черновику порядка (до записи он может отличаться от mods.cfg).
    const rank = (m: ModEntry): number => {
      const i = order && !m.shadowedBy ? modIndex(order, m.fileName) : -1;
      return i >= 0 ? i : 100_000;
    };
    return list.sort((a, b) => rank(a) - rank(b) || a.fileName.localeCompare(b.fileName));
  }, [mods, query, filter, pickedSet, project, order]);
  const orderChanges = saved && order ? describeOrderChange(saved, order).length : 0;

  const placeIn = (name: string, place: ModPlace): void => {
    if (order) setOrder(placeMod(order, name, place));
  };
  const setInGame = (name: string, on: boolean): void => {
    if (order) setOrder(applyModsCfgChange(order, on ? { op: 'enable', name } : { op: 'disable', name }));
  };
  const onDrop = (e: DragEvent, target: string): void => {
    e.preventDefault();
    const from = dragged.current;
    dragged.current = undefined;
    if (!order || from === undefined || from.toLowerCase() === target.toLowerCase()) return;
    placeIn(from, modIndex(order, from) < modIndex(order, target) ? { after: target } : { before: target });
  };
  const saveOrder = async (): Promise<void> => {
    if (!order || !saved) return;
    setBusy(true);
    setOrderMsg(undefined);
    try {
      const r = await window.kedit.writeModOrder(game, order, saved);
      if (r.ok) {
        markSaved(order);
        setOrderMsg({ text: t.modsOrderSaved(r.backup ?? '—') });
        refresh();
        // Зависимости и моды контекста стоят по mods.cfg: пересобрать слои в новом порядке.
        if (project.bundle.dependencies.length > 1) await reload({ contextMods: project.contextMods });
      } else if (r.stale === true) {
        setOrderMsg({ text: t.modsOrderStale, error: true });
        reread();
        refresh();
      } else if (!r.cancelled) setOrderMsg({ text: t.modsOrderError(r.error ?? '?'), error: true });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: string, on: boolean): void => {
    setPicked((p) => (on ? [...p, name] : p.filter((n) => n.toLowerCase() !== name.toLowerCase())));
  };
  const allEnabled = (): void => {
    if (!mods) return;
    setPicked(activeMods(mods).map((m) => m.fileName).filter((n) => roleOf(project, n) !== 'self' && roleOf(project, n) !== 'dep'));
  };
  const apply = (): void => {
    setBusy(true);
    void reload({ contextMods: picked }).finally(() => { setBusy(false); });
  };

  const depCount = project.bundle.dependencies.length - current.length;
  return (
    <div className="mods-panel" data-testid="mods-panel">
      <div className="mods-panel-bar">
        <input
          type="search"
          placeholder={t.modsSearch}
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
          data-testid="mods-panel-search"
        />
        <select value={filter} onChange={(e) => { setFilter(e.target.value as Filter); }} data-testid="mods-panel-filter">
          <option value="all">{t.modsFilterAll}</option>
          <option value="enabled">{t.modsFilterEnabled}</option>
          <option value="context">{t.modsFilterContext}</option>
        </select>
        <button className="small" onClick={allEnabled} disabled={!mods || busy} title={t.modsAllEnabledTip} data-testid="mods-all-enabled">
          {t.modsAllEnabled}
        </button>
        <button className="small" onClick={() => { setPicked([]); }} disabled={busy || picked.length === 0}>
          {t.modsClear}
        </button>
        <button className="small primary" onClick={apply} disabled={!changed || busy} data-testid="mods-apply">
          {busy ? t.loading : t.modsApply}
        </button>
        <button
          className="small"
          onClick={() => {
            refresh();
            reread();
          }}
          title={t.modsRefresh}
          disabled={busy}
        >
          ⟳
        </button>
      </div>
      <div className="muted mods-panel-note">
        {t.modsLayers(depCount, current.length)} {t.modsContextNote}
      </div>
      {orderChanges > 0 && (
        <div className="mods-panel-bar" data-testid="mods-order-bar">
          <span className="changed" data-testid="mods-order-changed">
            {t.modsOrderChanged(orderChanges)}
          </span>
          <button className="small primary" onClick={() => void saveOrder()} disabled={busy} title={t.modsOrderSaveTip} data-testid="mods-order-save">
            {t.modsOrderSave}
          </button>
          <button className="small" onClick={() => { if (saved) setOrder(saved); }} disabled={busy} data-testid="mods-order-reset">
            {t.modsOrderReset}
          </button>
        </div>
      )}
      {orderMsg && (
        <div className={orderMsg.error ? 'error' : 'muted'} data-testid="mods-order-msg">
          {orderMsg.text}
        </div>
      )}
      {error !== undefined && <div className="error">{error}</div>}
      {mods === undefined && error === undefined ? (
        <div className="muted">{t.loading}</div>
      ) : (
        <div className="table-wrap">
          <table className="table" data-testid="mods-panel-table">
            <thead>
              <tr>
                <th title={t.colInContextTip}>
                  {t.colInContext}{' '}
                  <span className="help-mark" aria-label={t.colInContextHelp}>ⓘ</span>
                </th>
                <th title={t.colInGameTip}>{t.colInGame}</th>
                <th className="num" title={t.colLoadOrderTip}>
                  {t.colLoadOrder}
                </th>
                <th>{t.colMod}</th>
                <th>{t.colSource}</th>
                <th className="num">{t.colRecords}</th>
                <th>{t.colDeps}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const role = roleOf(project, m.fileName);
                const fixed = role === 'self' || role === 'dep';
                const on = fixed || pickedSet.has(m.fileName.toLowerCase());
                const at = order && !m.shadowedBy ? modIndex(order, m.fileName) : -1;
                const inGame = at >= 0;
                const wasAt = saved ? modIndex(saved, m.fileName) : -1;
                const canOrder = !m.shadowedBy && !busy && order !== undefined;
                const last = (order?.length ?? 0) - 1;
                return (
                  <tr
                    key={m.path}
                    className={m.shadowedBy ? 'muted' : undefined}
                    title={m.shadowedBy ? `${t.modsShadowed}: ${m.shadowedBy}` : (m.error ?? m.path)}
                    draggable={canOrder && inGame}
                    onDragStart={(e) => {
                      dragged.current = m.fileName;
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', m.fileName);
                    }}
                    onDragOver={(e) => {
                      if (canOrder && inGame && dragged.current !== undefined) e.preventDefault();
                    }}
                    onDrop={(e) => { onDrop(e, m.fileName); }}
                    data-testid={`mod-row-${m.fileName}`}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={fixed || busy || m.shadowedBy !== undefined || m.error !== undefined}
                        onChange={(e) => { toggle(m.fileName, e.target.checked); }}
                        data-testid={`ctx-${m.fileName}`}
                      />
                      {role === 'self' && <span className="tag">{t.modsRoleSelf}</span>}
                      {role === 'dep' && <span className="tag">{t.modsRoleDep}</span>}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={inGame}
                        disabled={!canOrder || m.error !== undefined}
                        onChange={(e) => { setInGame(m.fileName, e.target.checked); }}
                        title={t.colInGameTip}
                        data-testid={`cfg-${m.fileName}`}
                      />
                    </td>
                    <td className={`num mod-order${inGame && at !== wasAt ? ' changed' : ''}`} title={inGame ? t.modsOrderDragTip : undefined} data-testid={`order-${m.fileName}`}>
                      {inGame && (
                        <>
                          <span className="drag-handle">⠿</span>
                          <button className="icon" disabled={!canOrder || at === 0} onClick={() => { placeIn(m.fileName, { index: at - 1 }); }} title={t.modsOrderUp} data-testid={`order-up-${m.fileName}`}>
                            ▲
                          </button>
                          <button className="icon" disabled={!canOrder || at === last} onClick={() => { placeIn(m.fileName, { index: at + 1 }); }} title={t.modsOrderDown} data-testid={`order-down-${m.fileName}`}>
                            ▼
                          </button>
                          <span className="mod-order-num">{at + 1}</span>
                        </>
                      )}
                    </td>
                    <td>
                      {m.fileName}
                      {m.error !== undefined && <span className="error"> ⚠</span>}
                    </td>
                    <td>{sourceLabel(t, m)}</td>
                    <td className="num">{m.recordCount}</td>
                    <td className="muted">{(m.dependencies ?? []).filter((d) => !isVanillaLayer(d)).join(', ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

registerPanel({
  id: 'mods',
  title: (t) => t.panel_mods,
  icon: '⧉',
  component: ModsPanel,
  area: 'center',
  order: 40,
  hint: (t) => t.modsHint,
});
