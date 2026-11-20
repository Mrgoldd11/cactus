/**
 * Sweep over every dialogue of the installed game (UI review G8): «when / who» is known for each DIALOGUE
 * (or it is reached from another dialogue, or it is honestly «in no package»), and every condition and
 * effect of every DIALOGUE / DIALOGUE_LINE reads as a phrase, not as a raw code. The counts are printed
 * for the report.
 */
import { describe, expect, it } from 'vitest';
import { dialogueWhen, itemTypeName, recordPhrases, transitionsTo } from '../src/index.ts';
import { LINE_REF_HELP } from '../src/schema/line-ref-help.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();

describe.skipIf(!hasGame(paths))('dialogue sweep: vanilla', () => {
  const { ctx } = loadModContext({ paths, schema: true });
  const dialogues = [...ctx.records()].filter((r) => itemTypeName(r.type) === 'DIALOGUE');
  const owners = [...ctx.records()].filter((r) => ['DIALOGUE', 'DIALOGUE_LINE'].includes(itemTypeName(r.type)));

  it('every DIALOGUE: who starts it, or which dialogue leads into it, or «in no package»', () => {
    const n = { dialogues: 0, inPackage: 0, otherStart: 0, talk: 0, onlyFromDialogue: 0, nowhere: 0, multiEvent: 0, overFour: 0, nobody: 0, interjection: 0 };
    const starts = new Map<string, number>();
    for (const d of dialogues) {
      n.dialogues++;
      const when = dialogueWhen(ctx, d.stringId);
      for (const s of when) {
        // A source always says when: events, a package (its events may be none), or the field that starts it.
        expect(s.events.length > 0 || s.pkg !== undefined || s.start !== undefined, d.stringId).toBe(true);
        expect(s.pkg !== undefined || s.holders.length > 0, d.stringId).toBe(true);
        if (s.start !== undefined) starts.set(s.start, (starts.get(s.start) ?? 0) + 1);
      }
      if (when.some((s) => s.pkg !== undefined)) n.inPackage++;
      if (when.some((s) => s.start !== undefined)) n.otherStart++;
      if (when.some((s) => s.pkg === undefined && s.events.length > 0)) n.talk++;
      if (when.length === 0) {
        if (transitionsTo(ctx, d.stringId).length > 0) n.onlyFromDialogue++;
        else n.nowhere++;
      }
      if (new Set(when.flatMap((s) => s.events)).size > 1) n.multiEvent++;
      if (when.length > 4) n.overFour++;
      if (when.some((s) => s.holders.length === 0)) n.nobody++;
      const lines = (d.refs.get('lines') ?? []).map((r) => ctx.get(r.target));
      if (lines.some((l) => l && (l.bools.get('interjection') === true || [6, 7, 8, 9].includes(l.ints.get('speaker') ?? 0)))) n.interjection++;
    }
    console.log('G8 sweep, dialogues:', JSON.stringify(n), 'started by:', JSON.stringify([...starts]));
    expect(n.dialogues).toBeGreaterThan(1800);
    // Biome arrival, campaign announcement, contract end: started without a package.
    expect(starts.get('BIOME_GROUP.arrival dialog')).toBeGreaterThan(30);
    expect(starts.get('FACTION_CAMPAIGN.dialog announcement')).toBeGreaterThan(50);
    expect(starts.get('AI_PACKAGE.contract end talk passive')).toBeGreaterThan(5);
    expect(n.onlyFromDialogue).toBeGreaterThan(20);
    expect(n.multiEvent).toBeGreaterThan(100);
    expect(n.overFour).toBeGreaterThan(10);
  });

  it('every condition and effect in the data reads as a phrase, in en, ru and zh', () => {
    const kinds = new Set<string>();
    let phrases = 0;
    const raw: string[] = [];
    for (const rec of owners) {
      const on = itemTypeName(rec.type) === 'DIALOGUE' ? 'dialogue' : 'line';
      // Every reference category of a dialogue record is either lines, a DIALOG_ACTION list or a phrase with help.
      for (const [c, refs] of rec.refs) if (refs.length > 0 && !['lines', 'conditions', 'effects'].includes(c)) expect(LINE_REF_HELP, `${rec.stringId} ${c}`).toHaveProperty([c]);
      for (const lang of ['en', 'ru', 'zh']) {
        const p = recordPhrases(ctx, rec, lang, on);
        for (const x of [...p.conditions, ...p.effects]) {
          phrases++;
          if (lang === 'en') kinds.add(x.source?.target !== undefined ? (x.code.split(' ')[0] ?? '') : (x.source?.category ?? x.code));
          if ((lang !== 'en' && x.short === x.code) || /\bD[CA]_[A-Z]/.test(x.short) || /\(#\d+\)/.test(x.short)) raw.push(`${rec.stringId} ${lang}: ${x.short}`);
        }
      }
    }
    console.log('G8 sweep, phrases:', phrases, 'kinds:', kinds.size);
    expect(raw.slice(0, 10)).toEqual([]);
    expect(kinds.size).toBeGreaterThan(100);
  });
});
