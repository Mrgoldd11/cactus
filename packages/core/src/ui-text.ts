/**
 * Core texts in the interface languages (step titles, explanations, edit errors). English is
 * required and is the fallback: a new interface language adds its entries where it has them, and
 * everything else shows in English. Language codes are the editor's (`en`, `ru`, `zh`, …).
 */

/** One text in several interface languages. */
export type UiText = { readonly en: string } & { readonly [lang: string]: string | undefined };

/** The text in `lang`, English if there is no entry for it. */
export function uiText(text: UiText, lang = 'en'): string {
  return text[lang] ?? text.en;
}

/** Builds a text in every language from texts in every language: `mapUi([a, b], ([x, y]) => `${x}, ${y}`)`. */
export function mapUi(langs: readonly UiText[], fn: (parts: string[], lang: string) => string): UiText {
  const codes = new Set<string>(['en']);
  for (const t of langs) for (const k of Object.keys(t)) codes.add(k);
  const out: Record<string, string> = {};
  for (const code of codes) out[code] = fn(langs.map((t) => uiText(t, code)), code);
  return out as UiText;
}

/** Error with a message in every interface language; `message` is the English text (logs, MCP). */
export class UiTextError extends Error {
  readonly texts: UiText;

  constructor(text: string | UiText, options?: ErrorOptions) {
    const texts: UiText = typeof text === 'string' ? { en: text } : text;
    super(texts.en, options);
    this.texts = texts;
  }
}

/** Message of an error in the interface language (other errors: their own message). */
export function errorMessage(e: unknown, lang = 'en'): string {
  if (e instanceof UiTextError) return uiText(e.texts, lang);
  return e instanceof Error ? e.message : String(e);
}

/** Quote marks per interface language; other languages use the English ones. */
const QUOTES: Readonly<Record<string, readonly [string, string]>> = { en: ['“', '”'], ru: ['«', '»'], zh: ['“', '”'] };

/** `text` in the quote marks of `lang`: “katana” in English, «катана» in Russian. */
export function quote(text: string, lang = 'en'): string {
  const [open, close] = QUOTES[lang] ?? QUOTES.en!;
  return `${open}${text}${close}`;
}
