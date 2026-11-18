/**
 * `DIALOGUE_PACKAGE.dialogs`: the game reads v0, v1 and v2 of each reference as events (except 0 and 100),
 * as decoded from the exe (`Dialogue::addDialoguePackage`, research/dialogue-package-events-re.md).
 */
import { describe, expect, it } from 'vitest';
import {
  buildDialogueGraph,
  buildDialogueTree,
  describeRefValues,
  DialogBuilder,
  emptyRecord,
  encodeText,
  FileType,
  formatDialogueTree,
  itemTypeId,
  ModContext,
  packageDialogs,
  packageRefEvents,
  refGroups,
  refValueEnum,
  simulateTalk,
  SPEAKER,
  squadIndex,
  talkSources,
  validateMod,
  type DataFile,
  type GameRecord,
  type Reference,
} from '../src/index.ts';

const b = (s: string): Uint8Array => encodeText(s);
const T = (n: string): number => itemTypeId(n)!;
const ref = (target: string, v0 = 0, v1 = 0, v2 = 0): Reference => ({ target, v0, v1, v2 });

function rec(type: string, sid: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(T(type), sid, b(sid));
  fill(r);
  return r;
}

/** A dialogue with one NPC line (`act`: an effect on the line). */
function dlg(sid: string, act?: string): GameRecord[] {
  const line = rec('DIALOGUE_LINE', `${sid}.L`, (r) => {
    r.ints.set('speaker', 0);
    r.strings.set('text0', b(`${sid} says hi`));
    if (act !== undefined) r.refs.set('effects', [ref(act)]);
  });
  return [rec('DIALOGUE', sid, (r) => r.refs.set('lines', [ref(line.stringId)])), line];
}

/**
 * Character C with package PK, like «beep (player)» in rebirth.mod:
 * HEAL 21/24/0, SEE 3/23/0, ARM 71/70/69; NONE 0/0/0 (never fires), SKIP 100/0/62 (100 is skipped);
 * COP 0/24/0 arrests.
 */
function ctxOf(): ModContext {
  const file: DataFile = {
    fileType: FileType.Data,
    lastId: 0,
    tail: new Uint8Array(),
    records: [
      ...dlg('HEAL'),
      ...dlg('SEE'),
      ...dlg('ARM'),
      ...dlg('NONE'),
      ...dlg('SKIP'),
      rec('DIALOG_ACTION', 'ARREST', (r) => r.ints.set('action name', 29)),
      ...dlg('COP', 'ARREST'),
      rec('DIALOGUE_PACKAGE', 'PK', (r) =>
        r.refs.set('dialogs', [ref('HEAL', 21, 24), ref('SEE', 3, 23), ref('ARM', 71, 70, 69), ref('NONE'), ref('SKIP', 100, 0, 62), ref('COP', 0, 24)]),
      ),
      rec('CHARACTER', 'C', (r) => r.refs.set('dialogue package', [ref('PK')])),
    ],
  };
  return new ModContext({ layers: [{ name: 'gamedata.base', file }], modName: 'Test.mod' });
}

describe('package dialogue events: v0, v1, v2', () => {
  it('packageRefEvents: every slot except 0 and 100, without repeats', () => {
    expect(packageRefEvents(ref('X'))).toEqual([]);
    expect(packageRefEvents(ref('X', 1))).toEqual([1]);
    expect(packageRefEvents(ref('X', 21, 24))).toEqual([21, 24]);
    expect(packageRefEvents(ref('X', 71, 70, 69))).toEqual([71, 70, 69]);
    expect(packageRefEvents(ref('X', 0, 3))).toEqual([3]);
    expect(packageRefEvents(ref('X', 100, 0, 62))).toEqual([62]);
    expect(packageRefEvents(ref('X', 1, 1, 100))).toEqual([1]);
  });

  it('the schema treats all three values as EventTriggerEnum', () => {
    for (const slot of [0, 1, 2]) expect(refValueEnum(undefined, 'DIALOGUE_PACKAGE', 'dialogs', slot)?.name).toBe('EventTriggerEnum');
  });

  it('talk sources find a dialogue by any of its events', () => {
    const ctx = ctxOf();
    const c = ctx.get('C')!;
    const sq = squadIndex(ctx);
    const by = (ev: number): string[] => talkSources(ctx, c, ev, sq).map((s) => s.dialog);
    expect(by(21)).toEqual(['HEAL']);
    expect(by(24)).toEqual(['HEAL', 'COP']);
    expect(by(3)).toEqual(['SEE']);
    expect(by(23)).toEqual(['SEE']);
    expect(by(69)).toEqual(['ARM']);
    expect(by(70)).toEqual(['ARM']);
    expect(by(71)).toEqual(['ARM']);
    expect(by(62)).toEqual(['SKIP']);
    // EV_NONE and 100 are never events.
    expect(by(0)).toEqual([]);
    expect(by(100)).toEqual([]);
    expect(packageDialogs(ctx, 'PK').filter((d) => d.dialog === 'NONE')).toEqual([]);
    expect(simulateTalk(ctx, 'C', 70).candidates.map((x) => x.dialog)).toEqual(['ARM']);
  });

  it('the package tree and graph show every event of the reference', () => {
    const ctx = ctxOf();
    const tree = buildDialogueTree(ctx, 'PK');
    const arm = tree.children.find((n) => n.stringId === 'ARM')!;
    expect(arm.event).toBe(71);
    expect(arm.events).toEqual([71, 70, 69]);
    // A reference without events keeps its v0 (EV_NONE) so the dead entry stays visible.
    expect(tree.children.find((n) => n.stringId === 'NONE')!.events).toEqual([0]);
    const text = formatDialogueTree(ctx, tree, { lang: 'ru' }).join('\n');
    expect(text).toContain('[событие EV_LOST_ARM (71), EV_LOST_LEG (70), EV_BURNING (69)]');
    const g = buildDialogueGraph(ctx, 'PK').nodes.find((n) => n.id === 'HEAL')!;
    expect(g.events).toEqual([21, 24]);
    expect(g.eventLabel).toBe('EV_BEING_HEALED_FINISHED (21), EV_GET_UP_FIGHT “got up in a fight” (24)');
  });

  it('record editor: three event columns, labels in the interface language', () => {
    const ctx = ctxOf();
    const ru = refGroups(ctx, 'PK', 'ru').find((g) => g.category === 'dialogs')!;
    expect(ru.valueLabels).toEqual(['событие', 'событие 2', 'событие 3']);
    expect(ru.valueEnums.map((e) => e?.name)).toEqual(['EventTriggerEnum', 'EventTriggerEnum', 'EventTriggerEnum']);
    expect(refGroups(ctx, 'PK', 'en').find((g) => g.category === 'dialogs')!.valueLabels).toEqual(['event', 'event 2', 'event 3']);
    expect(refGroups(ctx, 'PK', 'zh').find((g) => g.category === 'dialogs')!.valueLabels).toEqual(['事件', '事件 2', '事件 3']);
  });

  it('describeRefValues lists the set slots', () => {
    expect(describeRefValues(undefined, 'DIALOGUE_PACKAGE', 'dialogs', ref('S', 3, 23), 'en')).toBe('event EV_I_SEE_NEUTRAL_SQUAD “sees a neutral squad” (3), event 2 EV_GET_UP_PEACE “got up after a fight” (23)');
    expect(describeRefValues(undefined, 'DIALOGUE_PACKAGE', 'dialogs', ref('S', 1), 'ru')).toBe('событие EV_PLAYER_TALK_TO_ME «разговор» (1)');
  });

  it('the builder reuses the reference: an event already in v1/v2 is kept, a new one goes into a free slot', () => {
    const ctx = ctxOf();
    const bld = new DialogBuilder(ctx);
    const refsTo = (t: string): Reference[] => ctx.get('PK')!.refs.get('dialogs')!.filter((r) => r.target === t);
    bld.attachToPackages(['C'], 'ARM', 70);
    expect(refsTo('ARM')).toEqual([ref('ARM', 71, 70, 69)]);
    bld.attachToPackages(['C'], 'HEAL', 5);
    expect(refsTo('HEAL')).toEqual([ref('HEAL', 21, 24, 5)]);
    // No free slot left: the reference stays as it is.
    bld.attachToPackages(['C'], 'ARM', 5);
    expect(refsTo('ARM')).toEqual([ref('ARM', 71, 70, 69)]);
  });

  it('the override check sees a mod dialogue added under v1', () => {
    const ctx = ctxOf();
    const bld = new DialogBuilder(ctx);
    // The mod puts its dialogue on event 24 through v1 only (v0 = 0): COP arrests on 24 with the same score.
    const mine = bld.dialogue('mine', [bld.line('mine.l', SPEAKER.ME, ['hi'])], [], { score: 0 });
    ctx.editRecord('PK', (d) => {
      d.refs.set('dialogs', [...(d.refs.get('dialogs') ?? []), ref(mine, 0, 24)]);
    });
    const w = validateMod(ctx).filter((i) => i.code === 'overrides-action');
    expect(w.map((i) => [i.stringId, i.target])).toEqual([['PK', mine]]);
    expect(w[0]!.message).toContain('on event 24');
  });
});
