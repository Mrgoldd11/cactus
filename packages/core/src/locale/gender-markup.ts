/**
 * Gender / number markup of the game's translations.
 *
 * Translated texts carry alternative word endings between slashes, glued together without a
 * separator, optionally followed by a digit: ru `Трактирщи/кца1/` (Трактирщик / Трактирщица),
 * `Главн/аяый1/` (Главная / Главный), `Рад/а/` (Рад / Рада), `/мненам/` (мне / нам);
 * de `Bäcker/FEM-IN-ME/`; pt `Bandid/OA3/`. The order of the forms inside the slashes is not
 * consistent (`кца` is masculine first, `аяый` feminine first), so the masculine singular form
 * cannot be found by position: Russian uses a table built from every token in the vanilla
 * `ru_RU` data (gamedata.po and the .translation), with an ending heuristic for the rest.
 *
 * Upper-case Latin tokens such as `/FLATSKIN/` or `/HIS/` are the game's substitution words, not
 * gender markup: they are left as they are.
 */

/** Russian token (without the digit) → masculine singular ending. Covers all vanilla tokens. */
const RU_MASCULINE: Record<string, string> = {
  а: '',
  аи: '',
  аы: '',
  ка: '',
  ла: '',
  лали: '',
  лалали: '',
  те: '',
  ые: '',
  ша: '',
  ька: '',
  овка: '',
  ыка: '',
  о: '',
  к: 'к',
  кца: 'к',
  кча: 'к',
  каец: 'ец',
  аяый: 'ый',
  ыяый: 'ый',
  ояый: 'ый',
  аяы: 'ый',
  ачый: 'ый',
  наяый: 'ный',
  аяий: 'ий',
  аяой: 'ой',
  ояой: 'ой',
  ойым: 'ым',
  ойим: 'им',
  огой: 'ого',
  огоой: 'ого',
  огоую: 'ого',
  огоу: 'ого',
  омуой: 'ому',
  акомой: 'аком',
  асься: 'ся',
  енна: 'ен',
  енн: 'ен',
  елла: 'ел',
  инна: 'ин',
  анна: 'ан',
  инка: 'ин',
  окина: 'ок',
  татот: 'тот',
  йя: 'й',
  йа: 'й',
  ею: 'е',
  еу: 'е',
  итят: 'ит',
  уем: 'у',
  уим: 'у',
  юим: 'ю',
  чутим: 'чу',
  ил: 'ил',
  // Pronouns: singular / plural.
  мненам: 'мне',
  менянас: 'меня',
  мнойнами: 'мной',
  ямы: 'я',
  снамимной: 'со мной',
  тебевам: 'тебе',
  тывы: 'ты',
  тобойвами: 'тобой',
  моёнаше: 'моё',
};

/** Masculine endings for Russian tokens missing from the table (longest first). */
const RU_ENDINGS = ['ого', 'ому', 'ец', 'ий', 'ый', 'ой', 'ин', 'ен', 'ел', 'ок', 'к'];

function ruMasculine(inner: string): string {
  const known = RU_MASCULINE[inner];
  if (known !== undefined) return known;
  for (const e of RU_ENDINGS) if (inner.startsWith(e) || inner.endsWith(e)) return e;
  return inner;
}

const MARKUP = /\/([^/\s]*?)\d?\//g;

/**
 * Text without the gender markup, in the masculine singular form (the game's default):
 * `Трактирщи/кца1/` → `Трактирщик`, `Мелк/аяий1/ охотни/кца1/` → `Мелкий охотник`.
 * Substitution words (`/FLATSKIN/`) and texts without markup are returned unchanged.
 */
export function stripGenderMarkup(s: string): string {
  if (!s.includes('/')) return s;
  return s.replace(MARKUP, (whole, inner: string) => {
    if (inner === '') return whole;
    if (/^[а-яё]+$/i.test(inner)) return ruMasculine(inner.toLowerCase());
    // Upper-case pair of endings (pt `OA`): the first one is masculine.
    if (/^[A-Z]{2}$/.test(inner) && /\d\/$/.test(whole)) return inner[0]!.toLowerCase();
    // A tag that marks only the feminine form (de `FEM-IN-ME`): the masculine has no suffix.
    if (/^[A-Z]+(?:-[A-Z]+)+$/.test(inner)) return '';
    return whole;
  });
}
