/**
 * «Что внутри» записи — для карточки по клику на объект сцены или часть модели и для ИИ (MCP).
 * Скриптов у объектов Kenshi нет: «внутри» — это сама запись, откуда она (ваниль, какой мод
 * её меняет) и её связи: на что она ссылается (части, мебель, товары, отряды, диалоги…) и кто
 * ссылается на неё. Только то, что есть в данных; ничего не додумываем.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { ModContext, RecordStatus } from '../model/context.ts';

export interface InsideLink {
  sid: string;
  /** Имя записи; нет — записи нет в данных (ссылка в пустоту). */
  name?: string;
  nameRu?: string;
  type?: string;
  /** Числа ссылки (v0, v1, v2) или координаты размещённого объекта. */
  values?: number[];
}

export interface InsideGroup {
  /** Категория ссылки (`parts`, `interior`, `vendors`…) или `instances` — размещённые объекты. */
  category: string;
  links: InsideLink[];
}

export interface RecordInside {
  sid: string;
  exists: boolean;
  name?: string;
  nameRu?: string;
  type?: string;
  status?: RecordStatus;
  /** Слой, где запись появилась (gamedata.base, мод…). */
  origin?: string;
  /** Все слои, задающие запись; больше одного — её меняют моды. */
  layers: string[];
  /** На что ссылается запись, по категориям в порядке записи. */
  links: InsideGroup[];
  /** Кто ссылается на запись, по категориям ссылки. */
  usedBy: InsideGroup[];
  /** Сколько обратных ссылок всего (в `usedBy` — не больше `limit` на категорию). */
  usedByTotal: number;
}

function link(ctx: ModContext, sid: string, values?: number[]): InsideLink {
  const out: InsideLink = { sid };
  const h = ctx.headline(sid);
  if (h) {
    out.name = ctx.name(sid) ?? '';
    out.type = itemTypeName(h.type);
    const ru = ctx.localizedName(sid);
    if (ru) out.nameRu = ru;
  }
  if (values && values.length > 0) out.values = values;
  return out;
}

/** Карточка записи. `limit` — сколько обратных ссылок показывать на категорию (по умолчанию 20). */
export function inspectRecord(ctx: ModContext, sid: string, options: { limit?: number } = {}): RecordInside {
  const limit = options.limit ?? 20;
  const rec = ctx.get(sid);
  const origin = ctx.origin(sid);
  const out: RecordInside = { sid, exists: rec !== undefined, layers: origin?.layers ?? [], links: [], usedBy: [], usedByTotal: 0 };
  if (rec) {
    out.name = ctx.name(sid) ?? '';
    out.type = itemTypeName(rec.type);
    const ru = ctx.localizedName(sid);
    if (ru) out.nameRu = ru;
  }
  if (origin) {
    out.status = origin.status;
    out.origin = origin.origin;
  }
  if (!rec) return out;
  for (const [category, list] of rec.refs)
    if (list.length > 0) out.links.push({ category, links: list.map((r) => link(ctx, r.target, [r.v0, r.v1, r.v2])) });
  if (rec.instances.size > 0) {
    const links: InsideLink[] = [];
    for (const inst of rec.instances.values()) links.push(link(ctx, inst.target, [...inst.position]));
    out.links.push({ category: 'instances', links });
  }
  const groups = new Map<string, InsideLink[]>();
  for (const e of ctx.referencesTo(sid)) {
    out.usedByTotal++;
    const cat = e.category.startsWith('instance:') ? 'instances' : e.category;
    let g = groups.get(cat);
    if (!g) groups.set(cat, (g = []));
    if (g.length < limit && !g.some((l) => l.sid === e.source)) g.push(link(ctx, e.source));
  }
  for (const [category, links] of groups) out.usedBy.push({ category, links });
  return out;
}

function linkText(l: InsideLink): string {
  if (l.name === undefined) return `${l.sid} — записи нет`;
  return `${l.type ?? ''} «${l.name}»${l.nameRu ? ` (${l.nameRu})` : ''} [${l.sid}]`;
}

/** Карточка текстом (для ИИ): шапка, «внутри» по категориям, «кто ссылается». */
export function formatInside(card: RecordInside): string {
  if (!card.exists) return `${card.sid}: записи нет в данных`;
  const lines = [`${card.type ?? ''} «${card.name ?? ''}»${card.nameRu ? ` (${card.nameRu})` : ''} [${card.sid}]`];
  const changed = card.layers.slice(1);
  lines.push(`из: ${card.origin ?? '?'}${changed.length > 0 ? `; меняют: ${changed.join(', ')}` : ''}${card.status && card.status !== 'base' ? `; в моде: ${card.status}` : ''}`);
  lines.push('внутри / ссылки:');
  if (card.links.length === 0) lines.push('  пусто');
  for (const g of card.links) {
    lines.push(`  ${g.category === 'instances' ? 'размещённые объекты' : g.category} (${g.links.length}):`);
    for (const l of g.links) lines.push(`    ${linkText(l)}${l.values ? `  ${l.values.map((v) => Math.round(v * 100) / 100).join(' ')}` : ''}`);
  }
  lines.push(`кто ссылается${card.usedByTotal > 0 ? ` (${card.usedByTotal})` : ''}:`);
  if (card.usedBy.length === 0) lines.push('  пусто');
  for (const g of card.usedBy) {
    lines.push(`  ${g.category === 'instances' ? 'размещён в' : g.category}:`);
    for (const l of g.links) lines.push(`    ${linkText(l)}`);
  }
  return lines.join('\n');
}
