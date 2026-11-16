/**
 * Панель «Графы»: дерево исследований (что нужно → что открывает, цена, чертежи), крафт
 * (станок → что делает → из чего) и состав отрядов и городов (кто, сколько, шанс, торговцы).
 * Щелчок по узлу — подробности, переход к записи и в «Где в игре», правка значений связи
 * (сколько, шанс, приоритет…) одной отменой. Данные — из ядра (`researchGraph`,
 * `craftingStations`, `townComposition`, `squadComposition`), раскладка — общая с графом диалога.
 */
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import {
  craftingStations,
  ingredientsOf,
  researchGraph,
  setLinkValues,
  squadComposition,
  townComposition,
  type CraftStation,
  type GraphLink,
  type GraphRef,
  type ModContext,
  type ResearchNode,
} from '@kenshi-editor/core';
import { useDataLocale, useT, type Strings } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { FlowGraph, type FlowCard, type FlowLink } from '../../components/FlowGraph.tsx';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Узлов в графе за раз (дальше — уточнить фильтр). */
const MAX_NODES = 400;
/** Пунктов в списке выбора станка, города, отряда. */
const MAX_OPTIONS = 400;
/** Глубина ингредиентов (из чего сделан ингредиент…). */
const INGREDIENT_DEPTH = 3;

type Mode = 'research' | 'craft' | 'squads';
type FocusKind = 'TOWN' | 'SQUAD_TEMPLATE';

interface Flow {
  cards: FlowCard[];
  links: FlowLink[];
  capped: boolean;
}

type Namer = (r: GraphRef) => string;

function textMatch(q: string, ...parts: (string | undefined)[]): boolean {
  return parts.some((p) => p !== undefined && p.toLowerCase().includes(q));
}

function card(name: Namer, r: GraphRef, kind: string, lines: string[] = [], sub?: string): FlowCard {
  const c: FlowCard = { id: r.sid, sid: r.sid, kind, title: name(r), lines, status: r.status, missing: r.missing };
  if (sub !== undefined) c.sub = sub;
  return c;
}

/** Собирает граф без повторов узлов и рёбер, с пределом на число узлов. */
class FlowBuilder {
  readonly cards: FlowCard[] = [];
  readonly links: FlowLink[] = [];
  private readonly seen = new Set<string>();
  private readonly edgeIds = new Set<string>();
  capped = false;

  has(id: string): boolean {
    return this.seen.has(id);
  }

  add(c: FlowCard): boolean {
    if (this.seen.has(c.id)) return true;
    if (this.cards.length >= MAX_NODES) {
      this.capped = true;
      return false;
    }
    this.seen.add(c.id);
    this.cards.push(c);
    return true;
  }

  link(source: string, target: string, label?: string, link?: GraphLink, dashed = false): void {
    if (!this.seen.has(source) || !this.seen.has(target)) return;
    let id = `${source}>${target}${link ? `#${link.category}` : ''}`;
    while (this.edgeIds.has(id)) id += "'";
    this.edgeIds.add(id);
    const l: FlowLink = { id, source, target };
    if (label !== undefined) l.label = label;
    if (link) l.link = link;
    if (dashed) l.dashed = true;
    this.links.push(l);
  }

  done(): Flow {
    return { cards: this.cards, links: this.links, capped: this.capped };
  }
}

function researchFlow(nodes: readonly ResearchNode[], t: Strings, name: Namer, query: string): Flow {
  const b = new FlowBuilder();
  const q = query.trim().toLowerCase();
  for (const n of nodes) {
    const lines: string[] = [];
    if (n.cost.length) lines.push(`${t.grCost}: ${n.cost.map((c) => `${name(c)} ×${c.amount}`).join(', ')}`);
    if (n.unlocks.length) lines.push(`${t.grUnlocks}: ${n.unlocks.slice(0, 3).map(name).join(', ')}${n.unlocks.length > 3 ? ` +${n.unlocks.length - 3}` : ''}`);
    if (n.blueprint || n.blueprintOnly) lines.push(`${t.grBlueprint}${n.soldBy.length ? ` · ${t.grSoldBy.toLowerCase()}: ${n.soldBy.length}` : ''}`);
    const sub = [n.category, t.grLevel(n.level), t.grHours(n.time), n.money ? t.grMoney(n.money) : ''].filter(Boolean).join(' · ');
    const c = card(name, n, 'research', lines, sub);
    if (q !== '') c.matched = textMatch(q, n.name, n.localized, n.sid, ...n.unlocks.flatMap((u) => [u.name, u.localized]));
    if (!b.add(c)) break;
  }
  for (const n of nodes) for (const l of n.requires) b.link(l.target, n.sid, undefined, l);
  return b.done();
}

function craftFlow(ctx: ModContext, s: CraftStation, t: Strings, name: Namer): Flow {
  const b = new FlowBuilder();
  const lines = [s.functionality.name, t.grTech(s.techLevel)];
  if (s.consumes.length) lines.push(`${t.grConsumes}: ${s.consumes.map((c) => name(c)).join(', ')}`);
  b.add({ ...card(name, s, 'station', lines), root: true });
  const inputs = (from: string, list: ReturnType<typeof ingredientsOf>, depth: number): void => {
    for (const i of list) {
      const fresh = !b.has(i.sid);
      if (!b.add(card(name, i, 'input'))) return;
      b.link(from, i.sid, `×${i.amount}`, i.link);
      if (fresh && depth < INGREDIENT_DEPTH) inputs(i.sid, ingredientsOf(ctx, i.sid), depth + 1);
    }
  };
  for (const p of s.products) {
    const fresh = !b.has(p.sid);
    if (!b.add(card(name, p, 'item', p.hours !== undefined ? [t.grHours(p.hours)] : []))) break;
    b.link(s.sid, p.sid, undefined, p.link);
    if (fresh) inputs(p.sid, p.inputs, 1);
  }
  return b.done();
}

function squadLabel(t: Strings, field: string, min: number, max: number, chance?: number): string {
  if (field === 'choosefrom list') return `${t.grChance} ${chance ?? 0}`;
  const n = min === max ? `×${min}` : `${min}–${max}`;
  if (field === 'leader') return `${t.grLeader} ${n}`;
  if (field === 'slaves' || field === 'prisoners' || field === 'housemates') return `${field} ${n}`;
  return n;
}

function addSquad(ctx: ModContext, b: FlowBuilder, t: Strings, name: Namer, sid: string, depth: number, root = false): void {
  const q = squadComposition(ctx, sid);
  if (!q) return;
  const lines: string[] = [];
  if (q.trader) lines.push(`¤ ${t.grTrader}`);
  if (q.faction) lines.push(name(q.faction));
  if (q.randomChars[1] > 0) lines.push(t.grRandom(q.randomChars[0], q.randomChars[1]));
  const c = card(name, q, 'squad', lines);
  if (root) c.root = true;
  if (!b.add(c)) return;
  for (const m of q.members) {
    if (!b.add(card(name, m, m.field.startsWith('animals') ? 'animal' : 'char'))) return;
    b.link(sid, m.sid, squadLabel(t, m.field, m.min, m.max, m.chance), m.link);
  }
  for (const v of q.vendors) {
    if (!b.add(card(name, v, 'vendor'))) return;
    b.link(sid, v.sid, `${v.percent}%`, v.link, true);
  }
  for (const s of q.squads) {
    const fresh = !b.has(s.sid);
    if (depth > 0 && fresh) addSquad(ctx, b, t, name, s.sid, depth - 1);
    else if (!b.add(card(name, s, 'squad'))) return;
    b.link(sid, s.sid, squadLabel(t, s.field, s.min, s.max), s.link, true);
  }
}

function compositionFlow(ctx: ModContext, kind: FocusKind, sid: string, t: Strings, name: Namer): Flow {
  const b = new FlowBuilder();
  if (kind === 'SQUAD_TEMPLATE') {
    addSquad(ctx, b, t, name, sid, 1, true);
    return b.done();
  }
  const town = townComposition(ctx, sid);
  if (!town) return b.done();
  b.add({ ...card(name, town, 'town', town.faction ? [name(town.faction)] : []), root: true });
  for (const s of town.squads) {
    if (!b.has(s.sid)) addSquad(ctx, b, t, name, s.sid, 0);
    const label =
      s.field === 'bar squads'
        ? `${t.grBar}: ×${s.count} · ${s.chance ?? 0}%`
        : s.field === 'roaming squads'
          ? t.grRoaming
          : s.field === 'default resident'
            ? t.grFiller
            : `×${s.count} · ${t.grPriority} ${s.priority ?? 0}${s.field === 'faction residents' ? ` (${t.grFromFaction})` : ''}`;
    b.link(sid, s.sid, label, s.link, s.field === 'faction residents');
  }
  return b.done();
}

/** Значения одной ссылки: поля ввода и «Применить». */
function LinkEditor({ l, title, onApply }: { l: GraphLink; title: string; onApply: (values: number[]) => void }): ReactNode {
  const t = useT();
  const n = Math.max(1, Math.min(3, l.arity));
  const [vals, setVals] = useState(() => l.values.slice(0, n).map(String));
  const names = t.grValues(l.category) ?? [];
  const parsed = vals.map((v) => Number(v.trim()));
  const ok = parsed.every((v) => Number.isInteger(v)) && vals.every((v) => v.trim() !== '');
  return (
    <div className="gr-link" data-testid="graph-link" data-category={l.category} data-from={l.from}>
      <span className="muted">{title}</span>
      {vals.map((v, i) => (
        <label key={i}>
          {names[i] ?? t.grValue(i)}{' '}
          <input
            className="gr-value"
            value={v}
            onChange={(e) => {
              const next = [...vals];
              next[i] = e.target.value;
              setVals(next);
            }}
            data-testid={`graph-link-v${i}`}
          />
        </label>
      ))}
      <button disabled={!ok} onClick={() => { onApply(parsed); }} data-testid="graph-link-apply">
        {t.grApply}
      </button>
    </div>
  );
}

function RefChips({ label, list, name, onGo }: { label: string; list: readonly GraphRef[]; name: Namer; onGo: (sid: string) => void }): ReactNode {
  if (list.length === 0) return null;
  return (
    <div className="gr-chips">
      <span className="muted">{label}:</span>
      {list.slice(0, 40).map((r, i) => (
        <button key={`${r.sid}#${i}`} className="link" title={r.sid} onClick={() => { onGo(r.sid); }}>
          {name(r)}
        </button>
      ))}
      {list.length > 40 && <span className="muted">+{list.length - 40}</span>}
    </div>
  );
}

function GraphsPanel(): ReactNode {
  const t = useT();
  const dataLocale = useDataLocale();
  const { project, go, open, report } = useWorkbench();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const index = project.idsByType();
  const name: Namer = (r) => (r.missing ? `${r.sid} (${t.grMissing})` : r.localized ?? r.name);

  const [mode, setMode] = useState<Mode>('research');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search);
  const [station, setStation] = useState<string | undefined>();
  const [focusKind, setFocusKind] = useState<FocusKind>('TOWN');
  const [focus, setFocus] = useState<string | undefined>();
  const [picked, setPicked] = useState<string | undefined>();

  const research = useMemo(() => (mode === 'research' ? researchGraph(ctx, { index }) : undefined), [mode, ctx, index, version]);
  const stations = useMemo(() => (mode === 'craft' ? craftingStations(ctx, { index }) : []), [mode, ctx, index, version]);
  const sortedStations = useMemo(() => [...stations].sort((a, b) => name(a).localeCompare(name(b))), [stations, dataLocale]);
  const focusIds = useMemo(() => {
    if (mode !== 'squads') return [];
    const list = (index.get(focusKind) ?? []).map((sid) => ({ sid, label: ctx.localizedName(sid) ?? ctx.name(sid) ?? sid }));
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, [mode, focusKind, index, ctx, dataLocale]);

  const q = query.trim().toLowerCase();
  const stationId = station !== undefined && stations.some((s) => s.sid === station) ? station : sortedStations[0]?.sid;
  const focusId = focus !== undefined && focusIds.some((f) => f.sid === focus) ? focus : focusIds[0]?.sid;
  const madeAt = useMemo(() => {
    const m = new Map<string, GraphRef[]>();
    for (const s of stations) for (const p of s.products) (m.get(p.sid) ?? m.set(p.sid, []).get(p.sid)!).push(s);
    return m;
  }, [stations]);

  const flow = useMemo((): Flow => {
    if (mode === 'research') {
      const nodes = (research?.nodes ?? []).filter((n) => category === '' || n.category === category);
      return researchFlow(nodes, t, name, q);
    }
    if (mode === 'craft') {
      const s = stations.find((x) => x.sid === stationId);
      return s ? craftFlow(ctx, s, t, name) : { cards: [], links: [], capped: false };
    }
    return focusId !== undefined ? compositionFlow(ctx, focusKind, focusId, t, name) : { cards: [], links: [], capped: false };
  }, [mode, research, category, q, stations, stationId, focusKind, focusId, ctx, t, dataLocale, version]);

  const pickedCard = flow.cards.find((c) => c.id === picked);
  const researchNode = pickedCard && research?.nodes.find((n) => n.sid === pickedCard.sid);
  const incoming = pickedCard ? flow.links.filter((l) => l.target === pickedCard.id && l.link && l.link.arity > 0) : [];
  const byId = new Map(flow.cards.map((c) => [c.id, c]));
  const found = q !== '' ? flow.cards.filter((c) => c.matched).length : undefined;

  // Списки выбора: по поиску (в режимах крафта и состава поиск фильтрует список).
  const stationOptions = sortedStations.filter((s) => q === '' || mode !== 'craft' || textMatch(q, s.name, s.localized, s.sid, ...s.products.flatMap((p) => [p.name, p.localized]))).slice(0, MAX_OPTIONS);
  const focusOptions = focusIds.filter((f) => q === '' || textMatch(q, f.label, f.sid, ctx.name(f.sid))).slice(0, MAX_OPTIONS);

  const refocus = (c: FlowCard): void => {
    const type = project.entry(c.sid)?.type;
    if (type === 'TOWN' || type === 'SQUAD_TEMPLATE') {
      setMode('squads');
      setFocusKind(type);
      setFocus(c.sid);
      setSearch('');
    } else if (stations.some((s) => s.sid === c.sid)) {
      setMode('craft');
      setStation(c.sid);
      setSearch('');
    }
    setPicked(undefined);
  };
  const canRefocus = (c: FlowCard): boolean => !c.root && (c.kind === 'squad' || c.kind === 'town' || stations.some((s) => s.sid === c.sid));

  const layoutKey = `${mode}|${category}|${stationId ?? ''}|${focusKind}|${focusId ?? ''}`;

  return (
    <div className="mods-panel graphs-panel" data-testid="graphs-panel">
      <div className="mods-panel-bar">
        <select
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as Mode);
            setPicked(undefined);
            setSearch('');
          }}
          data-testid="graphs-mode"
        >
          <option value="research">{t.grResearch}</option>
          <option value="craft">{t.grCraft}</option>
          <option value="squads">{t.grSquads}</option>
        </select>
        {mode === 'research' && (
          <select value={category} onChange={(e) => { setCategory(e.target.value); }} data-testid="graphs-category">
            <option value="">{t.grAllCategories}</option>
            {(research?.categories ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        {mode === 'squads' && (
          <select
            value={focusKind}
            onChange={(e) => {
              setFocusKind(e.target.value as FocusKind);
              setFocus(undefined);
              setPicked(undefined);
            }}
            data-testid="graphs-kind"
          >
            <option value="TOWN">{t.grTown}</option>
            <option value="SQUAD_TEMPLATE">{t.grSquad}</option>
          </select>
        )}
        <input type="search" placeholder={t.grSearch} value={search} onChange={(e) => { setSearch(e.target.value); }} data-testid="graphs-search" />
        {mode === 'craft' && (
          <select value={stationId ?? ''} onChange={(e) => { setStation(e.target.value); setPicked(undefined); }} data-testid="graphs-focus" title={t.grStation}>
            {stationId !== undefined && !stationOptions.some((s) => s.sid === stationId) && <option value={stationId}>{name(stations.find((s) => s.sid === stationId)!)}</option>}
            {stationOptions.map((s) => (
              <option key={s.sid} value={s.sid}>
                {name(s)} ({s.products.length})
              </option>
            ))}
          </select>
        )}
        {mode === 'squads' && (
          <select value={focusId ?? ''} onChange={(e) => { setFocus(e.target.value); setPicked(undefined); }} data-testid="graphs-focus">
            {focusId !== undefined && !focusOptions.some((f) => f.sid === focusId) && <option value={focusId}>{focusIds.find((f) => f.sid === focusId)?.label}</option>}
            {focusOptions.map((f) => (
              <option key={f.sid} value={f.sid}>
                {f.label}
              </option>
            ))}
          </select>
        )}
        {found !== undefined && mode === 'research' && (
          <span className="muted" data-testid="graphs-found">
            {t.grFound(found)}
          </span>
        )}
      </div>
      {flow.capped && <div className="muted mods-panel-note">{t.grCap(MAX_NODES)}</div>}
      <div className="gr-details" data-testid="graphs-details">
        {!pickedCard ? (
          <span className="muted">{t.grPick}</span>
        ) : (
          <>
            <div className="gr-details-head">
              <b data-testid="graphs-picked">{pickedCard.title}</b>
              <span className="muted">
                {project.entry(pickedCard.sid)?.type ?? '?'} · {pickedCard.sid}
              </span>
              <button onClick={() => { go(pickedCard.sid); }} disabled={pickedCard.missing} data-testid="graphs-open">
                {t.grOpen}
              </button>
              <button onClick={() => { open('where', { sid: pickedCard.sid }); }} disabled={pickedCard.missing} data-testid="graphs-where">
                ⌖ {t.grWhere}
              </button>
              {canRefocus(pickedCard) && (
                <button onClick={() => { refocus(pickedCard); }} data-testid="graphs-refocus">
                  {t.grFocus}
                </button>
              )}
            </div>
            {researchNode && (
              <>
                <div className="muted">
                  {[researchNode.category, t.grLevel(researchNode.level), t.grHours(researchNode.time), researchNode.money ? t.grMoney(researchNode.money) : '', researchNode.repeats ? t.grRepeats(researchNode.repeats) : '', researchNode.levelUpgrade ? t.grLevelUp : '', researchNode.blueprintOnly ? t.grBlueprintOnly : '']
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <RefChips label={t.grRequires} list={researchNode.requires.map((l) => byId.get(l.target) ? { sid: l.target, type: 'RESEARCH', name: byId.get(l.target)!.title } : { sid: l.target, type: 'RESEARCH', name: l.target })} name={(r) => r.name} onGo={go} />
                <RefChips label={t.grCost} list={researchNode.cost.map((c) => ({ ...c, name: `${name(c)} ×${c.amount}`, localized: `${name(c)} ×${c.amount}` }))} name={(r) => r.name} onGo={go} />
                <RefChips label={t.grUnlocks} list={researchNode.unlocks} name={name} onGo={go} />
                <RefChips label={t.grBlueprint} list={researchNode.blueprint ? [researchNode.blueprint] : []} name={name} onGo={go} />
                <RefChips label={t.grSoldBy} list={researchNode.soldBy} name={name} onGo={go} />
              </>
            )}
            {mode === 'craft' && <RefChips label={t.grMadeAt} list={madeAt.get(pickedCard.sid) ?? []} name={name} onGo={(sid) => { setStation(sid); setPicked(undefined); }} />}
            {incoming.length > 0 && (
              <div className="gr-links">
                <span className="muted">{t.grLinks}:</span>
                {incoming.map((l) => (
                  <LinkEditor
                    key={`${l.id}|${l.link!.values.join(',')}`}
                    l={l.link!}
                    title={`${byId.get(l.source)?.title ?? l.source} → ${pickedCard.title} · ${l.link!.category}${l.link!.from !== l.source ? ` (${ctx.name(l.link!.from) ?? l.link!.from})` : ''}`}
                    onApply={(values) => {
                      report(
                        tryEdit(() => {
                          setLinkValues(ctx, l.link!, values);
                        }),
                      );
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {flow.cards.length === 0 ? (
        <Empty text={t.grEmpty} />
      ) : (
        <FlowGraph cards={flow.cards} links={flow.links} picked={picked} onPick={setPicked} onOpen={go} layoutKey={layoutKey} />
      )}
    </div>
  );
}

registerPanel({
  id: 'graphs', group: 'data',
  title: (t) => t.panel_graphs,
  icon: '⛬',
  component: GraphsPanel,
  area: 'center',
  order: 53,
  hint: (t) => t.graphsHint,
});
