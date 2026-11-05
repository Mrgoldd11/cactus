/**
 * Конструктор диалогов для скриптов сборки (`kedit build`): реплики, диалоги, условия и действия
 * без ручной возни с DIALOG_ACTION и ссылками. Обобщение сборки мода Vanilla Talk.
 *
 *   const b = new DialogBuilder(ctx, env.stableIds());
 *   const hi = b.line('Мой привет', SPEAKER.ME, ['Hello.'], { score: 10 });
 *   const dlg = b.dialogue('Мой разговор', [hi], [{ cond: 7, who: 1, v: 0 }], { score: -100 });
 *   b.attachToCharacter('1234-gamedata.base', dlg);          // клик (событие 1)
 *   b.attachToPackages(['1234-gamedata.base'], dlg, 3);      // событие пакета
 *
 * Ванильные записи меняются только дописыванием ссылок (`dialogue`, `dialogs`). Имена новых записей
 * должны быть уникальны: с таблицей постоянных id (`StableIds`) по имени выдаётся номер.
 */
import { encodeText } from '../text.ts';
import { itemTypeId } from '../format/item-types.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import type { ModContext } from '../model/context.ts';
import type { StableIds } from '../model/stable-ids.ts';
import { characterFactions, squadIndex, type SquadIndex } from './talk.ts';

/** Кто говорит (TalkerEnum). */
export const SPEAKER = { ME: 0, TARGET: 1, TARGET_IF_PLAYER: 2 } as const;

/** Условие реплики или диалога. */
export type DialogWhen =
  /** DIALOG_ACTION-условие: `condition name`, who (0 — говорящий, 1 — собеседник), значение, сравнение 0 = 1 < 2 >, tag. */
  | { cond: number; who: number; v: number; cmp?: number; tag?: number }
  /** Состояние мира (1 — истинно, 0 — ложно). */
  | { ws: string; v: number }
  /** Говорящий сейчас в городе этой фракции. */
  | { inTown: string }
  /** У собеседника есть кто-то из этих рас (ИЛИ). */
  | { targetRace: readonly string[] }
  /** Ни одной из этих рас (И). */
  | { noTargetRace: readonly string[] }
  /** Говорящий в одной из этих фракций. */
  | { myFaction: readonly string[] }
  /** Говорящий — один из этих персонажей. */
  | { isChar: readonly string[] };

export interface LineOptions {
  when?: readonly DialogWhen[];
  children?: readonly string[];
  /** Действие реплики (DialogActionEnum): торговля 1, атака 6, ... */
  action?: number;
  score?: number;
  /** `chance temporary`, % (по умолчанию 100). */
  chance?: number;
}

export interface DialogueOptions {
  score?: number;
  /** `repetition limit` (0 — без ограничения). */
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

/** Куда цеплять события персонажа: свой пакет → пакеты отрядов → пакет фракции по умолчанию. */
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
  /** Персонажи, у которых не нашлось пакета для события. */
  readonly noPackage = new Set<string>();

  constructor(ctx: ModContext, ids?: StableIds) {
    this.ctx = ctx;
    this.ids = ids;
  }

  private type(name: string): number {
    const t = itemTypeId(name);
    if (t === undefined) throw new Error(`нет типа ${name}`);
    return t;
  }

  /** Запись, которая должна быть в нижних слоях или моде. */
  need(sid: string): string {
    if (!this.ctx.get(sid)) throw new Error(`Нет записи ${sid}`);
    return sid;
  }

  /** Новая запись с полями; имя уникально в пределах сборки. */
  create(typeName: string, name: string, f: CreateFields = {}): string {
    if (this.used.has(name)) throw new Error(`Повтор имени записи: ${name}`);
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

  /** Условия → категории ссылок; DIALOG_ACTION-условия создаются с именами `<владелец> ?N`. */
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
      else for (const c of w.isChar) push('is character', ref(this.need(c)));
    });
    return out;
  }

  /** Реплика: тексты — `text0`, `text1`, ... (случайные формулировки). */
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

  /** Диалог с корневыми репликами и условиями. */
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

  /** Дописать дочерние реплики (например, петлю меню после создания всех тем). */
  addChildren(parent: string, children: readonly string[]): void {
    this.ctx.editRecord(this.need(parent), (d) => {
      const list = d.refs.get('lines') ?? [];
      for (const c of children) if (!list.some((x) => x.target === c)) list.push(ref(c));
      d.refs.set('lines', list);
    });
  }

  /** Диалог по клику (событие 1) — в `CHARACTER.dialogue`. */
  attachToCharacter(character: string, dialog: string): void {
    this.ctx.editRecord(this.need(character), (d) => {
      const list = d.refs.get('dialogue') ?? [];
      if (!list.some((x) => x.target === dialog)) list.push(ref(dialog));
      d.refs.set('dialogue', list);
    });
  }

  /**
   * Диалог события — в пакеты, которые слушают эти персонажи (свой пакет: первого хватает, пакеты
   * персонажа складываются; отряды и фракция — все). Возвращает пакеты, куда дописано.
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
    for (const p of pkgs)
      this.ctx.editRecord(p, (d) => {
        const list = d.refs.get('dialogs') ?? [];
        if (!list.some((x) => x.target === dialog && x.v0 === event)) list.push(ref(dialog, event));
        d.refs.set('dialogs', list);
      });
    return [...pkgs];
  }
}
