/**
 * Перепись NPC (этап 5): все персонажи (CHARACTER) с фракцией, городами, где живут их отряды,
 * уникальностью, клик-диалогами и пакетами диалогов; группы по фракции и по городу с весом
 * «сколько городов» (кого встретишь чаще). Плюс правка: дать пакет диалогов выбранным
 * персонажам одной отменой. Работает на ванили и на любом наборе модов; только чтение, кроме
 * `addDialoguePackage`.
 */
import { itemTypeName } from '../format/item-types.ts';
import { characterFactions, EVENT_TALK, squadIndex, talkSources } from '../dialog/talk.ts';
import { EditError, type ModContext, type RecordStatus } from './context.ts';
import { townComposition, type TypeIndex } from './graphs.ts';

export interface CensusChar {
  sid: string;
  name: string;
  ru?: string;
  /** Состояние записи в моде: new / changed — персонаж уже в моде. */
  status?: RecordStatus;
  unique: boolean;
  dumb: boolean;
  trader: boolean;
  /** Фракции: своя или фракции отрядов, а если нет — фракции городов, где живут отряды. */
  factions: string[];
  /** Города, где живут его отряды (жители города и жители фракции города, бар, бродячие). */
  towns: string[];
  /** Отряды, в которые он входит. */
  squads: string[];
  /** Свои пакеты диалогов (`dialogue package`). */
  packages: string[];
  /** Свои диалоги (`dialogue`). */
  dialogues: string[];
  /** Сколько разных клик-диалогов (событие «игрок заговорил») из всех источников. */
  talks: number;
}

export interface CensusGroup {
  /** sid фракции или города; '' — «без фракции» / «не в городах». */
  key: string;
  name: string;
  ru?: string;
  chars: string[];
  /** Сумма по персонажам: число городов (не меньше 1). Чем больше — тем чаще встречаются. */
  weight: number;
}

export interface Census {
  chars: CensusChar[];
  byFaction: CensusGroup[];
  byTown: CensusGroup[];
}

export interface CensusOptions {
  index?: TypeIndex;
}

function idsOf(ctx: ModContext, type: string, index: TypeIndex | undefined): readonly string[] {
  if (index) return index.get(type) ?? [];
  const out: string[] = [];
  for (const r of ctx.records()) if (itemTypeName(r.type) === type) out.push(r.stringId);
  return out;
}

/** Нет своих пакетов и своих диалогов. */
export const censusNoPackage = (c: CensusChar): boolean => c.packages.length === 0 && c.dialogues.length === 0;
/** Вес персонажа: число городов, не меньше 1. */
export const censusWeight = (c: CensusChar): number => Math.max(1, c.towns.length);

export function npcCensus(ctx: ModContext, options: CensusOptions = {}): Census {
  const sq = squadIndex(ctx);
  // Отряд → города, где он живёт; город → его фракция.
  const squadTowns = new Map<string, Set<string>>();
  const townFaction = new Map<string, string>();
  for (const t of idsOf(ctx, 'TOWN', options.index)) {
    const comp = townComposition(ctx, t);
    if (!comp) continue;
    if (comp.faction && !comp.faction.missing) townFaction.set(t, comp.faction.sid);
    for (const s of comp.squads) (squadTowns.get(s.sid) ?? squadTowns.set(s.sid, new Set()).get(s.sid)!).add(t);
  }

  const chars: CensusChar[] = [];
  for (const sid of idsOf(ctx, 'CHARACTER', options.index)) {
    const rec = ctx.get(sid);
    if (!rec) continue;
    const squads = [...new Set((sq.get(sid) ?? []).map((s) => s.squad))];
    const towns = new Set<string>();
    for (const s of squads) for (const t of squadTowns.get(s) ?? []) towns.add(t);
    let factions = characterFactions(ctx, rec, sq).filter((f) => ctx.get(f) !== undefined);
    if (factions.length === 0) factions = [...new Set([...towns].flatMap((t) => townFaction.get(t) ?? []))];
    const c: CensusChar = {
      sid,
      name: ctx.name(sid) ?? sid,
      unique: rec.bools.get('unique') ?? false,
      dumb: rec.bools.get('dumb') ?? false,
      trader: rec.bools.get('is trader') ?? false,
      factions,
      towns: [...towns],
      squads,
      packages: (rec.refs.get('dialogue package') ?? []).map((r) => r.target),
      dialogues: (rec.refs.get('dialogue') ?? []).map((r) => r.target),
      talks: new Set(talkSources(ctx, rec, EVENT_TALK, sq).map((t) => t.dialog)).size,
    };
    const ru = ctx.localizedName(sid);
    if (ru !== undefined) c.ru = ru;
    const st = ctx.status(sid);
    if (st !== undefined && st !== 'base') c.status = st;
    chars.push(c);
  }

  const group = (keys: (c: CensusChar) => readonly string[]): CensusGroup[] => {
    const map = new Map<string, CensusChar[]>();
    for (const c of chars) {
      const ks = keys(c);
      for (const k of ks.length ? ks : ['']) (map.get(k) ?? map.set(k, []).get(k)!).push(c);
    }
    const out: CensusGroup[] = [];
    for (const [key, list] of map) {
      const g: CensusGroup = { key, name: key === '' ? '' : (ctx.name(key) ?? key), chars: list.map((c) => c.sid), weight: list.reduce((s, c) => s + censusWeight(c), 0) };
      const ru = key === '' ? undefined : ctx.localizedName(key);
      if (ru !== undefined) g.ru = ru;
      out.push(g);
    }
    return out.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  };
  return { chars, byFaction: group((c) => c.factions), byTown: group((c) => c.towns) };
}

/**
 * Дать пакет диалогов персонажам одной правкой (одна отмена). Кому пакет уже дан — пропуск.
 * Возвращает, скольким добавлен.
 */
export function addDialoguePackage(ctx: ModContext, chars: readonly string[], pkg: string): number {
  const p = ctx.get(pkg);
  if (!p || itemTypeName(p.type) !== 'DIALOGUE_PACKAGE') throw new EditError(`${pkg} — не пакет диалогов`);
  const todo = [...new Set(chars)].filter((sid) => {
    const c = ctx.get(sid);
    if (!c || itemTypeName(c.type) !== 'CHARACTER') throw new EditError(`${sid} — не персонаж`);
    return !(c.refs.get('dialogue package') ?? []).some((r) => r.target === pkg);
  });
  if (todo.length === 0) return 0;
  const pname = ctx.localizedName(pkg) ?? ctx.name(pkg) ?? pkg;
  const who = todo.length === 1 ? `«${ctx.localizedName(todo[0]!) ?? ctx.name(todo[0]!) ?? todo[0]!}»` : `${todo.length} персонажам`;
  ctx.transaction(`Пакет диалогов «${pname}» → ${who}`, () => {
    for (const sid of todo) ctx.addReference(sid, 'dialogue package', pkg);
  });
  return todo.length;
}
