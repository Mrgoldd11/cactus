/**
 * Dialogue builder for build scripts (`kedit build`): lines, dialogues, conditions and effects
 * without fiddling with DIALOG_ACTION and references by hand. Generalises the Vanilla Talk mod build.
 *
 *   const b = new DialogBuilder(ctx, env.stableIds());
 *   const hi = b.line('My greeting', SPEAKER.ME, ['Hello.'], { score: 10 });
 *   const dlg = b.dialogue('My talk', [hi], [{ cond: 7, who: 1, v: 0 }], { score: -100 });
 *   b.attachToCharacter('1234-gamedata.base', dlg);          // click (event 1)
 *   b.attachToPackages(['1234-gamedata.base'], dlg, 3);      // package event
 *
 * Vanilla records are changed only by appending references (`dialogue`, `dialogs`). Names of new
 * records must be unique: with the stable id table (`StableIds`) the number is issued by name.
 */
import { encodeText } from '../text.ts';
import { itemTypeId } from '../format/item-types.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import type { ModContext } from '../model/context.ts';
import type { StableIds } from '../model/stable-ids.ts';
import { packageRefEvents } from '../model/enums.ts';
import { PACKAGE_EVENT_SKIP } from '../schema/builtin-enums.ts';
import { characterFactions, squadIndex, type SquadIndex } from './talk.ts';

/** Who speaks (TalkerEnum). */
export const SPEAKER = { ME: 0, TARGET: 1, TARGET_IF_PLAYER: 2 } as const;

/** Condition of a line or dialogue. */
export type DialogWhen =
  /** DIALOG_ACTION condition: `condition name`, who (0 = speaker, 1 = target), value, comparison 0 = 1 < 2 >, tag. */
  | { cond: number; who: number; v: number; cmp?: number; tag?: number }
  /** World state (1 = true, 0 = false). */
  | { ws: string; v: number }
  /** The speaker is currently in a town of this faction. */
  | { inTown: string }
  /** The target has someone of these races (OR). */
  | { targetRace: readonly string[] }
  /** None of these races (AND). */
  | { noTargetRace: readonly string[] }
  /** The speaker is in one of these factions. */
  | { myFaction: readonly string[] }
  /** The speaker is of one of these races (OR). */
  | { myRace: readonly string[] }
  /** The speaker is one of these characters. */
  | { isChar: readonly string[] }
  /** Any reference category of a dialogue (`my race`, `target has item`, …) with its target records. */
  | { ref: string; targets: readonly string[] };

export interface LineOptions {
  when?: readonly DialogWhen[];
  children?: readonly string[];
  /** Line effect (DialogActionEnum): trade 1, attack 6, ... */
  action?: number;
  score?: number;
  /** `chance temporary`, % (default 100). */
  chance?: number;
}

export interface DialogueOptions {
  score?: number;
  /** `repetition limit` (0 = unlimited). */
  rep?: number;
  oneAtATime?: boolean;
  forEnemies?: boolean;
  locked?: boolean;
  monologue?: boolean;
  tag?: string;
}

export interface CreateFields {
  bools?: Record<string, boolean>;
  floats?: Record<string, number>;
  ints?: Record<string, number>;
  strs?: Record<string, string>;
  refs?: Record<string, readonly Reference[]>;
}

const ref = (target: string, v0 = 0, v1 = 0, v2 = 0): Reference => ({ target, v0, v1, v2 });

/** Append `dialog` to the package under `event` (into a free slot of an existing reference to it). */
export function addDialogToPackage(ctx: ModContext, pkg: string, dialog: string, event: number): void {
  ctx.editRecord(pkg, (d) => {
    const list = d.refs.get('dialogs') ?? [];
    const same = list.filter((x) => x.target === dialog);
    if (!same.some((x) => packageRefEvents(x).includes(event))) {
      // One reference per target survives the mod diff, and the game reads v0, v1 and v2 as events:
      // put the event into a free slot (0 or 100) of the existing reference.
      const slot = (['v0', 'v1', 'v2'] as const).find((k) => same[0] !== undefined && PACKAGE_EVENT_SKIP.includes(same[0][k]));
      if (same[0] && slot) same[0][slot] = event;
      else if (!same[0]) list.push(ref(dialog, event));
    }
    d.refs.set('dialogs', list);
  });
}

/** Where to attach character events: own package → squad packages → default faction package. */
export function attachPackages(ctx: ModContext, c: GameRecord, sq: SquadIndex): { via: 'own' | 'squad' | 'faction'; pkgs: string[] } {
  const own = (c.refs.get('dialogue package') ?? []).map((r) => r.target);
  if (own.length) return { via: 'own', pkgs: own };
  const squads = new Set<string>();
  for (const { squad, leader } of sq.get(c.stringId) ?? []) {
    const s = ctx.get(squad);
    if (leader) for (const r of s?.refs.get('dialog leader') ?? []) squads.add(r.target);
    for (const r of s?.refs.get('dialog squad') ?? []) squads.add(r.target);
  }
  if (squads.size) return { via: 'squad', pkgs: [...squads] };
  const fac = new Set<string>();
  for (const f of characterFactions(ctx, c, sq)) for (const r of ctx.get(f)?.refs.get('dialog default') ?? []) fac.add(r.target);
  return { via: 'faction', pkgs: [...fac] };
}

export class DialogBuilder {
  readonly ctx: ModContext;
  private readonly ids: StableIds | undefined;
  private readonly used = new Set<string>();
  private sq: SquadIndex | undefined;
  /** Characters for which no package was found for the event. */
  readonly noPackage = new Set<string>();

  constructor(ctx: ModContext, ids?: StableIds) {
    this.ctx = ctx;
    this.ids = ids;
  }

  private type(name: string): number {
    const t = itemTypeId(name);
    if (t === undefined) throw new Error(`no type ${name}`);
    return t;
  }

  /** A record that must exist in the lower layers or the mod. */
  need(sid: string): string {
    if (!this.ctx.get(sid)) throw new Error(`No record ${sid}`);
    return sid;
  }

  /** New record with fields; the name is unique within the build. */
  create(typeName: string, name: string, f: CreateFields = {}): string {
    if (this.used.has(name)) throw new Error(`Duplicate record name: ${name}`);
    this.used.add(name);
    const sid = this.ctx.createRecord(this.type(typeName), name, this.ids ? { stringId: this.ids.id(name) } : {});
    this.ctx.editRecord(sid, (d) => {
      for (const [k, v] of Object.entries(f.bools ?? {})) d.bools.set(k, v);
      for (const [k, v] of Object.entries(f.floats ?? {})) d.floats.set(k, v);
      for (const [k, v] of Object.entries(f.ints ?? {})) d.ints.set(k, v);
      for (const [k, v] of Object.entries(f.strs ?? {})) d.strings.set(k, encodeText(v));
      for (const [c, l] of Object.entries(f.refs ?? {})) if (l.length) d.refs.set(c, l.map((r) => ({ ...r })));
    });
    return sid;
  }

  /** Conditions → reference categories; DIALOG_ACTION conditions are created with names `<owner> ?N`. */
  whenRefs(owner: string, when: readonly DialogWhen[] = []): Record<string, Reference[]> {
    const out: Record<string, Reference[]> = {};
    const push = (c: string, r: Reference): void => {
      (out[c] ??= []).push(r);
    };
    when.forEach((w, i) => {
      if ('cond' in w) {
        const a = this.create('DIALOG_ACTION', `${owner} ?${i + 1}`, {
          ints: { 'compare by': w.cmp ?? 0, 'condition name': w.cond, tag: w.tag ?? -1, who: w.who },
          strs: { stringvar: '' },
        });
        push('conditions', ref(a, w.v));
      } else if ('ws' in w) push('world state', ref(this.need(w.ws), w.v));
      else if ('inTown' in w) push('in town of', ref(this.need(w.inTown)));
      else if ('targetRace' in w) for (const r of w.targetRace) push('target race', ref(this.need(r)));
      else if ('noTargetRace' in w) for (const r of w.noTargetRace) push('no target race', ref(this.need(r)));
      else if ('myFaction' in w) for (const f of w.myFaction) push('my faction', ref(this.need(f)));
      else if ('myRace' in w) for (const r of w.myRace) push('my race', ref(this.need(r)));
      else if ('ref' in w) for (const r of w.targets) push(w.ref, ref(this.need(r)));
      else for (const c of w.isChar) push('is character', ref(this.need(c)));
    });
    return out;
  }

  /** Line: texts are `text0`, `text1`, ... (random wordings). */
  line(name: string, speaker: number, texts: readonly string[], o: LineOptions = {}): string {
    const refs = this.whenRefs(name, o.when);
    if (o.children?.length) refs['lines'] = o.children.map((c) => ref(c));
    if (o.action !== undefined) refs['effects'] = [ref(this.create('DIALOG_ACTION', `${name} !`, { ints: { 'action name': o.action } }))];
    return this.create('DIALOGUE_LINE', name, {
      floats: { 'chance permanent': 100, 'chance temporary': o.chance ?? 100 },
      ints: { 'repetition limit': 0, 'score bonus': o.score ?? 0, speaker, 'target is type': 0 },
      strs: Object.fromEntries(texts.map((t, k) => [`text${k}`, t])),
      refs,
    });
  }

  /** Dialogue with root lines and conditions. */
  dialogue(name: string, roots: readonly string[], when: readonly DialogWhen[] = [], o: DialogueOptions = {}): string {
    const refs = this.whenRefs(name, when);
    refs['lines'] = roots.map((r) => ref(r));
    return this.create('DIALOGUE', name, {
      bools: { 'for enemies': o.forEnemies ?? false, locked: o.locked ?? false, monologue: o.monologue ?? true, 'one at a time': o.oneAtATime ?? false },
      floats: { 'chance permanent': 100, 'chance temporary': 100 },
      ints: { 'repetition limit': o.rep ?? 0, 'score bonus': o.score ?? 0, 'target is type': 0 },
      ...(o.tag !== undefined ? { strs: { tag: o.tag } } : {}),
      refs,
    });
  }

  /** Append child lines (e.g. the menu loop after all topics are created). */
  addChildren(parent: string, children: readonly string[]): void {
    this.ctx.editRecord(this.need(parent), (d) => {
      const list = d.refs.get('lines') ?? [];
      for (const c of children) if (!list.some((x) => x.target === c)) list.push(ref(c));
      d.refs.set('lines', list);
    });
  }

  /** Click dialogue (event 1), into `CHARACTER.dialogue`. */
  attachToCharacter(character: string, dialog: string): void {
    this.ctx.editRecord(this.need(character), (d) => {
      const list = d.refs.get('dialogue') ?? [];
      if (!list.some((x) => x.target === dialog)) list.push(ref(dialog));
      d.refs.set('dialogue', list);
    });
  }

  /**
   * Event dialogue, into the packages these characters listen to (own package: the first one is enough,
   * the character's packages add up; squads and faction: all of them). Returns the packages appended to.
   */
  attachToPackages(characters: readonly string[], dialog: string, event: number): string[] {
    this.sq ??= squadIndex(this.ctx);
    const pkgs = new Set<string>();
    for (const c of characters) {
      const at = attachPackages(this.ctx, this.ctx.get(this.need(c))!, this.sq);
      const list = at.via === 'own' ? at.pkgs.slice(0, 1) : at.pkgs;
      if (!list.length) this.noPackage.add(c);
      for (const p of list) pkgs.add(p);
    }
    for (const p of pkgs) addDialogToPackage(this.ctx, p, dialog, event);
    return [...pkgs];
  }
}
