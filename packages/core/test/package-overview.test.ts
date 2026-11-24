/**
 * The «Package» panel core: a dialogue package as an event list with groups, own and inherited
 * dialogues, holders and the search by translation, EV_ code, number and dialogue name.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeText,
  emptyRecord,
  encodeText,
  FileType,
  filterPackageEvents,
  heldPackage,
  itemTypeId,
  ModContext,
  packageOverview,
  refValueEnum,
  type DataFile,
  type GameRecord,
  type Reference,
} from '../src/index.ts';

const T = (n: string): number => itemTypeId(n)!;
const ref = (target: string, v0 = 0, v1 = 0): Reference => ({ target, v0, v1, v2: 0 });

function rec(type: string, sid: string, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(T(type), sid, encodeText(name));
  fill(r);
  return r;
}

const file = (records: GameRecord[]): DataFile => ({ fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() });

// Package «squad» (own: talk ×2, healed, cannibals) inherits «basic», which inherits «root» (and «squad» back: a cycle).
function ctxOf(): ModContext {
  const records = [
    rec('DIALOGUE', 'd.talk', 'talk drifter'),
    rec('DIALOGUE', 'd.saviour', 'My saviour (recruit)'),
    rec('DIALOGUE', 'd.healed', 'Healed (Recruit)'),
    rec('DIALOGUE', 'd.cannibals', 'Cannibals!'),
    rec('DIALOGUE', 'd.basic-talk', 'basic talk'),
    rec('DIALOGUE', 'd.root-rain', 'rain'),
    rec('DIALOGUE_PACKAGE', 'p.squad', 'Drifter squad', (r) => {
      // EV_PLAYER_TALK_TO_ME = 1, EV_BEING_HEALED_FINISHED = 21, EV_______ = 5; one reference on two events.
      r.refs.set('dialogs', [ref('d.talk', 1), ref('d.saviour', 1), ref('d.healed', 21, 1), ref('d.cannibals', 5)]);
      r.refs.set('inheritsFrom', [ref('p.basic')]);
    }),
    rec('DIALOGUE_PACKAGE', 'p.basic', 'npc basic human', (r) => {
      // d.talk is own already: not listed again as inherited.
      r.refs.set('dialogs', [ref('d.basic-talk', 1), ref('d.talk', 1)]);
      r.refs.set('inheritsFrom', [ref('p.root'), ref('p.squad')]);
    }),
    rec('DIALOGUE_PACKAGE', 'p.root', 'root', (r) => {
      r.refs.set('dialogs', [ref('d.root-rain', 62)]);
    }),
    rec('CHARACTER', 'c.drifter', 'Drifter', (r) => {
      r.refs.set('dialogue package', [ref('p.squad')]);
    }),
    rec('SQUAD_TEMPLATE', 's.drifters', 'Drifters', (r) => {
      r.refs.set('dialog squad', [ref('p.squad')]);
    }),
  ];
  return new ModContext({ layers: [{ name: 'gamedata.base', file: file(records) }], modName: 'Test.mod' });
}

describe('packageOverview', () => {
  it('counts own and inherited events and dialogues, walks inheritance once', () => {
    const ctx = ctxOf();
    const o = packageOverview(ctx, 'p.squad');
    expect(o.ownDialogs).toBe(4);
    expect(o.ownEvents).toBe(3);
    expect(o.inherits).toEqual(['p.basic']);
    expect(o.ancestors).toEqual(['p.basic', 'p.root']);
    expect(o.withInheritedEvents).toBe(4);
    expect(o.inheritedDialogs).toBe(2);
    const talk = o.events.find((e) => e.event === 1)!;
    expect(talk).toMatchObject({ name: 'EV_PLAYER_TALK_TO_ME', group: 'talk', own: ['d.talk', 'd.saviour', 'd.healed'] });
    expect(talk.inherited).toEqual([{ dialog: 'd.basic-talk', pkg: 'p.basic' }]);
    expect(o.events.find((e) => e.event === 21)).toMatchObject({ group: 'health', own: ['d.healed'] });
    expect(o.events.find((e) => e.event === 62)).toMatchObject({ group: 'place', own: [], inherited: [{ dialog: 'd.root-rain', pkg: 'p.root' }] });
    expect(o.holders.map((h) => `${h.type}:${h.sid}:${h.field}`).sort()).toEqual(['CHARACTER:c.drifter:dialogue package', 'SQUAD_TEMPLATE:s.drifters:dialog squad']);
  });

  it('lists every event except the service values, in group order', () => {
    const ctx = ctxOf();
    const o = packageOverview(ctx, 'p.squad');
    const def = refValueEnum(ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0)!;
    // EventTriggerEnum has EV_NONE … EV_MAX; both are service values.
    expect(o.events).toHaveLength(def.values.length - 2);
    expect(o.events.some((e) => e.name === 'EV_NONE' || e.name === 'EV_MAX')).toBe(false);
    expect(o.events[0]!.group).toBe('talk');
    const groups = o.events.map((e) => e.group).filter((g, i, a) => a.indexOf(g) === i);
    expect(groups.slice(0, 3)).toEqual(['talk', 'see', 'fight']);
    expect(groups.at(-1)).toBe('unused');
  });

  it('a missing package is empty', () => {
    const o = packageOverview(ctxOf(), 'nope');
    expect(o.ownDialogs).toBe(0);
    expect(o.holders).toEqual([]);
  });
});

describe('filterPackageEvents', () => {
  const ctx = ctxOf();
  const o = packageOverview(ctx, 'p.squad');
  const def = refValueEnum(ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0);
  const name = (sid: string): string => { const r = ctx.get(sid); return r ? decodeText(r.name) : sid; };
  const events = (mode: 'busy' | 'all' | 'inherited', q: string, lang = 'ru'): number[] => filterPackageEvents(def, o, mode, q, lang, name).map((r) => r.event.event);

  it('modes: busy, all, with inherited', () => {
    expect(events('busy', '')).toEqual([1, 5, 21]);
    expect(events('all', '')).toHaveLength(o.events.length);
    expect(events('inherited', '')).toEqual([1, 5, 21, 62]);
  });

  it('finds the same event by translation, code and number', () => {
    expect(events('busy', 'вылечил')).toEqual([21]);
    expect(events('busy', 'EV_BEING_HEALED_FINISHED')).toEqual([21]);
    expect(events('busy', '21')).toEqual([21]);
    expect(events('busy', 'was healed', 'en')).toEqual([21]);
    // EV_BEING_HEALED is also the start of EV_BEING_HEALED_START (19): in «all» both are found.
    expect(events('all', 'EV_BEING_HEALED')).toEqual([19, 21]);
  });

  it('a dialogue name lists only the matching dialogues', () => {
    const rows = filterPackageEvents(def, o, 'busy', 'saviour', 'ru', name);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventMatched: false, own: ['d.saviour'] });
    // Inherited dialogues are searched only with inherited shown.
    expect(events('busy', 'rain')).toEqual([]);
    expect(events('inherited', 'basic talk')).toEqual([1]);
    // A string id is matched whole, not by a part of it.
    expect(events('busy', 'd.healed')).toEqual([1, 21]);
    expect(events('busy', 'healed')).toEqual([1, 21]);
    expect(events('busy', 'd.sav')).toEqual([]);
  });
});

describe('heldPackage', () => {
  it('a package is itself, a holder gives its first package', () => {
    const ctx = ctxOf();
    expect(heldPackage(ctx, 'p.basic')).toBe('p.basic');
    expect(heldPackage(ctx, 'c.drifter')).toBe('p.squad');
    expect(heldPackage(ctx, 's.drifters')).toBe('p.squad');
    expect(heldPackage(ctx, 'd.talk')).toBeUndefined();
  });
});
