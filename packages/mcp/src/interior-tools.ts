/**
 * Инструменты интерьеров: что внутри здания (`interior`), поставить / сдвинуть / убрать мебель и
 * точки предметов в раскладке (`interior_place`, `interior_move`, `interior_remove`). Правки — в
 * `leveldata/interiors.level` мода, та же история отмены, что у правок мира (`world_undo`).
 * Координаты — от начала модели здания (у «Дома знати» Аванпоста пол на y≈182 и 229).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  interiorLayout,
  interiorLayouts,
  INTERIORS,
  layoutObject,
  layoutObjects,
  layoutOfBuilding,
  layoutUsage,
  moveInterior,
  placeInterior,
  removeInterior,
  type InteriorLayout,
  type InteriorObject,
  type ModContext,
  type WorldEdits,
} from '@kenshi-editor/core';
import { SessionError, type Session } from './session.ts';
import { objectHandle, turn, yawOf, type WorldToolHelpers } from './world-tools.ts';

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

function nameOf(ctx: ModContext, sid: string): string {
  return ctx.localizedName(sid) ?? ctx.name(sid) ?? sid;
}

const round = (n: number): number => Math.round(n * 10) / 10;

const KIND: Record<InteriorObject['kind'], string> = { furniture: 'мебель', items: 'предметы', other: 'другое' };

function layoutLine(l: InteriorLayout): string {
  const flags = [l.exterior && 'снаружи', l.shop && 'магазин', l.bar && 'бар', l.recruitment && 'найм', l.flophouse && 'ночлежка'].filter(Boolean);
  return `${l.sid} — «${l.name}»${flags.length ? ` (${flags.join(', ')})` : ''}: объектов ${l.objects}`;
}

function objectLine(ctx: ModContext, layout: string, o: InteriorObject, modLayer?: string, edits?: WorldEdits): string {
  const parts = [
    `${objectHandle({ file: INTERIORS, holder: layout, key: o.key })} — ${nameOf(ctx, o.target)} (${o.target})`,
    KIND[o.kind],
    `x ${round(o.position[0])} y ${round(o.position[1])} z ${round(o.position[2])}`,
    `${yawOf(o.rotation)}°`,
  ];
  if (o.floor !== undefined) parts.push(`этаж ${o.floor}`);
  if (o.locked) parts.push(`заперт${o.lockLevel !== undefined ? ` (замок ${o.lockLevel})` : ''}`);
  if (o.items) parts.push(`лежит: ${nameOf(ctx, o.items)}`);
  if (modLayer && edits?.modRecords(INTERIORS).some((r) => r.stringId === layout && r.instances.has(o.key))) parts.push('изменено в моде');
  return parts.join(' · ');
}

function parseObject(spec: string): { layout: string; key: string } {
  const parts = spec.split('|');
  if (parts.length !== 3 || parts[0]!.toLowerCase() !== INTERIORS || !parts[1] || !parts[2]) throw new SessionError(`Объект «${spec}»: нужен вид interiors.level|раскладка|ключ (как в interior)`);
  return { layout: parts[1], key: parts[2] };
}

export function registerInteriorTools(server: McpServer, session: Session, { run, resolveId }: WorldToolHelpers): void {
  /** Раскладка: id, или здание (id / имя / объект мира) + имя раскладки. */
  const layoutFrom = (ctx: ModContext, edits: WorldEdits, spec: { building?: string | undefined; layout?: string | undefined }): { building?: string; layout?: InteriorLayout; note?: string } => {
    if (spec.layout !== undefined) {
      const direct = interiorLayout(edits, spec.layout);
      if (direct) return { building: direct.building, layout: direct };
    }
    if (spec.building === undefined) {
      if (spec.layout !== undefined) throw new SessionError(`Нет раскладки ${spec.layout}: укажите building (здание) и имя раскладки`);
      throw new SessionError('Укажите building (здание: id, имя или объект мира «файл|владелец|ключ») или layout (id раскладки)');
    }
    let building: string;
    let fromWorld: ReturnType<typeof layoutOfBuilding>;
    let note: string | undefined;
    if (spec.building.split('|').length === 3) {
      const [file, holder, key] = spec.building.split('|') as [string, string, string];
      const b = session.world().buildings().find((x) => x.key === key && x.holder === holder && x.file.toLowerCase() === file.toLowerCase());
      if (!b) throw new SessionError(`${spec.building}: в мире нет такого здания с состоянием (list_in_area — найти)`);
      building = b.target;
      fromWorld = layoutOfBuilding(edits, b);
      note = b.interior ? (fromWorld ? `у этого здания в мире раскладка «${b.interior}»` : `у этого здания в мире раскладка «${b.interior}», но такой у здания нет`) : 'у этого здания в мире раскладка не названа — игра выбирает её сама';
    } else building = resolveId(ctx, spec.building, ['BUILDING']);
    if (spec.layout !== undefined) {
      const want = spec.layout.toLowerCase();
      const l = interiorLayouts(edits, building).find((x) => x.name.toLowerCase() === want);
      if (!l) throw new SessionError(`У «${nameOf(ctx, building)}» нет раскладки «${spec.layout}» (interior — список)`);
      return { building, layout: l, ...(note ? { note } : {}) };
    }
    if (fromWorld) return { building, layout: fromWorld, ...(note ? { note } : {}) };
    const inside = interiorLayouts(edits, building).filter((l) => !l.exterior);
    return { building, ...(inside.length === 1 ? { layout: inside[0]! } : {}), ...(note ? { note } : {}) };
  };

  const pending = (edits: WorldEdits): string[] => (edits.isDirty() ? ['не сохранено: save запишет мод и leveldata/interiors.level'] : []);

  server.registerTool(
    'interior',
    {
      title: 'Что внутри здания',
      description: [
        'Интерьер здания: раскладки (у здания их много — «Дом знати», «Бар», «Магазин»…; «снаружи» — вывески и флаги) и объекты выбранной раскладки: мебель (BUILDING — стены, кровати, сундуки) и точки предметов (ITEM_PLACEMENT_GROUP).',
        'building — здание (id или имя, англ. или рус.) или объект мира «файл|владелец|ключ» из list_in_area (тогда берётся раскладка этого здания); layout — имя или id раскладки.',
        'Объект — строкой «interiors.level|раскладка|ключ» (её принимают interior_move и interior_remove). Координаты — от начала модели здания.',
        'Раскладка общая: правка меняет её во всех зданиях этого типа, где игра её берёт. Жителей, охрану и товар игра ставит сама (их в раскладке нет).',
      ].join('\n'),
      inputSchema: {
        building: z.string().optional(),
        layout: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional().describe('Сколько объектов показать (по умолчанию 200)'),
      },
      annotations: { ...READ, title: 'Что внутри здания' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const edits = session.interiorEdits();
        const { building, layout, note } = layoutFrom(ctx, edits, a);
        const out: string[] = [];
        if (building !== undefined) {
          const all = interiorLayouts(edits, building);
          out.push(`«${nameOf(ctx, building)}» (${building}): раскладок ${all.length}`);
          for (const l of all) out.push(`  ${layoutLine(l)}${l.sid === layout?.sid ? '  ← показана' : ''}`);
          if (!all.length) out.push('  интерьера в файлах игры нет');
        }
        if (note) out.push(note);
        if (!layout) {
          if (building !== undefined && interiorLayouts(edits, building).length) out.push('Какую раскладку показать — layout (имя или id)');
          return out;
        }
        const usage = layoutUsage(session.world(), layout);
        out.push(
          `Раскладка «${layout.name}»: в мире у ${usage.named.length} зданий по имени; ещё у ${usage.unnamed.length} из ${usage.total} зданий этого типа имени нет — игра выбирает раскладку сама (может взять и эту).`,
        );
        for (const b of usage.named.slice(0, 5)) out.push(`  в мире: ${objectHandle(b)}${b.name ? ` «${b.name}»` : ''}`);
        const objs = layoutObjects(edits, ctx, layout.sid);
        const limit = a.limit ?? 200;
        const modLayer = edits.modLayer;
        out.push(`Объектов ${objs.length}:`);
        for (const o of objs.slice(0, limit)) out.push(objectLine(ctx, layout.sid, o, modLayer, edits));
        if (objs.length > limit) out.push(`… ещё ${objs.length - limit} (limit)`);
        return out;
      }),
  );

  server.registerTool(
    'interior_place',
    {
      title: 'Поставить объект в интерьер',
      description: [
        'Поставить в раскладку интерьера мебель (BUILDING: кровать, сундук, стол…) или точку предметов (ITEM_PLACEMENT_GROUP). x, y, z — от начала модели здания (как у объектов в interior), angle — поворот вокруг вертикали.',
        'Состояние объекта — копия такого же объекта из игры (замок, точки использования), этаж — как у ближайшего по высоте соседа, фракция — как у мебели раскладки.',
        'Пишется в leveldata/interiors.level мода при save; отмена — world_undo. Меняет раскладку во всех зданиях, где игра её берёт.',
      ].join('\n'),
      inputSchema: {
        target: z.string().describe('Что поставить: id или имя записи (англ. или рус.)'),
        building: z.string().optional().describe('Здание (id, имя или объект мира) — вместе с layout-именем'),
        layout: z.string().describe('Раскладка: id или имя'),
        x: z.number(),
        y: z.number(),
        z: z.number(),
        angle: z.number().optional(),
      },
      annotations: { ...EDIT, title: 'Поставить объект в интерьер' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const edits = session.interiorEdits();
        const { layout } = layoutFrom(ctx, edits, a);
        if (!layout) throw new SessionError('Не нашлась раскладка');
        const target = resolveId(ctx, a.target, ['BUILDING', 'ITEM_PLACEMENT_GROUP']);
        const r = placeInterior(edits, ctx, layout.sid, target, [a.x, a.y, a.z], turn([1, 0, 0, 0], a.angle ?? 0), `В интерьер «${layout.name}»: ${nameOf(ctx, target)}`);
        const o = layoutObject(edits, ctx, layout.sid, r.key)!;
        return [
          `Поставлен ${objectLine(ctx, layout.sid, o)}`,
          r.template ? `состояние скопировано с ${r.template}` : 'такого объекта в интерьерах игры нет — состояние собрано заново (без точек использования); как поведёт себя в игре, не проверено',
          ...pending(edits),
        ];
      }),
  );

  server.registerTool(
    'interior_move',
    {
      title: 'Сдвинуть / повернуть объект интерьера',
      description: [
        'Сдвинуть или повернуть объект интерьера (object — «interiors.level|раскладка|ключ» из interior). x, y, z — новое место (или dx, dy, dz — сдвиг), от начала модели здания; angle — поворот вокруг вертикали (или turn — повернуть на).',
        'Сменилась высота — этаж (floornum) и высота в состоянии следом. Отмена — world_undo.',
      ].join('\n'),
      inputSchema: {
        object: z.string(),
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        dx: z.number().optional(),
        dy: z.number().optional(),
        dz: z.number().optional(),
        angle: z.number().optional(),
        turn: z.number().optional(),
      },
      annotations: { ...EDIT, title: 'Сдвинуть / повернуть объект интерьера' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const edits = session.interiorEdits();
        const h = parseObject(a.object);
        const cur = layoutObject(edits, ctx, h.layout, h.key);
        if (!cur) throw new SessionError(`Нет объекта ${a.object} (interior — список)`);
        const [x0, y0, z0] = cur.position;
        const p: [number, number, number] = [a.x ?? x0 + (a.dx ?? 0), a.y ?? y0 + (a.dy ?? 0), a.z ?? z0 + (a.dz ?? 0)];
        let rotation = cur.rotation;
        if (a.angle !== undefined) rotation = turn(rotation, a.angle - yawOf(rotation));
        if (a.turn !== undefined) rotation = turn(rotation, a.turn);
        const moved = p[0] !== x0 || p[1] !== y0 || p[2] !== z0;
        if (!moved && rotation === cur.rotation) return ['Ничего не меняется: укажите x / y / z / dx / dy / dz / angle / turn'];
        moveInterior(edits, ctx, h.layout, h.key, p, rotation, `${moved ? 'Сдвиг' : 'Поворот'} в интерьере: ${nameOf(ctx, cur.target)}`);
        return [objectLine(ctx, h.layout, layoutObject(edits, ctx, h.layout, h.key)!), ...pending(edits)];
      }),
  );

  server.registerTool(
    'interior_remove',
    {
      title: 'Убрать объект из интерьера',
      description: 'Убрать объект интерьера (object — «interiors.level|раскладка|ключ» из interior). Объект игры или другого мода мод убирает пустой записью поверх; отмена — world_undo.',
      inputSchema: { object: z.string() },
      annotations: { ...EDIT, title: 'Убрать объект из интерьера' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const edits = session.interiorEdits();
        const h = parseObject(a.object);
        const cur = layoutObject(edits, ctx, h.layout, h.key);
        if (!cur) throw new SessionError(`Нет объекта ${a.object} (interior — список)`);
        removeInterior(edits, h.layout, h.key, `Из интерьера: ${nameOf(ctx, cur.target)}`);
        return [`Убран ${a.object} — ${nameOf(ctx, cur.target)} (${cur.target})`, ...pending(edits)];
      }),
  );
}
