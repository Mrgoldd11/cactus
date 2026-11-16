/**
 * Keyboard shortcuts on any layout.
 *
 * On the Russian layout Ctrl+Z arrives with `key: 'я'`, so `e.key` cannot be compared with 'z'.
 * The letter is taken like this:
 *  - if `e.key` is a Latin letter, that letter (so AZERTY, Dvorak etc. work correctly);
 *  - otherwise by the physical key `e.code` (`KeyZ` → 'z'): Russian, Greek and other
 *    layouts behave like English QWERTY.
 * Keys without letters (Delete, F2, Enter, Escape, arrows) are compared by `e.key` as is.
 */

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The key's Latin letter ('a'…'z') or undefined if the key is not a letter. */
export function letterOf(e: Pick<KeyLike, 'key' | 'code'>): string | undefined {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code);
  return m ? m[1]!.toLowerCase() : undefined;
}

/**
 * The shortcut as a string: `ctrl+z`, `ctrl+shift+z`, `alt+arrowleft`. Ctrl and Cmd (Mac)
 * count as one `ctrl`. Letter keys — by `letterOf`, the rest — `e.key` in lower case.
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

/** The event target is an input (there Ctrl+Z/Y/C/V edit the text of the field itself). */
export function isTypingIn(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
}
