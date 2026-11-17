/**
 * «+ New» in a category: a new record that belongs to the category (its `fcs_layout.def`
 * filters are applied, e.g. `item function=ITEM_BOOK` for Books) and, optionally, is a copy of a
 * sample record (all its fields and references) under a new name and id. One undo step.
 */
import type { LayoutFilter } from '../schema/fcs-layout.ts';
import { EditError, type ModContext } from './context.ts';
import { applyLayoutFilters, matchesLayoutFilters } from './editor-view.ts';

export interface NewRecordOptions {
  /** Record type id. */
  type: number;
  name: string;
  /** Record to copy fields and references from (must be of `type`); absent — an empty record. */
  sample?: string;
  /** Filters of the category the record is created in. */
  filters?: readonly LayoutFilter[];
  stringId?: string;
}

/** History label of «new record based on a sample» (step-title.ts turns it into a clear title). */
export function newRecordLabel(name: string, sample: string): string {
  return `новая запись «${name}» по образцу ${sample}`;
}

/**
 * Create a record in a category as one undo step: a copy of `sample` (or an empty record),
 * then the category filters on top. Returns the id of the new record.
 */
export function createRecordIn(ctx: ModContext, options: NewRecordOptions): string {
  const name = options.name.trim();
  if (name === '') throw new EditError({ en: 'Enter a name for the new record', ru: 'Введите имя новой записи', zh: '请输入新记录的名称' });
  const { sample } = options;
  if (sample !== undefined) {
    const rec = ctx.get(sample);
    if (!rec || ctx.status(sample) === 'deleted') throw new EditError({ en: `Sample ${sample} not found`, ru: `Образец ${sample} не найден`, zh: `未找到样本 ${sample}` });
    if (rec.type !== options.type) {
      const want = ctx.typeName(options.type);
      throw new EditError({ en: `Sample ${sample} is not ${want}`, ru: `Образец ${sample} — не ${want}`, zh: `样本 ${sample} 不是 ${want}` });
    }
  }
  const id = options.stringId !== undefined ? { stringId: options.stringId } : {};
  const label = sample !== undefined ? newRecordLabel(name, sample) : `создать «${name}»`;
  return ctx.transaction(label, () => {
    const sid = sample !== undefined ? ctx.duplicateRecord(sample, { name, ...id }) : ctx.createRecord(options.type, name, id);
    const filters = options.filters ?? [];
    // A copy of a category record usually matches already; only touch the record when it does not.
    if (filters.length > 0 && !matchesLayoutFilters(ctx.schema, ctx.get(sid)!, filters)) {
      ctx.editRecord(sid, (d) => {
        applyLayoutFilters(ctx.schema, d, filters);
      });
    }
    return sid;
  });
}

/**
 * Sample offered for a new record: the selected record when it is among `candidates` (the
 * category records in list order), otherwise the first one. Records deleted by the mod and
 * service templates (names starting with `_`, like `_LETTER TEMPLATE`) are skipped unless
 * there is nothing else. Undefined — no candidates.
 */
export function defaultSample(ctx: ModContext, candidates: readonly string[], selected?: string): string | undefined {
  const live = candidates.filter((sid) => ctx.get(sid) !== undefined && ctx.status(sid) !== 'deleted');
  if (selected !== undefined && live.includes(selected)) return selected;
  return live.find((sid) => !(ctx.name(sid) ?? '').startsWith('_')) ?? live[0];
}
