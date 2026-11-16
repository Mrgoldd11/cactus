import { UiTextError } from '../ui-text.ts';
/**
 * Порядок загрузки модов (`data/mods.cfg`) без файловой системы: разбор, перестановка,
 * включение и выключение. Строка ниже — слой позже — её значения побеждают.
 *
 * Текст пишется обратно с тем же концом строки, что был (по умолчанию CRLF, как у лаунчера).
 */

export interface ModsCfgText {
  /** Имена файлов модов по порядку (пустые строки убраны). */
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

/** Куда поставить мод: в начало (раньше всех, проигрывает), в конец (побеждает), после или перед другим. */
export type ModPlace = { top: true } | { bottom: true } | { after: string } | { before: string } | { index: number };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Номер мода в списке без учёта регистра; -1 — нет. */
export function modIndex(names: readonly string[], name: string): number {
  return names.findIndex((n) => same(n, name));
}

/**
 * Поставить мод на место. Если мода в списке нет — он добавляется (то есть включается).
 * Ссылка `after`/`before` на мод, которого нет в списке, — ошибка.
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

/** Убрать мод из списка (выключить). */
export function removeMod(names: readonly string[], name: string): string[] {
  return names.filter((n) => !same(n, name));
}

/** Включить (в конец, если места не задано) или выключить мод. */
export function setModEnabled(names: readonly string[], name: string, enabled: boolean, place: ModPlace = { bottom: true }): string[] {
  if (!enabled) return removeMod(names, name);
  return modIndex(names, name) >= 0 ? [...names] : placeMod(names, name, place);
}

/** Изменение порядка загрузки: переставить, включить (поставить в список), выключить. */
export type ModsCfgChange =
  | { op: 'move'; name: string; place: ModPlace }
  | { op: 'enable'; name: string; place?: ModPlace }
  | { op: 'disable'; name: string };

/** Новый список после изменения. Переставить можно только мод из списка. */
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

/** Строки «было → стало» для показа: место каждого мода, у которого оно поменялось. */
export function describeOrderChange(before: readonly string[], after: readonly string[]): string[] {
  const out: string[] = [];
  const low = (a: readonly string[]): string[] => a.map((n) => n.toLowerCase());
  const b = low(before);
  const a = low(after);
  after.forEach((n, i) => {
    const was = b.indexOf(n.toLowerCase());
    if (was < 0) out.push(`+ ${n}: включён, место ${i + 1}`);
    else if (was !== i) out.push(`  ${n}: место ${was + 1} → ${i + 1}`);
  });
  before.forEach((n) => {
    if (!a.includes(n.toLowerCase())) out.push(`- ${n}: выключен`);
  });
  return out;
}
