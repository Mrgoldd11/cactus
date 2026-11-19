/**
 * «+ condition» / «+ effect» list of the line panel (G4) on the installed game: DC_/DA_ values and
 * reference conditions in one list, search by translation, English and code, adding into the right field.
 */
import { describe, expect, it } from 'vitest';
import { addDialogPick, dialogPickGroups, dialogPickItems, dialogPickUsage, itemTypeId, removeLineRef, setLineRefValue } from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
/** «Healed (Recruit)»: «It's rare to meet good folks like you…», one condition (honorable). */
const LINE = '8951-Dialogue.mod';

describe.skipIf(!hasGame(paths))('dialog picker: vanilla', () => {
  const { ctx } = loadModContext({ paths, schema: true });
  const usage = dialogPickUsage(ctx);

  it('one list: DC_ values and reference conditions, found by Russian, English and code', () => {
    const items = dialogPickItems(ctx, 'DIALOGUE_LINE', 'condition', 'ru', usage);
    expect(items.filter((i) => i.source === 'ref').map((i) => i.code)).toContain('my race');
    expect(items.some((i) => i.code === 'DC_NONE')).toBe(false);
    for (const q of ['голод', 'starv', 'DC_STARV']) {
      const found = dialogPickGroups(items, 'condition', q, 'ru').flatMap((g) => g.items.map((i) => i.code));
      expect(found, q).toContain('DC_STARVING');
    }
    // Reference conditions are searched the same way and sit in the groups next to DC_ values.
    const race = dialogPickGroups(items, 'condition', 'моя раса', 'ru');
    // «моя подраса» also contains «раса».
    expect(race.flatMap((g) => g.items.map((i) => i.key))).toEqual(['ref:my race', 'ref:my subrace']);
    expect(race[0]!.label).toBe('Кто это');
    expect(race[0]!.items[0]).toMatchObject({ targetType: 'RACE', label: 'Моя раса' });
    // Without a query the most used ones go first.
    const all = dialogPickGroups(items, 'condition', '', 'ru');
    expect(all[0]!.key).toBe('common');
    expect(all[0]!.items).toHaveLength(6);
  });

  it('effects: DA_ values and reference effects; a dialogue has no DA_ effects', () => {
    const line = dialogPickItems(ctx, 'DIALOGUE_LINE', 'effect', 'ru', usage);
    expect(line.some((i) => i.code === 'DA_LOCK_THIS_DIALOG')).toBe(true);
    expect(line.find((i) => i.code === 'give item')).toMatchObject({ source: 'ref', targetType: 'ITEM', group: 'trade' });
    const head = dialogPickItems(ctx, 'DIALOGUE', 'effect', 'ru', usage);
    expect(head.some((i) => i.source === 'enum')).toBe(false);
    expect(head.some((i) => i.code === 'unlocks')).toBe(true);
  });

  it('a picked reference condition lands in its field of the line, one undo', () => {
    const items = dialogPickItems(ctx, 'DIALOGUE_LINE', 'condition', 'en', usage);
    const myRace = items.find((i) => i.key === 'ref:my race')!;
    const race = [...ctx.records()].find((r) => r.type === itemTypeId('RACE'))!.stringId;
    const before = ctx.get(LINE)!.refs.get('my race')?.length ?? 0;
    addDialogPick(ctx, LINE, myRace, race);
    expect(ctx.get(LINE)!.refs.get('my race')!.map((r) => r.target)).toContain(race);
    expect(ctx.get(LINE)!.refs.get('conditions')).toHaveLength(1);
    // Wrong target type is refused.
    const item = [...ctx.records()].find((r) => r.type === itemTypeId('ITEM'))!.stringId;
    expect(() => addDialogPick(ctx, LINE, myRace, item)).toThrow(/RACE/);
    ctx.undo();
    expect(ctx.get(LINE)!.refs.get('my race')?.length ?? 0).toBe(before);
  });

  it('a picked DC_ condition: «who: I», yes/no compares with 1', () => {
    const items = dialogPickItems(ctx, 'DIALOGUE_LINE', 'condition', 'en', usage);
    const id = addDialogPick(ctx, LINE, items.find((i) => i.code === 'DC_STARVING')!);
    const ref = ctx.get(LINE)!.refs.get('conditions')!.find((r) => r.target === id)!;
    expect(ref.v0).toBe(1);
    expect(ctx.get(id)!.ints.get('who')).toBe(0);
    ctx.undo();
    expect(ctx.get(LINE)!.refs.get('conditions')).toHaveLength(1);
  });

  it('a reference row: value and removal are one undo step each', () => {
    const faction = [...ctx.records()].find((r) => r.type === itemTypeId('FACTION'))!.stringId;
    const items = dialogPickItems(ctx, 'DIALOGUE_LINE', 'effect', 'en', usage);
    addDialogPick(ctx, LINE, items.find((i) => i.key === 'ref:change relations')!, faction);
    const ref = (): { v0: number } | undefined => ctx.get(LINE)!.refs.get('change relations')?.find((r) => r.target === faction);
    setLineRefValue(ctx, LINE, 'change relations', faction, 25);
    expect(ref()?.v0).toBe(25);
    removeLineRef(ctx, LINE, 'change relations', faction);
    expect(ref()).toBeUndefined();
    ctx.undo();
    expect(ref()?.v0).toBe(25);
    ctx.undo();
    ctx.undo();
    expect(ref()).toBeUndefined();
    expect(() => {
      setLineRefValue(ctx, LINE, 'change relations', faction, 1);
    }).toThrow();
  });
});
