/**
 * .NET regular expressions on a JavaScript engine.
 *
 * FCS Extended patches def files with pairs "regex line, replacement line" and runs them through
 * `new Regex(line)` / `Regex.Replace` (default options). The same patch files have to give the
 * same text in Cactus, so a pattern is translated to a JS `RegExp` (flags `g`, optionally `i`;
 * never `u`, `m` or `s`) and the replacement string is interpreted here, not by `String.replace`.
 *
 * Differences that are translated:
 * - `.` matches everything except `\n` in .NET (it does match `\r`); JS also excludes `\r`,
 *   U+2028 and U+2029. Emitted as `[^\n]` (or `[\s\S]` under the `s` option).
 * - `$` without the `m` option matches at the very end and before a final `\n`; JS matches only
 *   at the very end. Emitted as `(?=\n?$)`. Under `m` both `^` and `$` look only at `\n`.
 * - `\A`, `\Z`, `\z` (start, end or before final newline, very end) do not exist in JS.
 * - `(?'name'…)` and `\k'name'` are the same as `(?<name>…)` and `\k<name>`.
 * - `(?#comment)` is removed; `\a` and `\e` become `\x07` and `\x1B`; `\0dd` (octal) becomes `\xHH`.
 * - `[]abc]`: a `]` right after the opening bracket is a literal in .NET, an empty class in JS.
 * - Inline options at the very start of the pattern: `(?i)`, `(?s)`, `(?m)` and their
 *   combinations. JS has no such prefix, so it is cut off and turned into flags.
 * - Group numbers: .NET numbers unnamed groups first and named groups after them; JS numbers all
 *   of them left to right. `\1` in the pattern and `$1` in the replacement are remapped.
 * - Replacement: `$1`, `${1}`, `${name}`, `$$`, `$&`, `` $` ``, `$'`, `$+`, `$_`. A number that
 *   is not a group stays as written (`$5` with two groups is the text `$5`). JS reads `$10` and
 *   `$<name>` differently, which is why the replacement is not passed to `String.replace`.
 *
 * Not translated — `compileDotnetRegex` reports them as unsupported and the patch is skipped:
 * atomic groups `(?>…)`, balancing groups `(?<a-b>…)`, conditionals `(?(…)…)`, `\G`, `\p{…}` and
 * `\P{…}`, character class subtraction `[a-z-[aeiou]]`, the options `x` and `n`, options in the
 * middle of a pattern or scoped to a group `(?i:…)`, groups with numeric names.
 *
 * Known and accepted: `\w`, `\d`, `\s` and case-insensitive matching follow Unicode rules in .NET
 * and narrower rules in JS. Def files are ASCII (FCS Extended even writes the patched text back
 * as ASCII), so the result is the same.
 */

type Piece = string | { ref: number } | { refName: string };

type ReplacementToken =
  | { kind: 'text'; text: string }
  | { kind: 'group'; index: number }
  | { kind: 'match' | 'before' | 'after' | 'input' | 'last' };

export interface DotnetRegex {
  /** The translated JS pattern (for messages and tests). */
  readonly source: string;
  readonly flags: string;
  /** `Regex.Replace(input, replacement)`: every match is replaced. */
  replace(input: string, replacement: string): string;
}

export type DotnetRegexResult = { ok: true; regex: DotnetRegex } | { ok: false; reason: string };

class Unsupported extends Error {}

const SIMPLE_ESCAPES = new Set('tnrfvdDwWsSbB');

interface Translation {
  source: string;
  flags: string;
  /** JS group index for a .NET group number (index 0 is the whole match). */
  byNumber: number[];
  /** JS group index for a group name. */
  byName: Map<string, number>;
}

function translate(pattern: string): Translation {
  let ignoreCase = false;
  let singleline = false;
  let multiline = false;
  let pos = 0;

  // Leading inline options: (?i), (?s-m), several in a row.
  for (;;) {
    const m = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?\)/.exec(pattern.slice(pos));
    if (!m || (m[1] === '' && m[2] === undefined)) break;
    for (const [letters, on] of [
      [m[1]!, true],
      [m[2] ?? '', false],
    ] as const) {
      for (const ch of letters) {
        if (ch === 'i') ignoreCase = on;
        else if (ch === 's') singleline = on;
        else if (ch === 'm') multiline = on;
        else throw new Unsupported(`inline option "${ch}" is not supported`);
      }
    }
    pos += m[0].length;
  }

  const pieces: Piece[] = [];
  // Capturing groups in JS order (left to right); the name is set for named groups.
  const groups: (string | undefined)[] = [];
  const endOfInput = '(?=\\n?$)';

  const readName = (close: string): string => {
    const end = pattern.indexOf(close, pos);
    if (end < 0) throw new Unsupported('unterminated group name');
    const name = pattern.slice(pos, end);
    pos = end + 1;
    return name;
  };

  const escape = (inClass: boolean): void => {
    // `pos` is at the character after the backslash.
    const ch = pattern[pos];
    if (ch === undefined) throw new Unsupported('pattern ends with a backslash');
    pos++;
    if (ch === 'a') pieces.push('\\x07');
    else if (ch === 'e') pieces.push('\\x1B');
    else if (ch === 'p' || ch === 'P') throw new Unsupported(`Unicode category \\${ch}{…} is not supported`);
    else if (ch === 'x' || ch === 'u') {
      const len = ch === 'x' ? 2 : 4;
      const hex = pattern.slice(pos, pos + len);
      if (!new RegExp(`^[0-9a-fA-F]{${String(len)}}$`).test(hex)) throw new Unsupported(`bad \\${ch} escape`);
      pos += len;
      pieces.push(`\\${ch}${hex}`);
    } else if (ch === 'c') {
      const letter = pattern[pos];
      if (letter === undefined || !/[A-Za-z]/.test(letter)) throw new Unsupported('bad \\c escape');
      pos++;
      pieces.push(`\\c${letter}`);
    } else if (ch === '0') {
      const oct = /^[0-7]{0,2}/.exec(pattern.slice(pos))![0];
      pos += oct.length;
      pieces.push(`\\x${parseInt(`0${oct}`, 8).toString(16).padStart(2, '0')}`);
    } else if (/[1-9]/.test(ch)) {
      if (inClass) throw new Unsupported('octal escape inside a character class is not supported');
      const digits = ch + /^\d*/.exec(pattern.slice(pos))![0];
      pos += digits.length - 1;
      pieces.push({ ref: Number(digits) });
    } else if (inClass) {
      if (SIMPLE_ESCAPES.has(ch) || !/[A-Za-z0-9]/.test(ch)) pieces.push(`\\${ch}`);
      else throw new Unsupported(`unknown escape \\${ch}`);
    } else if (ch === 'A') pieces.push('^');
    else if (ch === 'Z') pieces.push(endOfInput);
    else if (ch === 'z') pieces.push('$');
    else if (ch === 'G') throw new Unsupported('\\G is not supported');
    else if (ch === 'k') {
      const open = pattern[pos];
      if (open !== '<' && open !== "'") throw new Unsupported('bad \\k reference');
      pos++;
      const name = readName(open === '<' ? '>' : "'");
      pieces.push(/^\d+$/.test(name) ? { ref: Number(name) } : { refName: name });
    } else if (SIMPLE_ESCAPES.has(ch) || !/[A-Za-z0-9]/.test(ch)) pieces.push(`\\${ch}`);
    else throw new Unsupported(`unknown escape \\${ch}`);
  };

  const charClass = (): void => {
    // `pos` is at the character after `[`.
    let out = '[';
    if (pattern[pos] === '^') {
      out += '^';
      pos++;
    }
    if (pattern[pos] === ']') {
      out += '\\]';
      pos++;
    }
    pieces.push(out);
    for (;;) {
      const ch = pattern[pos];
      if (ch === undefined) throw new Unsupported('unterminated character class');
      pos++;
      if (ch === ']') {
        pieces.push(']');
        return;
      }
      if (ch === '\\') escape(true);
      else if (ch === '-' && pattern[pos] === '[') throw new Unsupported('character class subtraction is not supported');
      else pieces.push(ch);
    }
  };

  const group = (): void => {
    // `pos` is at the character after `(`.
    if (pattern[pos] !== '?') {
      groups.push(undefined);
      pieces.push('(');
      return;
    }
    const next = pattern[pos + 1];
    const two = pattern.slice(pos, pos + 3);
    if (next === ':' || next === '=' || next === '!') {
      pieces.push(`(?${next}`);
      pos += 2;
    } else if (two === '?<=' || two === '?<!') {
      pieces.push(`(${two}`);
      pos += 3;
    } else if (next === '<' || next === "'") {
      pos += 2;
      const name = readName(next === '<' ? '>' : "'");
      if (name.includes('-')) throw new Unsupported('balancing groups are not supported');
      if (!/^[A-Za-z_]\w*$/.test(name)) throw new Unsupported(`group name "${name}" is not supported`);
      if (groups.includes(name)) throw new Unsupported(`group name "${name}" is used twice`);
      groups.push(name);
      pieces.push(`(?<${name}>`);
    } else if (next === '#') {
      const end = pattern.indexOf(')', pos);
      if (end < 0) throw new Unsupported('unterminated (?# comment');
      pos = end + 1;
    } else if (next === '>') throw new Unsupported('atomic groups (?>…) are not supported');
    else if (next === '(') throw new Unsupported('conditional groups (?(…)…) are not supported');
    else throw new Unsupported('inline options are supported only at the start of the pattern');
  };

  while (pos < pattern.length) {
    const ch = pattern[pos]!;
    pos++;
    if (ch === '\\') escape(false);
    else if (ch === '[') charClass();
    else if (ch === '(') group();
    else if (ch === '.') pieces.push(singleline ? '[\\s\\S]' : '[^\\n]');
    else if (ch === '^') pieces.push(multiline ? '(?<![^\\n])' : '^');
    else if (ch === '$') pieces.push(multiline ? '(?![^\\n])' : endOfInput);
    else pieces.push(ch);
  }

  // .NET numbering: unnamed groups left to right, then named groups left to right.
  const byNumber: number[] = [0];
  const byName = new Map<string, number>();
  groups.forEach((name, i) => {
    if (name === undefined) byNumber.push(i + 1);
  });
  groups.forEach((name, i) => {
    if (name !== undefined) {
      byNumber.push(i + 1);
      byName.set(name, i + 1);
    }
  });

  let source = '';
  for (const p of pieces) {
    if (typeof p === 'string') source += p;
    else if ('ref' in p) {
      const js = p.ref === 0 ? undefined : byNumber[p.ref];
      if (js === undefined) throw new Unsupported(`reference to undefined group ${String(p.ref)}`);
      // The non-capturing wrapper keeps a following digit from joining the reference.
      source += `(?:\\${String(js)})`;
    } else {
      if (!byName.has(p.refName)) throw new Unsupported(`reference to undefined group "${p.refName}"`);
      source += `\\k<${p.refName}>`;
    }
  }
  return { source, flags: ignoreCase ? 'gi' : 'g', byNumber, byName };
}

function parseReplacement(replacement: string, t: Translation): ReplacementToken[] {
  const tokens: ReplacementToken[] = [];
  let text = '';
  const flush = (): void => {
    if (text !== '') tokens.push({ kind: 'text', text });
    text = '';
  };
  const groupToken = (js: number): void => {
    flush();
    tokens.push(js === 0 ? { kind: 'match' } : { kind: 'group', index: js });
  };
  let i = 0;
  while (i < replacement.length) {
    const ch = replacement[i]!;
    if (ch !== '$' || i + 1 >= replacement.length) {
      text += ch;
      i++;
      continue;
    }
    const next = replacement[i + 1]!;
    const special = { '&': 'match', '`': 'before', "'": 'after', _: 'input', '+': 'last' }[next] as
      | 'match'
      | 'before'
      | 'after'
      | 'input'
      | 'last'
      | undefined;
    if (next === '$') {
      text += '$';
      i += 2;
    } else if (special) {
      flush();
      tokens.push({ kind: special });
      i += 2;
    } else if (/\d/.test(next)) {
      const digits = /^\d+/.exec(replacement.slice(i + 1))![0];
      const js = t.byNumber[Number(digits)];
      if (js === undefined) text += `$${digits}`;
      else groupToken(js);
      i += 1 + digits.length;
    } else if (next === '{') {
      const end = replacement.indexOf('}', i + 2);
      const name = end < 0 ? '' : replacement.slice(i + 2, end);
      const js = /^\d+$/.test(name) ? t.byNumber[Number(name)] : t.byName.get(name);
      if (end < 0 || js === undefined) {
        text += '$';
        i++;
      } else {
        groupToken(js);
        i = end + 1;
      }
    } else {
      text += '$';
      i++;
    }
  }
  flush();
  return tokens;
}

/**
 * Translate a .NET pattern. Never throws: a pattern that cannot be translated (or is not a valid
 * regular expression at all) gives `{ ok: false, reason }`.
 */
export function compileDotnetRegex(pattern: string): DotnetRegexResult {
  let t: Translation;
  let re: RegExp;
  try {
    t = translate(pattern);
    re = new RegExp(t.source, t.flags);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const groupCount = t.byNumber.length - 1;
  const lastGroup = t.byNumber[groupCount] ?? 0;
  return {
    ok: true,
    regex: {
      source: t.source,
      flags: t.flags,
      replace(input, replacement) {
        const tokens = parseReplacement(replacement, t);
        re.lastIndex = 0;
        return input.replace(re, (...args: unknown[]) => {
          const match = args[0] as string;
          const offset = args[groupCount + 1] as number;
          let out = '';
          for (const tok of tokens) {
            if (tok.kind === 'text') out += tok.text;
            else if (tok.kind === 'group') out += (args[tok.index] as string | undefined) ?? '';
            else if (tok.kind === 'match') out += match;
            else if (tok.kind === 'before') out += input.slice(0, offset);
            else if (tok.kind === 'after') out += input.slice(offset + match.length);
            else if (tok.kind === 'input') out += input;
            else out += lastGroup === 0 ? match : ((args[lastGroup] as string | undefined) ?? '');
          }
          return out;
        });
      },
    },
  };
}
