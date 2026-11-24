/**
 * A dialogue package as a list of events (the «Package» panel of the dialogue editor): who holds
 * the package, what it inherits, and for every event its own dialogues and the ones that come from
 * inherited packages (`inheritsFrom`, walked transitively, the way the game merges them).
 *
 * Events are the values of `EventTriggerEnum` (the numbers in `DIALOGUE_PACKAGE.dialogs` v0..v2),
 * grouped like the event picker (`schema/event-help.ts`). `EV_NONE` and `EV_MAX` are service values,
 * not events: they appear only if the package really uses them.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { ModContext } from '../model/context.ts';
import { enumValueMatches, packageRefEvents, refValueEnum } from '../model/enums.ts';
import { EVENT_GROUPS, eventHelp, type EventGroup } from '../schema/event-help.ts';
import type { EnumDef } from '../schema/fcs-enums.ts';
import { PACKAGE_HOLDER_FIELDS, packageHolders, type WhenHolder } from './when.ts';

/** Event group in the package list: the picker groups, then «the game does not raise it», then unknown values. */
export type PackageEventGroup = EventGroup | 'unused' | 'other';

/** Order of the groups in the list. */
export const PACKAGE_EVENT_GROUPS: readonly PackageEventGroup[] = [...EVENT_GROUPS.filter((g) => g !== 'service'), 'unused', 'service', 'other'];

export interface InheritedDialog {
  dialog: string;
  /** The inherited package whose `dialogs` holds the reference. */
  pkg: string;
}

export interface PackageEvent {
  event: number;
  /** Value name (`EV_ACID_RAIN`); absent for a number the enum does not know. */
  name?: string;
  group: PackageEventGroup;
  /** Dialogues referenced by the package itself, in reference order. */
  own: string[];
  /** Dialogues from inherited packages (not those already among `own`). */
  inherited: InheritedDialog[];
}

export interface PackageOverview {
  pkg: string;
  /** Packages it inherits directly (`inheritsFrom`). */
  inherits: string[];
  /** Every inherited package, transitively, in walk order. */
  ancestors: string[];
  /** Characters, squads and factions that hold it (also through packages that inherit it). */
  holders: WhenHolder[];
  /** Every event a dialogue can hang on plus every event the package or its ancestors use, in group order. */
  events: PackageEvent[];
  /** Distinct own dialogues. */
  ownDialogs: number;
  /** Events with own dialogues («busy»). */
  ownEvents: number;
  /** Events with own or inherited dialogues. */
  withInheritedEvents: number;
  /** Distinct inherited dialogues that are not own. */
  inheritedDialogs: number;
}

/** Service values of `EventTriggerEnum` (`EV_NONE`, `EV_MAX`): listed only when used. */
const SERVICE = 'service';

function groupOf(name: string | undefined): PackageEventGroup {
  const h = name === undefined ? undefined : eventHelp(name);
  return !h ? 'other' : h.unused ? 'unused' : h.group;
}

/** The package as an event list. A missing package gives an empty overview. */
export function packageOverview(ctx: ModContext, pkg: string): PackageOverview {
  const def = refValueEnum(ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0);
  const p = ctx.get(pkg);
  const own = new Map<number, string[]>();
  const inherited = new Map<number, InheritedDialog[]>();
  const ancestors: string[] = [];
  const ownSet = new Set<string>();
  const inhSet = new Set<string>();
  for (const r of p?.refs.get('dialogs') ?? []) {
    for (const ev of packageRefEvents(r)) {
      const list = own.get(ev) ?? [];
      if (!list.includes(r.target)) list.push(r.target);
      own.set(ev, list);
    }
    ownSet.add(r.target);
  }
  // Ancestors breadth-first; a package seen once is not walked again (cycles in mods happen).
  const seen = new Set<string>([pkg]);
  const queue = (p?.refs.get('inheritsFrom') ?? []).map((r) => r.target);
  while (queue.length > 0) {
    const a = queue.shift()!;
    if (seen.has(a)) continue;
    seen.add(a);
    const rec = ctx.get(a);
    if (!rec) continue;
    ancestors.push(a);
    for (const r of rec.refs.get('dialogs') ?? []) {
      for (const ev of packageRefEvents(r)) {
        if (own.get(ev)?.includes(r.target)) continue;
        const list = inherited.get(ev) ?? [];
        if (!list.some((d) => d.dialog === r.target)) list.push({ dialog: r.target, pkg: a });
        inherited.set(ev, list);
      }
      if (!ownSet.has(r.target)) inhSet.add(r.target);
    }
    for (const r of rec.refs.get('inheritsFrom') ?? []) queue.push(r.target);
  }

  const values = new Map<number, string | undefined>();
  for (const v of def?.values ?? []) if (v.value !== 0 && groupOf(v.name) !== SERVICE) values.set(v.value, v.name);
  for (const ev of [...own.keys(), ...inherited.keys()]) if (!values.has(ev)) values.set(ev, def?.values.find((v) => v.value === ev)?.name);
  const events: PackageEvent[] = [...values].map(([event, name]) => ({
    event,
    ...(name !== undefined ? { name } : {}),
    group: groupOf(name),
    own: own.get(event) ?? [],
    inherited: inherited.get(event) ?? [],
  }));
  const rank = (g: PackageEventGroup): number => PACKAGE_EVENT_GROUPS.indexOf(g);
  events.sort((a, b) => rank(a.group) - rank(b.group) || a.event - b.event);
  return {
    pkg,
    inherits: (p?.refs.get('inheritsFrom') ?? []).map((r) => r.target),
    ancestors,
    holders: p ? packageHolders(ctx, pkg) : [],
    events,
    ownDialogs: ownSet.size,
    ownEvents: own.size,
    withInheritedEvents: new Set([...own.keys(), ...inherited.keys()]).size,
    inheritedDialogs: inhSet.size,
  };
}

/** Which events the list shows: busy (own dialogues), all, or busy with inherited dialogues too. */
export type PackageEventMode = 'busy' | 'all' | 'inherited';

export interface PackageEventRow {
  event: PackageEvent;
  /** Dialogues shown under the event (all of them, or only those whose name matched the search). */
  own: string[];
  inherited: InheritedDialog[];
  /** The event itself matched the search (translation, EV_ code or number). */
  eventMatched: boolean;
}

/**
 * Events of the list for a mode and a search. The search matches the event (translation in the
 * interface language or in English, EV_ code, number — `enumValueMatches`) or a dialogue name
 * (`dialogName`) or its whole string id; every word must match. When only dialogues matched, only they are listed.
 */
export function filterPackageEvents(
  def: EnumDef | undefined,
  overview: PackageOverview,
  mode: PackageEventMode,
  query: string,
  lang: string,
  dialogName: (sid: string) => string,
): PackageEventRow[] {
  const q = query.trim();
  const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');
  const words = norm(q).split(/\s+/).filter(Boolean);
  // A string id matches only whole: a part of it («21» in «2161-gamedata.base») is noise.
  const nameMatches = (sid: string): boolean => {
    if (norm(q) === norm(sid)) return true;
    const hay = norm(dialogName(sid));
    return words.every((w) => hay.includes(w));
  };
  const out: PackageEventRow[] = [];
  for (const ev of overview.events) {
    const inh = mode === 'inherited' ? ev.inherited : [];
    if (mode === 'busy' && ev.own.length === 0) continue;
    if (mode === 'inherited' && ev.own.length === 0 && inh.length === 0) continue;
    if (!words.length) {
      out.push({ event: ev, own: ev.own, inherited: inh, eventMatched: false });
      continue;
    }
    const v = def?.values.find((x) => x.value === ev.event);
    const evHit = v ? enumValueMatches(def!, v, q, lang) : String(ev.event) === q;
    if (evHit) {
      out.push({ event: ev, own: ev.own, inherited: inh, eventMatched: true });
      continue;
    }
    const own = ev.own.filter(nameMatches);
    const inherited = inh.filter((d) => nameMatches(d.dialog));
    if (own.length || inherited.length) out.push({ event: ev, own, inherited, eventMatched: false });
  }
  return out;
}

/**
 * The package a record stands for in the panel: the record itself for a package, otherwise the first
 * package a character, squad or faction holds (`PACKAGE_HOLDER_FIELDS` order).
 */
export function heldPackage(ctx: ModContext, sid: string): string | undefined {
  const rec = ctx.get(sid);
  if (!rec) return undefined;
  const type = itemTypeName(rec.type);
  if (type === 'DIALOGUE_PACKAGE') return sid;
  for (const f of PACKAGE_HOLDER_FIELDS[type] ?? []) {
    for (const r of rec.refs.get(f) ?? []) if (ctx.get(r.target)) return r.target;
  }
  return undefined;
}
