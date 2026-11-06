/**
 * Отношения фракций (этап 5, «матрица отношений»). Где лежат в данных (сверено на ванили):
 * - `FACTION.relations` → FACTION, значение v0 — отношение от −100 до +100 (строка — кто
 *   относится, столбец — к кому). Отношение направленное: у второй фракции своя запись;
 * - не указано — `default relation` строки (int, по умолчанию 0);
 * - `enemy classification` строки (int, по умолчанию −10) — «не выше этого — враг, нападать
 *   сразу»;
 * - `coexistence` → FACTION — «стараемся уживаться» (могут драться, но реже нападают).
 *
 * Порог «союзник» в данных не задан: берём ≥ 50 (условно, только для цвета).
 */
import { decodeText } from '../text.ts';
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import { isVanillaLayer } from '../vanilla.ts';
import { plainRuName } from '../world/where.ts';
import { EditError, type ModContext } from './context.ts';
import { contextLayers } from './conflicts.ts';
import { isRemovalMarker, isRemovedRef } from './record-ops.ts';

export const FACTION_TYPE = 'FACTION';
export const RELATIONS = 'relations';
export const COEXISTENCE = 'coexistence';
/** Условный порог «союзник» (в данных игры его нет). */
export const ALLY_THRESHOLD = 50;
const DEFAULT_ENEMY = -10;

export type RelationKind = 'enemy' | 'neutral' | 'ally';

export interface FactionInfo {
  sid: string;
  name: string;
  /** Русское имя из gamedata.po (без служебных меток) или undefined. */
  ru?: string;
  defaultRelation: number;
  enemyClassification: number;
  /** Число явно заданных отношений (без маркеров «убрать»). */
  listed: number;
}

/** Что один мод (слой) делает с отношением: ставит значение или убирает строку. */
export interface RelationTouch {
  layer: string;
  /** undefined — мод убирает отношение из списка (значит, снова «по умолчанию»). */
  value?: number;
}

export interface RelationCell {
  value: number;
  /** Задано в списке `relations` (а не взято из `default relation`). */
  explicit: boolean;
  kind: RelationKind;
  coexist: boolean;
  /** Небазовые слои, которые трогают это отношение, по порядку загрузки (сам мод — последний). */
  touches: RelationTouch[];
}

export interface FactionMatrix {
  factions: FactionInfo[];
  cell(from: string, to: string): RelationCell;
  /** Отношение B → A, если оно отличается от A → B (иначе undefined). */
  asymmetry(from: string, to: string): number | undefined;
  /** Слои, которые трогают отношения фракции (для фильтра «что поменял мод»). */
  layersOf(sid: string): string[];
  /** Все небазовые слои, которые что-то меняют в отношениях. */
  layers: string[];
}

function relationValue(r: Reference): number {
  return r.v0;
}

export function relationKind(value: number, enemyClassification = DEFAULT_ENEMY): RelationKind {
  if (value <= enemyClassification) return 'enemy';
  if (value >= ALLY_THRESHOLD) return 'ally';
  return 'neutral';
}

function info(ctx: ModContext, rec: GameRecord): FactionInfo {
  const ru = ctx.localizedName(rec.stringId);
  const plain = ru === undefined ? undefined : plainRuName(ru);
  return {
    sid: rec.stringId,
    name: decodeText(rec.name) || rec.stringId,
    ...(plain !== undefined && plain !== '' ? { ru: plain } : {}),
    defaultRelation: rec.ints.get('default relation') ?? 0,
    enemyClassification: rec.ints.get('enemy classification') ?? DEFAULT_ENEMY,
    listed: (rec.refs.get(RELATIONS) ?? []).filter((r) => !isRemovedRef(r)).length,
  };
}

/**
 * Матрица отношений всех фракций контекста (ваниль, зависимости, моды контекста, сам мод).
 * Считается по итоговым записям; «кто поменял» — по слоям, без чтения диска.
 * `ids` — готовый список id фракций (индекс редактора), чтобы не перебирать все записи.
 */
export function factionMatrix(ctx: ModContext, options: { ids?: Iterable<string> } = {}): FactionMatrix {
  const type = itemTypeId(FACTION_TYPE)!;
  const factions: FactionInfo[] = [];
  const values = new Map<string, Map<string, number>>();
  const coexist = new Map<string, Set<string>>();
  for (const sid of options.ids ?? ctx.allStringIds()) {
    const rec = ctx.get(sid);
    if (!rec || rec.type !== type) continue;
    factions.push(info(ctx, rec));
    const m = new Map<string, number>();
    for (const r of rec.refs.get(RELATIONS) ?? []) if (!isRemovedRef(r) && !m.has(r.target)) m.set(r.target, relationValue(r));
    values.set(sid, m);
    coexist.set(sid, new Set((rec.refs.get(COEXISTENCE) ?? []).filter((r) => !isRemovedRef(r)).map((r) => r.target)));
  }
  const byId = new Map(factions.map((f) => [f.sid, f]));

  // Кто трогает: небазовые слои с записями FACTION.
  const touches = new Map<string, RelationTouch[]>();
  const rowLayers = new Map<string, Set<string>>();
  const allLayers: string[] = [];
  // Бегущее значение отношения по слоям: мод, который ставит то же, что уже было до него
  // (например, вернули исходное значение), ничего не меняет — его не показываем как «тронул».
  const running = new Map<string, number | undefined>();
  const defaultOf = (sid: string): number => byId.get(sid)?.defaultRelation ?? 0;
  for (const layer of contextLayers(ctx)) {
    const vanilla = isVanillaLayer(layer.name);
    let any = false;
    for (const rec of layer.file.records) {
      if (rec.type !== type || isRemovalMarker(rec)) continue;
      for (const r of rec.refs.get(RELATIONS) ?? []) {
        const key = `${rec.stringId}\n${r.target}`;
        const next = isRemovedRef(r) ? undefined : relationValue(r);
        const before = running.get(key);
        running.set(key, next);
        if (vanilla) continue;
        if ((next ?? defaultOf(rec.stringId)) === (before ?? defaultOf(rec.stringId))) continue;
        let list = touches.get(key);
        if (!list) touches.set(key, (list = []));
        list.push(isRemovedRef(r) ? { layer: layer.name } : { layer: layer.name, value: relationValue(r) });
        let set = rowLayers.get(rec.stringId);
        if (!set) rowLayers.set(rec.stringId, (set = new Set()));
        set.add(layer.name);
        any = true;
      }
    }
    if (any) allLayers.push(layer.name);
  }

  const cell = (from: string, to: string): RelationCell => {
    const f = byId.get(from);
    const listed = values.get(from)?.get(to);
    const value = listed ?? f?.defaultRelation ?? 0;
    return {
      value,
      explicit: listed !== undefined,
      kind: relationKind(value, f?.enemyClassification),
      coexist: coexist.get(from)?.has(to) ?? false,
      touches: touches.get(`${from}\n${to}`) ?? [],
    };
  };
  return {
    factions,
    cell,
    asymmetry(from, to) {
      if (from === to) return undefined;
      const a = cell(from, to).value;
      const b = cell(to, from).value;
      return a === b ? undefined : b;
    },
    layersOf: (sid) => [...(rowLayers.get(sid) ?? [])],
    layers: allLayers,
  };
}

function factionName(ctx: ModContext, sid: string): string {
  return ctx.name(sid) ?? sid;
}

function requireFaction(ctx: ModContext, sid: string): void {
  const rec = ctx.get(sid);
  if (!rec) throw new EditError(`Записи ${sid} нет`);
  if (itemTypeName(rec.type) !== FACTION_TYPE) throw new EditError(`${sid} — не фракция (${itemTypeName(rec.type)})`);
}

export interface SetRelationOptions {
  /** Поставить то же значение и в обратную сторону (B → A). */
  both?: boolean;
}

/** Метка шага: `отношение «A» → «B»: 20` (или `… ⇄ …` для обеих сторон, `сброс` — по умолчанию). */
export function relationLabel(ctx: ModContext, from: string, to: string, value: number | undefined, both = false): string {
  return `отношение «${factionName(ctx, from)}» ${both ? '⇄' : '→'} «${factionName(ctx, to)}»: ${value === undefined ? 'сброс' : value}`;
}

function putRelation(ctx: ModContext, from: string, to: string, value: number | undefined): void {
  ctx.editRecord(from, (d) => {
    const list = d.refs.get(RELATIONS) ?? [];
    const i = list.findIndex((r) => r.target === to && !isRemovedRef(r));
    if (value === undefined) {
      if (i >= 0) d.refs.set(RELATIONS, list.filter((r) => r.target !== to || isRemovedRef(r)));
      return;
    }
    if (i >= 0) list[i] = { ...list[i]!, v0: value };
    else list.push({ target: to, v0: value, v1: 0, v2: 0 });
    d.refs.set(RELATIONS, list);
  });
}

/**
 * Изменить отношение фракции `from` к `to` (−100…100) одной правкой. `undefined` — убрать
 * из списка (тогда действует `default relation`). `both` — и обратное отношение в той же правке.
 */
export function setFactionRelation(ctx: ModContext, from: string, to: string, value: number | undefined, options: SetRelationOptions = {}): void {
  requireFaction(ctx, from);
  requireFaction(ctx, to);
  if (value !== undefined && (!Number.isInteger(value) || value < -100 || value > 100)) throw new EditError(`Отношение — целое от −100 до 100, а не ${value}`);
  const both = (options.both ?? false) && from !== to;
  ctx.transaction(relationLabel(ctx, from, to, value, both), () => {
    putRelation(ctx, from, to, value);
    if (both) putRelation(ctx, to, from, value);
  });
}
