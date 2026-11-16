/**
 * NPC census (stage 5): all characters (CHARACTER) with faction, towns where their squads live,
 * uniqueness, click dialogues and dialogue packages; groups by faction and by town weighted by
 * "how many towns" (whom you meet more often). Plus an edit: give a dialogue package to the selected
 * characters with one undo. Works on vanilla and on any set of mods; read-only except
 * `addDialoguePackage`.
 */
import { itemTypeName } from '../format/item-types.ts';
import { characterFactions, EVENT_TALK, squadIndex, talkSources } from '../dialog/talk.ts';
import { EditError, type ModContext, type RecordStatus } from './context.ts';
import { townComposition, type TypeIndex } from './graphs.ts';

export interface CensusChar {
  sid: string;
  name: string;
  localized?: string;
  /** Record state in the mod: new / changed means the character is already in the mod. */
  status?: RecordStatus;
  unique: boolean;
  dumb: boolean;
  trader: boolean;
  /** Factions: own or the squads' factions, and if none, the factions of the towns where the squads live. */
  factions: string[];
  /** Towns where its squads live (town residents and town faction residents, bar, wandering). */
  towns: string[];
  /** Squads it belongs to. */
  squads: string[];
  /** Own dialogue packages (`dialogue package`). */
  packages: string[];
  /** Own dialogues (`dialogue`). */
  dialogues: string[];
  /** How many distinct click dialogues (event "the player talked") from all sources. */
  talks: number;
}

export interface CensusGroup {
  /** sid of the faction or town; '' = "no faction" / "not in towns". */
  key: string;
  name: string;
  localized?: string;
  chars: string[];
  /** Sum over characters: number of towns (at least 1). The more, the more often they are met. */
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
  for (const r of ctx.records()) if (ctx.typeName(r.type) === type) out.push(r.stringId);
  return out;
}

/** No own packages and no own dialogues. */
export const censusNoPackage = (c: CensusChar): boolean => c.packages.length === 0 && c.dialogues.length === 0;
/** Character weight: number of towns, at least 1. */
export const censusWeight = (c: CensusChar): number => Math.max(1, c.towns.length);

export function npcCensus(ctx: ModContext, options: CensusOptions = {}): Census {
  const sq = squadIndex(ctx);
  // Squad → towns where it lives; town → its faction.
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
    const loc = ctx.localizedName(sid);
    if (loc !== undefined) c.localized = loc;
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
      const loc = key === '' ? undefined : ctx.localizedName(key);
      if (loc !== undefined) g.localized = loc;
      out.push(g);
    }
    return out.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  };
  return { chars, byFaction: group((c) => c.factions), byTown: group((c) => c.towns) };
}

/**
 * Give a dialogue package to characters with one edit (one undo). Those who already have it are skipped.
 * Returns how many got it.
 */
export function addDialoguePackage(ctx: ModContext, chars: readonly string[], pkg: string): number {
  const p = ctx.get(pkg);
  if (!p || itemTypeName(p.type) !== 'DIALOGUE_PACKAGE') throw new EditError({ en: `${pkg} is not a dialogue package`, ru: `${pkg} — не пакет диалогов`, zh: `${pkg} 不是对话包` });
  const todo = [...new Set(chars)].filter((sid) => {
    const c = ctx.get(sid);
    if (!c || itemTypeName(c.type) !== 'CHARACTER') throw new EditError({ en: `${sid} is not a character`, ru: `${sid} — не персонаж`, zh: `${sid} 不是角色` });
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
