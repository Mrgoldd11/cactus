/**
 * Сочетания клавиш на любой раскладке.
 *
 * На русской раскладке Ctrl+Z приходит с `key: 'я'`, поэтому сравнивать `e.key` с 'z'
 * нельзя. Буква берётся так:
 *  - если `e.key` — латинская буква, то она (так верно работают AZERTY, Dvorak и т. п.);
 *  - иначе — по физической клавише `e.code` (`KeyZ` → 'z'): русская, греческая и прочие
 *    раскладки ведут себя как английская QWERTY.
 * Клавиши без букв (Delete, F2, Enter, Escape, стрелки) сравниваются по `e.key` как есть.
 */

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Латинская буква клавиши ('a'…'z') или undefined, если клавиша не буквенная. */
export function letterOf(e: Pick<KeyLike, 'key' | 'code'>): string | undefined {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code);
  return m ? m[1]!.toLowerCase() : undefined;
}

/**
 * Сочетание в виде строки: `ctrl+z`, `ctrl+shift+z`, `alt+arrowleft`. Ctrl и Cmd (Mac)
 * считаются одним `ctrl`. Буквенные клавиши — по `letterOf`, остальные — `e.key` строчными.
 */
export function shortcut(e: KeyLike): string {
  const letter = letterOf(e);
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(letter ?? e.key.toLowerCase());
  return parts.join('+');
}

/** Цель события — поле ввода (там Ctrl+Z/Y/C/V — правка текста самого поля). */
export function isTypingIn(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
}
