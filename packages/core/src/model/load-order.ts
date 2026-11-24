import { UiTextError } from '../ui-text.ts';
/**
 * Mod load order (`data/mods.cfg`) without a file system: parsing, reordering,
 * enabling and disabling. A lower line is a later layer; its values win.
 *
 * The text is written back with the same line ending it had (CRLF by default, like the launcher).
 */

export interface ModsCfgText {
  /** Mod file names in order (empty lines removed). */
  names: string[];
  eol: '\r\n' | '\n';
}

export function parseModsCfg(text: string): ModsCfgText {
  const eol = text.includes('\r\n') || !text.includes('\n') ? '\r\n' : '\n';
  const names = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { names, eol };
}

export function formatModsCfg(cfg: ModsCfgText): string {
  return cfg.names.length === 0 ? '' : cfg.names.join(cfg.eol) + cfg.eol;
}

/** Where to put a mod: at the start (before all, loses), at the end (wins), after or before another one. */
export type ModPlace = { top: true } | { bottom: true } | { after: string } | { before: string } | { index: number };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Index of the mod in the list, case-insensitive; -1 if absent. */
export function modIndex(names: readonly string[], name: string): number {
  return names.findIndex((n) => same(n, name));
}

/**
 * Put a mod in place. If the mod is not in the list, it is added (i.e. enabled).
 * An `after`/`before` reference to a mod not in the list is an error.
 */
export function placeMod(names: readonly string[], name: string, place: ModPlace): string[] {
  const i = modIndex(names, name);
  const entry = i >= 0 ? names[i]! : name;
  const rest = names.filter((_, k) => k !== i);
  let at: number;
  if ('top' in place) at = 0;
  else if ('bottom' in place) at = rest.length;
  else if ('index' in place) at = Math.max(0, Math.min(rest.length, place.index));
  else {
    const ref = 'after' in place ? place.after : place.before;
    const j = modIndex(rest, ref);
    if (j < 0) throw new UiTextError({ en: `The mod is not in the load order: ${ref}`, ru: `Мода нет в порядке загрузки: ${ref}`, zh: `Mod 不在加载顺序中：${ref}` });
    at = 'after' in place ? j + 1 : j;
  }
  return [...rest.slice(0, at), entry, ...rest.slice(at)];
}

/** Remove a mod from the list (disable it). */
export function removeMod(names: readonly string[], name: string): string[] {
  return names.filter((n) => !same(n, name));
}

/** Enable (at the end if no place is given) or disable a mod. */
export function setModEnabled(names: readonly string[], name: string, enabled: boolean, place: ModPlace = { bottom: true }): string[] {
  if (!enabled) return removeMod(names, name);
  return modIndex(names, name) >= 0 ? [...names] : placeMod(names, name, place);
}

/** Load order change: move, enable (put into the list), disable. */
export type ModsCfgChange =
  | { op: 'move'; name: string; place: ModPlace }
  | { op: 'enable'; name: string; place?: ModPlace }
  | { op: 'disable'; name: string };

/** The new list after the change. Only a mod from the list can be moved. */
export function applyModsCfgChange(names: readonly string[], change: ModsCfgChange): string[] {
  switch (change.op) {
    case 'move':
      if (modIndex(names, change.name) < 0) throw new UiTextError({ en: `The mod is not in the load order: ${change.name} (enable it first)`, ru: `Мода нет в порядке загрузки: ${change.name} (сначала включите его)`, zh: `Mod 不在加载顺序中：${change.name}（请先启用）` });
      return placeMod(names, change.name, change.place);
    case 'enable':
      return modIndex(names, change.name) >= 0 && change.place === undefined ? [...names] : placeMod(names, change.name, change.place ?? { bottom: true });
    case 'disable':
      return removeMod(names, change.name);
  }
}

/** Words of the load order changes in one interface language. */
interface OrderWords {
  on: (place: number) => string;
  moved: (was: number, now: number) => string;
  off: string;
}

const ORDER_WORDS: Record<string, OrderWords> = {
  en: { on: (p) => `enabled, place ${p}`, moved: (a, b) => `place ${a} → ${b}`, off: 'disabled' },
  ru: { on: (p) => `включён, место ${p}`, moved: (a, b) => `место ${a} → ${b}`, off: 'выключен' },
  zh: { on: (p) => `已启用，位置 ${p}`, moved: (a, b) => `位置 ${a} → ${b}`, off: '已禁用' },
};

/** "Was → now" lines for display: the position of each mod whose position changed. */
export function describeOrderChange(before: readonly string[], after: readonly string[], lang = 'en'): string[] {
  const w = ORDER_WORDS[lang] ?? ORDER_WORDS.en!;
  const out: string[] = [];
  const low = (a: readonly string[]): string[] => a.map((n) => n.toLowerCase());
  const b = low(before);
  const a = low(after);
  after.forEach((n, i) => {
    const was = b.indexOf(n.toLowerCase());
    if (was < 0) out.push(`+ ${n}: ${w.on(i + 1)}`);
    else if (was !== i) out.push(`  ${n}: ${w.moved(was + 1, i + 1)}`);
  });
  before.forEach((n) => {
    if (!a.includes(n.toLowerCase())) out.push(`- ${n}: ${w.off}`);
  });
  return out;
}
