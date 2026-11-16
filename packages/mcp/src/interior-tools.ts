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

const KIND: Record<InteriorObject['kind'], string> = { furniture: 'furniture', items: 'items', other: 'other' };

function layoutLine(l: InteriorLayout): string {
  const flags = [l.exterior && 'exterior', l.shop && 'shop', l.bar && 'bar', l.recruitment && 'recruitment', l.flophouse && 'flophouse'].filter(Boolean);
  return `${l.sid} — "${l.name}"${flags.length ? ` (${flags.join(', ')})` : ''}: objects ${l.objects}`;
}

function objectLine(ctx: ModContext, layout: string, o: InteriorObject, modLayer?: string, edits?: WorldEdits): string {
  const parts = [
    `${objectHandle({ file: INTERIORS, holder: layout, key: o.key })} — ${nameOf(ctx, o.target)} (${o.target})`,
    KIND[o.kind],
    `x ${round(o.position[0])} y ${round(o.position[1])} z ${round(o.position[2])}`,
    `${yawOf(o.rotation)}°`,
  ];
  if (o.floor !== undefined) parts.push(`floor ${o.floor}`);
  if (o.locked) parts.push(`locked${o.lockLevel !== undefined ? ` (lock ${o.lockLevel})` : ''}`);
  if (o.items) parts.push(`holds: ${nameOf(ctx, o.items)}`);
  if (modLayer && edits?.modRecords(INTERIORS).some((r) => r.stringId === layout && r.instances.has(o.key))) parts.push('changed in the mod');
  return parts.join(' · ');
}

function parseObject(spec: string): { layout: string; key: string } {
  const parts = spec.split('|');
  if (parts.length !== 3 || parts[0]!.toLowerCase() !== INTERIORS || !parts[1] || !parts[2]) throw new SessionError(`Object "${spec}": the form interiors.level|layout|key is needed (as in interior)`);
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
      if (spec.layout !== undefined) throw new SessionError(`No layout ${spec.layout}: give building (a building) and the layout name`);
      throw new SessionError('Give building (a building: id, name or a world object "file|owner|key") or layout (a layout id)');
    }
    let building: string;
    let fromWorld: ReturnType<typeof layoutOfBuilding>;
    let note: string | undefined;
    if (spec.building.split('|').length === 3) {
      const [file, holder, key] = spec.building.split('|') as [string, string, string];
      const b = session.world().buildings().find((x) => x.key === key && x.holder === holder && x.file.toLowerCase() === file.toLowerCase());
      if (!b) throw new SessionError(`${spec.building}: there is no such building with a state in the world (find it with list_in_area)`);
      building = b.target;
      fromWorld = layoutOfBuilding(edits, b);
      note = b.interior ? (fromWorld ? `this building in the world has the layout "${b.interior}"` : `this building in the world has the layout "${b.interior}", but the building has no such layout`) : 'this building in the world has no named layout: the game picks one itself';
    } else building = resolveId(ctx, spec.building, ['BUILDING']);
    if (spec.layout !== undefined) {
      const want = spec.layout.toLowerCase();
      const l = interiorLayouts(edits, building).find((x) => x.name.toLowerCase() === want);
      if (!l) throw new SessionError(`"${nameOf(ctx, building)}" has no layout "${spec.layout}" (see the list from interior)`);
      return { building, layout: l, ...(note ? { note } : {}) };
    }
    if (fromWorld) return { building, layout: fromWorld, ...(note ? { note } : {}) };
    const inside = interiorLayouts(edits, building).filter((l) => !l.exterior);
    return { building, ...(inside.length === 1 ? { layout: inside[0]! } : {}), ...(note ? { note } : {}) };
  };

  const pending = (edits: WorldEdits): string[] => (edits.isDirty() ? ['not saved: save writes the mod and leveldata/interiors.level'] : []);

  server.registerTool(
    'interior',
    {
      title: 'Inside a building',
      description: [
        'Building interior: layouts (a building has many: "Noble house", "Bar", "Shop"…; "exterior" are signs and flags) and the objects of the chosen layout: furniture (BUILDING: walls, beds, chests) and item points (ITEM_PLACEMENT_GROUP).',
        'building is a building (id or name, English or translated) or a world object "file|owner|key" from list_in_area (then the layout of that building is taken); layout is a layout name or id.',
        'An object is a line "interiors.level|layout|key" (interior_move and interior_remove accept it). Coordinates are from the origin of the building model.',
        'A layout is shared: an edit changes it in every building of this type where the game uses it. Residents, guards and goods are placed by the game itself (they are not in the layout).',
      ].join('\n'),
      inputSchema: {
        building: z.string().optional(),
        layout: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional().describe('How many objects to show (default 200)'),
      },
      annotations: { ...READ, title: 'Inside a building' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const edits = session.interiorEdits();
        const { building, layout, note } = layoutFrom(ctx, edits, a);
        const out: string[] = [];
        if (building !== undefined) {
          const all = interiorLayouts(edits, building);
          out.push(`"${nameOf(ctx, building)}" (${building}): layouts ${all.length}`);
          for (const l of all) out.push(`  ${layoutLine(l)}${l.sid === layout?.sid ? '  ← shown' : ''}`);
          if (!all.length) out.push('  no interior in the game files');
        }
        if (note) out.push(note);
        if (!layout) {
          if (building !== undefined && interiorLayouts(edits, building).length) out.push('Which layout to show: layout (name or id)');
          return out;
        }
        const usage = layoutUsage(session.world(), layout);
        out.push(
          `Layout "${layout.name}": in the world it is named for ${usage.named.length} buildings; ${usage.unnamed.length} more of ${usage.total} buildings of this type have no name: the game picks the layout itself (it may take this one).`,
        );
        for (const b of usage.named.slice(0, 5)) out.push(`  in the world: ${objectHandle(b)}${b.name ? ` "${b.name}"` : ''}`);
        const objs = layoutObjects(edits, ctx, layout.sid);
        const limit = a.limit ?? 200;
        const modLayer = edits.modLayer;
        out.push(`Objects ${objs.length}:`);
        for (const o of objs.slice(0, limit)) out.push(objectLine(ctx, layout.sid, o, modLayer, edits));
        if (objs.length > limit) out.push(`… and ${objs.length - limit} more (limit)`);
        return out;
      }),
  );

  server.registerTool(
    'interior_place',
    {
      title: 'Place an object in an interior',
      description: [
        'Place furniture (BUILDING: bed, chest, table…) or an item point (ITEM_PLACEMENT_GROUP) in an interior layout. x, y, z are from the origin of the building model (as for objects in interior), angle is the rotation around the vertical.',
        'The object state is a copy of the same object from the game (lock, use points), the floor is as of the nearest neighbor by height, the faction is as of the furniture of the layout.',
        'Written to the mod leveldata/interiors.level on save; undo with world_undo. Changes the layout in every building where the game uses it.',
      ].join('\n'),
      inputSchema: {
        target: z.string().describe('What to place: id or name of a record (English or translated)'),
        building: z.string().optional().describe('Building (id, name or a world object): together with the layout name'),
        layout: z.string().describe('Layout: id or name'),
        x: z.number(),
        y: z.number(),
        z: z.number(),
        angle: z.number().optional(),
      },
      annotations: { ...EDIT, title: 'Place an object in an interior' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const edits = session.interiorEdits();
        const { layout } = layoutFrom(ctx, edits, a);
        if (!layout) throw new SessionError('Layout not found');
        const target = resolveId(ctx, a.target, ['BUILDING', 'ITEM_PLACEMENT_GROUP']);
        const r = placeInterior(edits, ctx, layout.sid, target, [a.x, a.y, a.z], turn([1, 0, 0, 0], a.angle ?? 0), `Into interior "${layout.name}": ${nameOf(ctx, target)}`);
        const o = layoutObject(edits, ctx, layout.sid, r.key)!;
        return [
          `Placed ${objectLine(ctx, layout.sid, o)}`,
          r.template ? `state copied from ${r.template}` : 'there is no such object in the game interiors: the state was built from scratch (without use points); how it behaves in the game has not been checked',
          ...pending(edits),
        ];
      }),
  );

  server.registerTool(
    'interior_move',
    {
      title: 'Move / rotate an interior object',
      description: [
        'Move or rotate an interior object (object is "interiors.level|layout|key" from interior). x, y, z: the new place (or dx, dy, dz: an offset), from the origin of the building model; angle is the rotation around the vertical (or turn: rotate by).',
        'If the height changes, the floor (floornum) and the height in the state follow. Undo with world_undo.',
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
      annotations: { ...EDIT, title: 'Move / rotate an interior object' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const edits = session.interiorEdits();
        const h = parseObject(a.object);
        const cur = layoutObject(edits, ctx, h.layout, h.key);
        if (!cur) throw new SessionError(`No object ${a.object} (see the list from interior)`);
        const [x0, y0, z0] = cur.position;
        const p: [number, number, number] = [a.x ?? x0 + (a.dx ?? 0), a.y ?? y0 + (a.dy ?? 0), a.z ?? z0 + (a.dz ?? 0)];
        let rotation = cur.rotation;
        if (a.angle !== undefined) rotation = turn(rotation, a.angle - yawOf(rotation));
        if (a.turn !== undefined) rotation = turn(rotation, a.turn);
        const moved = p[0] !== x0 || p[1] !== y0 || p[2] !== z0;
        if (!moved && rotation === cur.rotation) return ['Nothing changes: give x / y / z / dx / dy / dz / angle / turn'];
        moveInterior(edits, ctx, h.layout, h.key, p, rotation, `${moved ? 'Move' : 'Rotate'} in an interior: ${nameOf(ctx, cur.target)}`);
        return [objectLine(ctx, h.layout, layoutObject(edits, ctx, h.layout, h.key)!), ...pending(edits)];
      }),
  );

  server.registerTool(
    'interior_remove',
    {
      title: 'Remove an object from an interior',
      description: 'Remove an interior object (object is "interiors.level|layout|key" from interior). An object of the game or another mod is removed by the mod with an empty record on top; undo with world_undo.',
      inputSchema: { object: z.string() },
      annotations: { ...EDIT, title: 'Remove an object from an interior' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const edits = session.interiorEdits();
        const h = parseObject(a.object);
        const cur = layoutObject(edits, ctx, h.layout, h.key);
        if (!cur) throw new SessionError(`No object ${a.object} (see the list from interior)`);
        removeInterior(edits, h.layout, h.key, `From an interior: ${nameOf(ctx, cur.target)}`);
        return [`Removed ${a.object} — ${nameOf(ctx, cur.target)} (${cur.target})`, ...pending(edits)];
      }),
  );
}
