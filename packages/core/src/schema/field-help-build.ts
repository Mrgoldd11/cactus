/**
 * Builds a field help dictionary from compact rows: `[key, label, description?]`.
 * Kept apart from field-help.ts so the language files do not import it back (no import cycle).
 */
import type { FieldHelpDict } from './field-help.ts';

/** One field: key (`field` or `TYPE:field`), short name, translated fcs.def description. */
export type FieldHelpRow = readonly [key: string, label: string, description?: string];

export function buildFieldHelp(rows: readonly FieldHelpRow[], empty: Readonly<Record<string, string>>): FieldHelpDict {
  const labels: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  for (const [key, label, description] of rows) {
    if (key in labels) throw new Error(`field help: duplicate key "${key}"`);
    labels[key] = label;
    if (description) descriptions[key] = description;
  }
  return { labels, descriptions, empty };
}
