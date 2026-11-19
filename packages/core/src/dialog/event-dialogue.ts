/**
 * «Dialogue on event»: a new DIALOGUE with its lines (or an existing dialogue) put into a dialogue
 * package under an event number, in one history step. The moment a dialogue is spoken lives in the
 * `dialogs` reference of a DIALOGUE_PACKAGE (`dialog/when.ts`), so the wizard asks for the event and
 * for who has the package: a character, a squad or a faction (their package field), a ready package,
 * or «everyone of a race» — a shared package plus the `my race` condition of the DIALOGUE.
 *
 * A holder without a package in the field gets a new one. A holder whose package is shared by other
 * holders can get a new package of its own (`own`): the game adds up the packages of a field.
 */
import { decodeText } from '../text.ts';
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import { emptyRecord, type GameRecord, type Reference } from '../format/types.ts';
import { EditError, type ModContext } from '../model/context.ts';
import { DC_HAS_TAG, DIALOGUE_CONDITION_CATEGORIES, dialogueScore } from '../model/dialogue-score.ts';
import { PACKAGE_EVENT_SKIP } from '../schema/builtin-enums.ts';
import type { UiText } from '../ui-text.ts';
import { addDialogToPackage, DialogBuilder, SPEAKER, type DialogWhen } from './builder.ts';
import { dialogSortKey, EVENT_TALK, packageDialogs } from './talk.ts';
import { PACKAGE_HOLDER_FIELDS, packageHolders } from './when.ts';

const PACKAGE = 'DIALOGUE_PACKAGE';
const DIALOGUE = 'DIALOGUE';

/** Who gets the dialogue: a holder's package field, or a package picked directly. */
export type EventDialogueWho =
  /** Character, squad or faction and its package field (`PACKAGE_HOLDER_FIELDS`). */
  | {
      kind: 'holder';
      sid: string;
      field: string;
      /** Preferred package of the field (e.g. the one of a sample); the first one otherwise. */
      pkg?: string;
      /** Make a new package only for this holder even if the field has one. */
      own?: boolean;
    }
  | { kind: 'package'; pkg: string };

/** Where the dialogue goes for `who`. */
export interface EventDialogueTarget {
  /** Existing package to append to; absent — a new package is made. */
  pkg?: string;
  /** Distinct records that have `pkg` (also through inheriting packages); 0 for a new package. */
  sharedBy: number;
  /** Packages already in the holder field (for the choice «shared / own»). */
  existing: string[];
}

export interface EventLine {
  /** TalkerEnum: 0 — the speaker, 1 — the target. */
  speaker: number;
  /** Text variants: the game picks one of them at random. */
  texts: readonly string[];
}

export interface EventDialogueSpec {
  /** EventTriggerEnum value of the package reference. */
  event: number;
  who: EventDialogueWho;
  /** `my race` condition of the dialogue (the «everyone of this race» choice). */
  race?: string;
  /** Existing dialogue to put into the package; without it a new one is made from `name` and `lines`. */
  dialog?: string;
  name?: string;
  /** Lines one after another: each next line follows the previous one. */
  lines?: readonly EventLine[];
  /** More conditions of a new dialogue (DC_ conditions, world states, factions, …). */
  when?: readonly DialogWhen[];
  /** `repetition limit` of a new dialogue (DialogRepetitionEnum, default 0 — no limit). */
  rep?: number;
  /**
   * `score bonus` of a new dialogue. Absent — chosen by {@link eventDialogueScore}: enough to be
   * picked first when its conditions hold (or to share the draw with the best rival without them).
   */
  scoreBonus?: number;
  /** No replies of the target (default: every event except talk). */
  monologue?: boolean;
  /** Name of a new package (default: «<holder> dialogues»). */
  packageName?: string;
}

export interface EventDialogueResult {
  dialog: string;
  pkg: string;
  /** New lines, first to last (empty when an existing dialogue was attached). */
  lines: string[];
  /** The package was made by this call. */
  createdPkg: boolean;
  /** Scores against the other dialogues on the event, as weighed before the change. */
  score: EventDialogueScore;
}

function typeOf(ctx: ModContext, sid: string): string | undefined {
  const h = ctx.headline(sid);
  return h && ctx.status(sid) !== 'deleted' ? itemTypeName(h.type) : undefined;
}

/** Distinct holders of a package. */
export function packageHolderCount(ctx: ModContext, pkg: string): number {
  return new Set(packageHolders(ctx, pkg).map((h) => h.sid)).size;
}

/** Package fields of a record type (CHARACTER: `dialogue package`, `dialogue package player`, …). */
export function holderFields(type: string): readonly string[] {
  return PACKAGE_HOLDER_FIELDS[type] ?? [];
}

/** Where `who` puts the dialogue: an existing package or a new one. */
export function eventDialogueTarget(ctx: ModContext, who: EventDialogueWho): EventDialogueTarget {
  if (who.kind === 'package') return { pkg: who.pkg, sharedBy: packageHolderCount(ctx, who.pkg), existing: [] };
  const existing = (ctx.get(who.sid)?.refs.get(who.field) ?? []).map((r) => r.target).filter((s) => typeOf(ctx, s) === PACKAGE);
  if (who.own === true || existing.length === 0) return { sharedBy: 0, existing };
  const pkg = who.pkg !== undefined && existing.includes(who.pkg) ? who.pkg : existing[0]!;
  return { pkg, sharedBy: packageHolderCount(ctx, pkg), existing };
}

/** `base`, or `base 2`, `base 3`, … — the first name no live record of the type has. */
export function freeRecordName(ctx: ModContext, typeName: string, base: string): string {
  const type = ctx.typeId(typeName);
  const taken = new Set<string>();
  for (const sid of ctx.allStringIds()) {
    const h = ctx.headline(sid);
    if (h && h.type === type && ctx.status(sid) !== 'deleted') taken.add(decodeText(h.name).trim().toLowerCase());
  }
  const clean = base.trim();
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let n = 2; ; n++) if (!taken.has(`${clean} ${n}`.toLowerCase())) return `${clean} ${n}`;
}

/** Default dialogue name: «<holder> acid rain» from the holder name and the event code. */
export function eventDialogueBaseName(holderName: string, eventCode: string | undefined, event: number): string {
  const what = eventCode !== undefined ? eventCode.replace(/^EV_/, '').replace(/_/g, ' ').toLowerCase() : `event ${event}`;
  return `${holderName.trim()} ${what}`.trim();
}

/** Why the spec cannot be created (undefined — it can). */
export function eventDialogueProblem(ctx: ModContext, spec: EventDialogueSpec): UiText | undefined {
  if (!Number.isInteger(spec.event) || spec.event < 0 || PACKAGE_EVENT_SKIP.includes(spec.event))
    return { en: 'Choose an event', ru: 'Выберите событие', zh: '请选择事件' };
  const who = spec.who;
  if (who.kind === 'package') {
    if (typeOf(ctx, who.pkg) !== PACKAGE) return { en: 'Choose a dialogue package', ru: 'Выберите пакет диалогов', zh: '请选择对话包' };
  } else {
    const type = typeOf(ctx, who.sid);
    if (type === undefined) return { en: 'Choose who says it', ru: 'Выберите, у кого', zh: '请选择由谁说' };
    if (!holderFields(type).includes(who.field))
      return { en: `${type} has no package field «${who.field}»`, ru: `У ${type} нет поля пакета «${who.field}»`, zh: `${type} 没有对话包字段「${who.field}」` };
  }
  if (spec.race !== undefined && typeOf(ctx, spec.race) !== 'RACE') return { en: 'Choose a race', ru: 'Выберите расу', zh: '请选择种族' };
  if (spec.dialog !== undefined) {
    if (typeOf(ctx, spec.dialog) !== DIALOGUE) return { en: `${spec.dialog} is not a dialogue`, ru: `${spec.dialog} — не диалог`, zh: `${spec.dialog} 不是对话` };
    return undefined;
  }
  if ((spec.name ?? '').trim() === '') return { en: 'Give the dialogue a name', ru: 'Дайте диалогу имя', zh: '请为对话命名' };
  const lines = spec.lines ?? [];
  if (lines.length === 0) return { en: 'Add a line', ru: 'Добавьте реплику', zh: '请添加台词' };
  const empty = lines.findIndex((l) => !l.texts.some((t) => t.trim() !== ''));
  if (empty >= 0) return { en: `Line ${empty + 1} has no text`, ru: `У реплики ${empty + 1} нет текста`, zh: `台词 ${empty + 1} 没有文本` };
  return undefined;
}

/** History label (parsed by `step-title.ts`). */
export function eventDialogueLabel(name: string, pkg: string, event: number, attach: boolean): string {
  return attach ? `в пакет: «${name}» → ${pkg} (событие ${event})` : `диалог на событие: «${name}» → ${pkg} (событие ${event})`;
}

const ref = (target: string, v0 = 0): Reference => ({ target, v0, v1: 0, v2: 0 });

/** Another dialogue the game weighs on the same event for the same speaker. */
export interface EventDialogueRival {
  dialog: string;
  /** Package the reference is in (the target package or one it inherits from). */
  pkg: string;
  /** Sort key: score + max(0, best root line score) (`dialogSortKey`). */
  key: number;
  /** Locked dialogues stay out until a line unlocks them: they are listed but not compared. */
  locked: boolean;
}

/**
 * - `alone`: no other dialogue on the event — it plays whenever the event comes;
 * - `first`: the game tries it first (when its conditions hold);
 * - `tie`: equal key with the best rival — the game picks one of them at random;
 * - `shadowed`: a rival has a higher key and always comes first — this one plays only when the
 *   rival's own conditions fail.
 */
export type EventDialogueOutcome = 'alone' | 'first' | 'tie' | 'shadowed';

/** What the scores will be: the rivals on the event, the bonus and the outcome. */
export interface EventDialogueScore {
  /** Rivals, highest key first. */
  rivals: EventDialogueRival[];
  /** Highest key among the rivals that are not locked (undefined — none). */
  best?: number;
  /** The best rival (the one `best` belongs to). */
  bestDialog?: string;
  /** Key of the dialogue without its bonus. */
  base: number;
  /** The dialogue has conditions (`my race` and the rest; `repetition limit` does not count). */
  conditional: boolean;
  /** The bonus the rule would choose (0 for an existing dialogue: its record is not changed). */
  autoBonus: number;
  /** The bonus that will be written (`spec.scoreBonus` or `autoBonus`); for an attached dialogue — its own. */
  bonus: number;
  /** Key with the bonus. */
  key: number;
  outcome: EventDialogueOutcome;
  /** Outcome with bonus 0 (for «without the bonus it would be …»). */
  outcomeWithout: EventDialogueOutcome;
}

/** Reference categories of `when` items, as `DialogBuilder.whenRefs` writes them (counts only). */
function whenCounts(when: readonly DialogWhen[]): { cats: Map<string, number>; conds: number; tags: number } {
  const cats = new Map<string, number>();
  const bump = (c: string, n = 1): void => void cats.set(c, (cats.get(c) ?? 0) + n);
  let conds = 0;
  let tags = 0;
  for (const w of when) {
    if ('cond' in w) {
      conds++;
      if (w.cond === DC_HAS_TAG) tags++;
    } else if ('ws' in w) bump('world state');
    else if ('inTown' in w) bump('in town of');
    else if ('targetRace' in w) bump('target race', w.targetRace.length);
    else if ('noTargetRace' in w) bump('no target race', w.noTargetRace.length);
    else if ('myFaction' in w) bump('my faction', w.myFaction.length);
    else if ('myRace' in w) bump('my race', w.myRace.length);
    else bump('is character', w.isChar.length);
  }
  return { cats, conds, tags };
}

/** Sort key of the dialogue `spec` would make, with bonus 0 (no records are created). */
function newDialogueBaseKey(ctx: ModContext, spec: EventDialogueSpec): number {
  const { cats, conds, tags } = whenCounts([...(spec.race !== undefined ? [{ myRace: [spec.race] }] : []), ...(spec.when ?? [])]);
  const dlg = emptyRecord(itemTypeId(DIALOGUE)!, '');
  for (const [c, n] of cats) dlg.refs.set(c, Array.from({ length: n }, () => ref('')));
  // `conditions` targets do not exist yet: count them here, and DC_HAS_TAG gives one more.
  const own = dialogueScore(ctx, dlg).total + conds + tags;
  const first = spec.lines?.[0];
  if (first === undefined) return own;
  const line: GameRecord = emptyRecord(itemTypeId('DIALOGUE_LINE')!, '');
  line.ints.set('speaker', first.speaker === SPEAKER.TARGET ? SPEAKER.TARGET : SPEAKER.ME);
  return own + Math.max(0, dialogueScore(ctx, line).total);
}

function outcomeOf(key: number, best: number | undefined): EventDialogueOutcome {
  if (best === undefined) return 'alone';
  return key > best ? 'first' : key === best ? 'tie' : 'shadowed';
}

/**
 * The scores of the new (or attached) dialogue against the other dialogues on the same event in the
 * package (with the packages it inherits from; for a new package — the other packages of the field).
 *
 * The bonus rule: a dialogue with conditions gets just enough `score bonus` to be tried before every
 * rival, so it plays whenever its conditions hold and the old dialogues play otherwise — e.g. «my race»
 * gives no score, and without a bonus a race line would share the draw 50/50 with the general one.
 * A dialogue without conditions gets just enough to share the draw with the best rival: it is heard
 * sometimes and does not silence the old ones. The game picks among equal keys at random.
 */
export function eventDialogueScore(ctx: ModContext, spec: EventDialogueSpec): EventDialogueScore {
  const target = eventDialogueTarget(ctx, spec.who);
  const pkgs = target.pkg !== undefined ? [target.pkg] : target.existing;
  const seen = new Set<string>();
  const rivals: EventDialogueRival[] = [];
  for (const p of pkgs)
    for (const d of packageDialogs(ctx, p)) {
      if (d.event !== spec.event || d.dialog === spec.dialog || seen.has(d.dialog) || !ctx.get(d.dialog)) continue;
      seen.add(d.dialog);
      rivals.push({ dialog: d.dialog, pkg: d.pkg, key: dialogSortKey(ctx, d.dialog), locked: ctx.get(d.dialog)!.bools.get('locked') === true });
    }
  rivals.sort((a, b) => b.key - a.key);
  const top = rivals.find((r) => !r.locked);
  const best = top?.key;
  const attached = spec.dialog !== undefined ? ctx.get(spec.dialog) : undefined;
  let base: number;
  let conditional: boolean;
  let own: number | undefined;
  if (attached) {
    own = attached.ints.get('score bonus') ?? 0;
    base = dialogSortKey(ctx, spec.dialog!) - own;
    conditional = spec.race !== undefined || hasRealConditions(attached);
  } else {
    base = newDialogueBaseKey(ctx, spec);
    conditional = spec.race !== undefined || (spec.when?.length ?? 0) > 0;
  }
  const autoBonus = attached || best === undefined ? 0 : Math.max(0, best - base + (conditional ? 1 : 0));
  const bonus = own ?? spec.scoreBonus ?? autoBonus;
  const key = base + bonus;
  const r: EventDialogueScore = { rivals, base, conditional, autoBonus, bonus, key, outcome: outcomeOf(key, best), outcomeWithout: outcomeOf(base, best) };
  if (top) {
    r.best = top.key;
    r.bestDialog = top.dialog;
  }
  return r;
}

/** Condition references of a record, without `repetition limit` and `target is type`. */
function hasRealConditions(rec: GameRecord): boolean {
  return DIALOGUE_CONDITION_CATEGORIES.some((c) => (rec.refs.get(c)?.length ?? 0) > 0);
}

/** Create (or attach) the dialogue as `spec` says, in one history step. */
export function createEventDialogue(ctx: ModContext, spec: EventDialogueSpec): EventDialogueResult {
  const problem = eventDialogueProblem(ctx, spec);
  if (problem) throw new EditError(problem);
  const target = eventDialogueTarget(ctx, spec.who);
  const attach = spec.dialog !== undefined;
  const name = attach ? decodeText(ctx.get(spec.dialog!)!.name) : spec.name!.trim();
  const labelPkg = target.pkg ?? (spec.who.kind === 'holder' ? spec.who.sid : '');
  // Scores are weighed before the change: the rivals are the dialogues already on the event.
  const score = eventDialogueScore(ctx, spec);
  return ctx.transaction(eventDialogueLabel(name, labelPkg, spec.event, attach), () => {
    let pkg = target.pkg;
    let createdPkg = false;
    if (pkg === undefined) {
      const who = spec.who as Extract<EventDialogueWho, { kind: 'holder' }>;
      const holderName = decodeText(ctx.get(who.sid)!.name);
      pkg = ctx.createRecord(ctx.typeId(PACKAGE)!, freeRecordName(ctx, PACKAGE, spec.packageName?.trim() || `${holderName} dialogues`));
      createdPkg = true;
      const made = pkg;
      ctx.editRecord(who.sid, (d) => {
        d.refs.set(who.field, [...(d.refs.get(who.field) ?? []), ref(made)]);
      });
    }
    let dialog = spec.dialog;
    const lines: string[] = [];
    if (dialog === undefined) {
      const b = new DialogBuilder(ctx);
      const dlgName = freeRecordName(ctx, DIALOGUE, name);
      // The last line first: each line lists the next one in `lines`.
      const specLines = spec.lines!;
      let next: string | undefined;
      for (let i = specLines.length - 1; i >= 0; i--) {
        const l = specLines[i]!;
        const texts = l.texts.map((t) => t.trim()).filter((t) => t !== '');
        next = b.line(freeRecordName(ctx, 'DIALOGUE_LINE', `${dlgName} ${i + 1}`), l.speaker === SPEAKER.TARGET ? SPEAKER.TARGET : SPEAKER.ME, texts, next !== undefined ? { children: [next] } : {});
        lines.unshift(next);
      }
      const when: DialogWhen[] = [...(spec.race !== undefined ? [{ myRace: [spec.race] }] : []), ...(spec.when ?? [])];
      dialog = b.dialogue(dlgName, [lines[0]!], when, { monologue: spec.monologue ?? spec.event !== EVENT_TALK, score: score.bonus, rep: spec.rep ?? 0 });
    } else if (spec.race !== undefined) {
      const race = spec.race;
      ctx.editRecord(dialog, (d) => {
        const list = d.refs.get('my race') ?? [];
        if (!list.some((r) => r.target === race)) d.refs.set('my race', [...list, ref(race)]);
      });
    }
    addDialogToPackage(ctx, pkg, dialog, spec.event);
    return { dialog, pkg, lines, createdPkg, score };
  });
}
