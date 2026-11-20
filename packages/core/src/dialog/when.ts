/**
 * When a dialogue is spoken: which events start it and who has it. The moment is not stored in
 * DIALOGUE or DIALOGUE_LINE — it is the number in the `dialogs` reference of a DIALOGUE_PACKAGE
 * (v0..v2, `packageRefEvents`), and the package hangs on a character, a squad or a faction, or is
 * inherited by another package (`inheritsFrom`). `CHARACTER.dialogue` is the talk event itself.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { ModContext } from '../model/context.ts';
import { packageRefEvents } from '../model/enums.ts';
import { EVENT_TALK } from './talk.ts';

/** Fields of other records that hold a dialogue package, by record type. */
export const PACKAGE_HOLDER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  CHARACTER: ['dialogue package', 'dialogue package player'],
  SQUAD_TEMPLATE: ['dialog leader', 'dialog squad'],
  FACTION: ['dialog default'],
};

/** Fields of CHARACTER that reference a dialogue directly. */
export const CHARACTER_DIALOGUE_FIELDS: readonly string[] = ['dialogue', 'announcement dialogue'];

/**
 * Records that start a dialogue themselves, not through a package (fcs.def): type → fields. The fields
 * in `TALK_START_FIELDS` are the talk dialogue of who has them; the others start it on their own moment
 * (an announcement, entering the biome, the end of an AI contract).
 */
export const DIALOGUE_STARTER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  CHARACTER: CHARACTER_DIALOGUE_FIELDS,
  SINGLE_DIPLOMATIC_ASSAULT: ['dialogue', 'dialogue squad', 'dialogue announce'],
  BIOME_GROUP: ['arrival dialog'],
  FACTION_CAMPAIGN: ['dialog announcement'],
  AI_PACKAGE: ['contract end talk passive'],
};

/** Starter fields whose dialogue is the talk dialogue (the «talk» event). */
const TALK_START_FIELDS: Readonly<Record<string, readonly string[]>> = {
  CHARACTER: ['dialogue'],
  SINGLE_DIPLOMATIC_ASSAULT: ['dialogue', 'dialogue squad'],
};

export interface WhenHolder {
  /** Character, squad or faction. */
  sid: string;
  type: string;
  /** Its field that holds the package (or the dialogue). */
  field: string;
  /** Package that inherits the holding package and is the one held, if not the holding package itself. */
  through?: string;
}

export interface WhenSource {
  /** Events that start the dialogue (EventTriggerEnum values); empty for `announcement dialogue`. */
  events: number[];
  /** The package with the `dialogs` reference; absent for a direct CHARACTER reference. */
  pkg?: string;
  /** Who has the package (or the dialogue); empty — the package hangs on nobody. */
  holders: WhenHolder[];
  /**
   * For a source without a package and without events: the `TYPE.field` that starts the dialogue
   * (`CHARACTER.announcement dialogue`, `BIOME_GROUP.arrival dialog`…).
   */
  start?: string;
}

const MAX_HOLDERS = 200;

/** Holders of a package, also through packages that inherit it. */
export function packageHolders(ctx: ModContext, pkg: string): WhenHolder[] {
  const out: WhenHolder[] = [];
  const seen = new Set<string>();
  const walk = (p: string, through: string | undefined): void => {
    if (seen.has(p) || out.length >= MAX_HOLDERS) return;
    seen.add(p);
    const heirs: string[] = [];
    for (const e of ctx.referencesTo(p)) {
      const src = ctx.get(e.source);
      if (!src) continue;
      const type = itemTypeName(src.type);
      if (type === 'DIALOGUE_PACKAGE' && e.category === 'inheritsFrom') {
        heirs.push(e.source);
        continue;
      }
      if (!PACKAGE_HOLDER_FIELDS[type]?.includes(e.category)) continue;
      const h: WhenHolder = { sid: e.source, type, field: e.category };
      if (through !== undefined) h.through = through;
      if (!out.some((x) => x.sid === h.sid && x.field === h.field)) out.push(h);
    }
    // Direct holders first, then those that get the package through an heir.
    for (const heir of heirs) walk(heir, heir);
  };
  walk(pkg, undefined);
  return out;
}

/** When the dialogue is spoken: one source per package reference or direct character reference. */
export function dialogueWhen(ctx: ModContext, dialog: string): WhenSource[] {
  const out: WhenSource[] = [];
  const direct = new Map<string, WhenHolder[]>();
  for (const e of ctx.referencesTo(dialog)) {
    const src = ctx.get(e.source);
    if (!src) continue;
    const type = itemTypeName(src.type);
    if (type === 'DIALOGUE_PACKAGE' && e.category === 'dialogs') {
      const events = (src.refs.get('dialogs') ?? []).filter((r) => r.target === dialog).flatMap((r) => packageRefEvents(r));
      const prev = out.find((s) => s.pkg === e.source);
      if (prev) {
        for (const ev of events) if (!prev.events.includes(ev)) prev.events.push(ev);
        continue;
      }
      out.push({ events: [...new Set(events)], pkg: e.source, holders: packageHolders(ctx, e.source) });
    } else if (DIALOGUE_STARTER_FIELDS[type]?.includes(e.category)) {
      const key = `${type}.${e.category}`;
      const list = direct.get(key) ?? [];
      if (!list.some((h) => h.sid === e.source)) list.push({ sid: e.source, type, field: e.category });
      direct.set(key, list);
    }
  }
  for (const [key, holders] of direct) {
    const { type, field } = holders[0]!;
    if (TALK_START_FIELDS[type]?.includes(field)) out.push({ events: [EVENT_TALK], holders });
    else out.push({ events: [], holders, start: key });
  }
  return out;
}

/** Dialogues (DIALOGUE) a line belongs to, walking up through `lines` of parent lines. */
export function lineDialogues(ctx: ModContext, line: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [line];
  while (queue.length > 0 && seen.size < 2000) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of ctx.referencesTo(cur)) {
      if (e.category !== 'lines') continue;
      const src = ctx.get(e.source);
      if (!src) continue;
      const type = itemTypeName(src.type);
      if (type === 'DIALOGUE') {
        if (!out.includes(e.source)) out.push(e.source);
      } else if (type === 'DIALOGUE_LINE') queue.push(e.source);
    }
  }
  return out;
}
