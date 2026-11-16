/**
 * «Что внутри» записи — для карточки по клику на объект сцены или часть модели и для ИИ (MCP).
 * Скриптов у объектов Kenshi нет: «внутри» — это сама запись, откуда она (ваниль, какой мод
 * её меняет) и её связи: на что она ссылается (части, мебель, товары, отряды, диалоги…) и кто
 * ссылается на неё. Только то, что есть в данных; ничего не додумываем.
 */
import type { ModContext, RecordStatus } from '../model/context.ts';

export interface InsideLink {
  sid: string;
  /** Имя записи; нет — записи нет в данных (ссылка в пустоту). */
  name?: string;
  localizedName?: string;
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
  localizedName?: string;
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
    out.type = ctx.typeName(h.type);
    const ru = ctx.localizedName(sid);
    if (ru) out.localizedName = ru;
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
    out.type = ctx.typeName(rec.type);
    const ru = ctx.localizedName(sid);
    if (ru) out.localizedName = ru;
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

/** Words of the text card per language (English when there is none for it). */
const INSIDE_WORDS: Record<string, { noRecord: string; notInData: string; from: string; changedBy: string; inMod: string; inside: string; empty: string; placed: string; usedBy: string; placedIn: string }> = {
  en: { noRecord: 'no record', notInData: 'no record in the data', from: 'from', changedBy: 'changed by', inMod: 'in the mod', inside: 'inside / references:', empty: 'empty', placed: 'placed objects', usedBy: 'used by', placedIn: 'placed in' },
  ru: { noRecord: 'записи нет', notInData: 'записи нет в данных', from: 'из', changedBy: 'меняют', inMod: 'в моде', inside: 'внутри / ссылки:', empty: 'пусто', placed: 'размещённые объекты', usedBy: 'кто ссылается', placedIn: 'размещён в' },
  zh: { noRecord: '无记录', notInData: '数据中无此记录', from: '来自', changedBy: '修改者', inMod: 'Mod 中', inside: '内部 / 引用：', empty: '空', placed: '放置的对象', usedBy: '被引用于', placedIn: '放置于' },
};

function linkText(l: InsideLink, w: (typeof INSIDE_WORDS)[string]): string {
  if (l.name === undefined) return `${l.sid} — ${w.noRecord}`;
  return `${l.type ?? ''} «${l.name}»${l.localizedName ? ` (${l.localizedName})` : ''} [${l.sid}]`;
}

/** Карточка текстом (для ИИ): шапка, «внутри» по категориям, «кто ссылается». */
export function formatInside(card: RecordInside, lang = 'en'): string {
  const w = INSIDE_WORDS[lang] ?? INSIDE_WORDS.en!;
  if (!card.exists) return `${card.sid}: ${w.notInData}`;
  const lines = [`${card.type ?? ''} «${card.name ?? ''}»${card.localizedName ? ` (${card.localizedName})` : ''} [${card.sid}]`];
  const changed = card.layers.slice(1);
  lines.push(`${w.from}: ${card.origin ?? '?'}${changed.length > 0 ? `; ${w.changedBy}: ${changed.join(', ')}` : ''}${card.status && card.status !== 'base' ? `; ${w.inMod}: ${card.status}` : ''}`);
  lines.push(w.inside);
  if (card.links.length === 0) lines.push(`  ${w.empty}`);
  for (const g of card.links) {
    lines.push(`  ${g.category === 'instances' ? w.placed : g.category} (${g.links.length}):`);
    for (const l of g.links) lines.push(`    ${linkText(l, w)}${l.values ? `  ${l.values.map((v) => Math.round(v * 100) / 100).join(' ')}` : ''}`);
  }
  lines.push(`${w.usedBy}${card.usedByTotal > 0 ? ` (${card.usedByTotal})` : ''}:`);
  if (card.usedBy.length === 0) lines.push(`  ${w.empty}`);
  for (const g of card.usedBy) {
    lines.push(`  ${g.category === 'instances' ? w.placedIn : g.category}:`);
    for (const l of g.links) lines.push(`    ${linkText(l, w)}`);
  }
  return lines.join('\n');
}
