/**
 * «▶ Play» strip of the dialogue editor (G7): who says what on an event.
 *
 * - {@link dialoguePlaySpots}: where the dialogue (or line, or package) is heard — a package and an
 *   event number, or the `dialogue` field of a character (the talk event).
 * - {@link packagePlayStart}: the start list of a package on an event, for `playConversation`
 *   (`input.start`) when no particular character is picked.
 * - {@link playCandidates}: the candidates of the first step ranked the way the game sorts them
 *   (`dialogSortKey`: own score + best root line), with the winner and the tie.
 * - {@link eventDialogueLike}: the draft of a new dialogue «like this one» for the G6 window.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { ModContext } from '../model/context.ts';
import { DIALOGUE_CONDITION_CATEGORIES, dialogueScore } from '../model/dialogue-score.ts';
import type { DialogWhen } from './builder.ts';
import { lineTexts } from './edit.ts';
import type { EventLine } from './event-dialogue.ts';
import type { PlayOption } from './play.ts';
import { dialogSortKey, EVENT_TALK, packageDialogs, type TalkSource } from './talk.ts';
import { dialogueWhen, lineDialogues } from './when.ts';

/** One place where a dialogue is heard. */
export interface PlaySpot {
  /** EventTriggerEnum value. */
  event: number;
  /** The package whose `dialogs` reference holds the dialogue. */
  pkg?: string;
  /** A character whose own `dialogue` field holds it (talk event). */
  character?: string;
  /** The dialogue the spot was found for (a line or a package can lead to several). */
  dialog?: string;
}

/** Characters listed per direct `dialogue` holder group (the rest are rarely useful in a list). */
const MAX_DIRECT = 20;

const typeOf = (ctx: ModContext, sid: string): string | undefined => {
  const r = ctx.get(sid);
  return r ? itemTypeName(r.type) : undefined;
};

function spotsOfDialogue(ctx: ModContext, dialog: string): PlaySpot[] {
  const out: PlaySpot[] = [];
  for (const s of dialogueWhen(ctx, dialog)) {
    if (s.pkg !== undefined) {
      for (const event of s.events) out.push({ event, pkg: s.pkg, dialog });
      continue;
    }
    if (!s.events.includes(EVENT_TALK)) continue;
    // Only characters are played; a diplomatic assault overrides the dialogue of its squad leader.
    for (const h of s.holders.filter((x) => x.type === 'CHARACTER').slice(0, MAX_DIRECT)) out.push({ event: EVENT_TALK, character: h.sid, dialog });
  }
  return out;
}

/**
 * Where `sid` is heard: a DIALOGUE — its package references (one spot per event) and its direct
 * `dialogue` holders; a DIALOGUE_LINE — the spots of the dialogues it belongs to; a
 * DIALOGUE_PACKAGE — every event of the package (its own and inherited), in package order.
 */
export function dialoguePlaySpots(ctx: ModContext, sid: string): PlaySpot[] {
  const type = typeOf(ctx, sid);
  if (type === 'DIALOGUE') return spotsOfDialogue(ctx, sid);
  if (type === 'DIALOGUE_LINE') {
    const out: PlaySpot[] = [];
    const seen = new Set<string>();
    for (const d of lineDialogues(ctx, sid))
      for (const s of spotsOfDialogue(ctx, d)) {
        const k = `${String(s.event)}|${s.pkg ?? ''}|${s.character ?? ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(s);
      }
    return out;
  }
  if (type === 'DIALOGUE_PACKAGE') {
    const out: PlaySpot[] = [];
    const seen = new Set<number>();
    for (const d of packageDialogs(ctx, sid)) {
      if (seen.has(d.event)) continue;
      seen.add(d.event);
      out.push({ event: d.event, pkg: sid, dialog: d.dialog });
    }
    return out;
  }
  return [];
}

/** The dialogues of a package (with inherited ones) on an event, as `playConversation` start list. */
export function packagePlayStart(ctx: ModContext, pkg: string, event: number): Map<string, TalkSource[]> {
  const out = new Map<string, TalkSource[]>();
  for (const d of packageDialogs(ctx, pkg)) {
    if (d.event !== event) continue;
    const s: TalkSource = { via: 'character-package', holder: d.pkg, dialog: d.dialog };
    const had = out.get(d.dialog);
    if (had) had.push(s);
    else out.set(d.dialog, [s]);
  }
  return out;
}

/** A candidate of the first step with the game's sort key. */
export interface PlayCandidate {
  sid: string;
  /** Sort key: own score + the best root line score (not below 0) — `dialogSortKey`. */
  key: number;
  /** Own score of the DIALOGUE record. */
  own: number;
  /** Part of the key from the best root line. */
  line: number;
  /** 1-based place in the game's order (equal keys share the list order). */
  place: number;
}

export interface PlayCandidates {
  rows: PlayCandidate[];
  /** The candidate the play went with. */
  chosen?: string;
  /** Candidates that may come up instead of the chosen one at random (a tie), the chosen one first. */
  tie: string[];
}

const EPS = 1e-9;

/** Rank the options of the first play step by the game's key; the tie are the options with a chance. */
export function playCandidates(ctx: ModContext, options: readonly PlayOption[]): PlayCandidates {
  const rows = options.map((o, i) => {
    const rec = ctx.get(o.sid);
    const key = rec ? dialogSortKey(ctx, o.sid) : 0;
    const own = rec ? dialogueScore(ctx, rec).total : 0;
    return { sid: o.sid, key, own, line: key - own, i };
  });
  rows.sort((a, b) => b.key - a.key || a.i - b.i);
  const out: PlayCandidates = { rows: rows.map((r, k) => ({ sid: r.sid, key: r.key, own: r.own, line: r.line, place: k + 1 })), tie: [] };
  const chosen = options.find((o) => o.why === 'chosen' || o.why === 'chosen-random');
  if (chosen) {
    out.chosen = chosen.sid;
    if (chosen.why === 'chosen-random') out.tie = [chosen.sid, ...options.filter((o) => o.why === 'random' && o.odds > EPS).map((o) => o.sid)];
  }
  return out;
}

/** Draft of a new dialogue «like» an existing one: what the G6 window starts with. */
export interface EventDialogueLike {
  /** The first `my race` of the dialogue (the window's «only race»). */
  race?: string;
  /** The other dialogue-level conditions. */
  when: DialogWhen[];
  /** The first chain of lines: root line, then the first child, while they are «me» or «target». */
  lines: EventLine[];
  rep: number;
  monologue: boolean;
}

/** Longest line chain copied into the draft. */
const MAX_LINES = 6;

/** A new dialogue like `dialog`: its conditions, `my race`, line chain, repetition limit and monologue. */
export function eventDialogueLike(ctx: ModContext, dialog: string): EventDialogueLike | undefined {
  const rec = ctx.get(dialog);
  if (!rec || itemTypeName(rec.type) !== 'DIALOGUE') return undefined;
  const out: EventDialogueLike = { when: [], lines: [], rep: rec.ints.get('repetition limit') ?? 0, monologue: rec.bools.get('monologue') ?? true };
  for (const cat of DIALOGUE_CONDITION_CATEGORIES) {
    for (const r of rec.refs.get(cat) ?? []) {
      if (!ctx.get(r.target)) continue;
      if (cat === 'conditions') {
        const a = ctx.get(r.target)!;
        const w: DialogWhen = { cond: a.ints.get('condition name') ?? 0, who: a.ints.get('who') ?? 0, v: r.v0, cmp: a.ints.get('compare by') ?? 0 };
        const tag = a.ints.get('tag') ?? -1;
        out.when.push(tag >= 0 ? { ...w, tag } : w);
      } else if (cat === 'world state') out.when.push({ ws: r.target, v: r.v0 });
      else if (cat === 'my race' && out.race === undefined) out.race = r.target;
      else out.when.push({ ref: cat, targets: [r.target] });
    }
  }
  const seen = new Set<string>();
  let cur = rec.refs.get('lines')?.[0]?.target;
  while (cur !== undefined && !seen.has(cur) && out.lines.length < MAX_LINES) {
    seen.add(cur);
    const l = ctx.get(cur);
    if (!l) break;
    const speaker = l.ints.get('speaker') ?? 0;
    if (speaker !== 0 && speaker !== 1) break;
    const texts = lineTexts(l).filter((v) => v.trim() !== '');
    if (texts.length > 0) out.lines.push({ speaker, texts });
    cur = l.refs.get('lines')?.[0]?.target;
  }
  if (out.lines.length === 0) out.lines.push({ speaker: 0, texts: [''] });
  return out;
}
