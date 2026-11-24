/**
 * The field help dictionaries against the installed game's fcs.def: every field of the covered
 * types has a short name and (where fcs.def describes it) a translated description in each
 * interface language, and no dictionary key is stale. Skipped without the game.
 */
import { describe, expect, it } from 'vitest';
import { FIELD_HELP, FIELD_HELP_TYPES, fieldHelp } from '../src/index.ts';
import { hasGame, loadGameSchema, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);

describe.skipIf(!game)('field help vs fcs.def', () => {
  const schema = game ? loadGameSchema(paths) : undefined;
  const fieldsOf = (type: string) => [...(schema!.types.get(type)?.fields.values() ?? [])].filter((f) => f.builtin !== true && f.inferred !== true);

  it('the covered types exist', () => {
    for (const type of FIELD_HELP_TYPES) expect(schema!.types.has(type), type).toBe(true);
  });

  for (const lang of ['ru', 'zh']) {
    it(`${lang}: every field has a name and a translated description`, () => {
      const missing: string[] = [];
      for (const type of FIELD_HELP_TYPES) {
        for (const f of fieldsOf(type)) {
          const h = fieldHelp(type, f.name, lang);
          if (!h.label) missing.push(`${type}:${f.name} (label)`);
          if (f.description?.trim() && !h.description) missing.push(`${type}:${f.name} (description)`);
        }
      }
      expect(missing).toEqual([]);
    });
  }

  it('no dictionary key is stale', () => {
    const known = new Set<string>();
    for (const type of FIELD_HELP_TYPES) {
      for (const f of fieldsOf(type)) {
        known.add(f.name);
        known.add(`${type}:${f.name}`);
      }
    }
    const stale: string[] = [];
    for (const [lang, dict] of Object.entries(FIELD_HELP)) {
      for (const map of [dict.labels, dict.descriptions, dict.empty]) {
        for (const key of Object.keys(map ?? {})) if (!known.has(key)) stale.push(`${lang}: ${key}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('every language has the same keys as ru', () => {
    const ru = FIELD_HELP.ru!;
    for (const lang of ['zh']) {
      const d = FIELD_HELP[lang]!;
      expect(Object.keys(d.labels ?? {}).sort(), lang).toEqual(Object.keys(ru.labels ?? {}).sort());
      expect(Object.keys(d.empty ?? {}).sort(), lang).toEqual(Object.keys(ru.empty ?? {}).sort());
    }
    expect(Object.keys(FIELD_HELP.en!.empty ?? {}).sort()).toEqual(Object.keys(ru.empty ?? {}).sort());
  });
});
