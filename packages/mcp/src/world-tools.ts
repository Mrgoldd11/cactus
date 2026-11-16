/**
 * World tools: what stands around a point or town (`list_in_area`), place / move /
 * remove an object (`place`, `move`, `remove`), history and undo of world edits (`world_history`,
 * `world_undo`). Edits go into the mod level files (`leveldata/zone.X.Y.zone`), written together with the
 * mod by the save tool. y everywhere is the height above ground (as in the game files).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { newBuildingStates, zoneOfPoint, type BuildingPlacement, type ModContext, type Placement, type Vec4, type WorldEdits } from '@kenshi-editor/core';
import { registerInteriorTools } from './interior-tools.ts';
import { SessionError, type Session } from './session.ts';

type Run = (fn: () => string[] | Promise<string[]>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;

export interface WorldToolHelpers {
  run: Run;
  resolveId: (ctx: ModContext, spec: string, preferTypes?: readonly string[]) => string;
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** A world object as one line: `file|owner|key` (that is how move and remove accept it). */
export function objectHandle(p: { file: string; holder: string; key: string }): string {
  return `${p.file}|${p.holder}|${p.key}`;
}

function parseHandle(spec: string): { file: string; holder: string; key: string } {
  const parts = spec.split('|');
  if (parts.length !== 3 || parts.some((s) => s === '')) throw new SessionError(`Object "${spec}": the form file|owner|key is needed (as in list_in_area)`);
  const [file, holder, key] = parts as [string, string, string];
  return { file, holder, key };
}

/** Rotation angle around the vertical in degrees (from the quaternion w, x, y, z). */
export function yawOf(q: Vec4): number {
  const [w, x, y, z] = q;
  const deg = (Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y)) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}

/** Rotate a quaternion around the vertical by `deg` degrees (the tilt is kept). */
export function turn(q: Vec4, deg: number): Vec4 {
  const h = (deg * Math.PI) / 360;
  const [bw, bx, by, bz] = q;
  const aw = Math.cos(h);
  const ay = Math.sin(h);
  // (aw, 0, ay, 0) · (bw, bx, by, bz)
  return [aw * bw - ay * by, aw * bx + ay * bz, aw * by + ay * bw, aw * bz - ay * bx];
}

function nameOf(ctx: ModContext, sid: string): string {
  const ru = ctx.localizedName(sid);
  const en = ctx.name(sid);
  return ru ?? en ?? sid;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function registerWorldTools(server: McpServer, session: Session, { run, resolveId }: WorldToolHelpers): void {
  const placementOf = (h: { file: string; holder: string; key: string }): Placement | undefined => {
    const file = h.file.toLowerCase();
    for (const p of session.world().placements()) if (p.key === h.key && p.holder === h.holder && p.file.toLowerCase() === file) return p;
    return undefined;
  };
  const buildingOf = (p: Placement): BuildingPlacement | undefined => session.world().buildings().find((b) => b.key === p.key && b.holder === p.holder && b.file === p.file);

  /** A "near" point: a town or a placed record by id or name. */
  const centreOf = (ctx: ModContext, spec: string): { x: number; z: number; label: string } => {
    const id = resolveId(ctx, spec, ['TOWN', 'BUILDING']);
    const w = session.world();
    const p = w.towns(id)[0] ?? w.instancesOf(id)[0];
    if (!p) throw new SessionError(`"${nameOf(ctx, id)}" (${id}) is not placed in the world`);
    return { x: p.position[0], z: p.position[2], label: `${nameOf(ctx, id)} (${id})` };
  };

  const line = (ctx: ModContext, p: Placement, d: number | undefined, modLayer: string | undefined): string => {
    const b = buildingOf(p);
    const parts = [
      `${objectHandle(p)} — ${nameOf(ctx, p.target)} (${p.target})`,
      ...(d !== undefined ? [`${Math.round(d)} m`] : []),
      `x ${round(p.position[0])} y ${round(p.position[1])} z ${round(p.position[2])}`,
      `${yawOf(p.rotation)}°`,
    ];
    if (b?.name) parts.push(`building "${b.name}"`);
    if (modLayer !== undefined && p.layer === modLayer) parts.push('changed in the mod');
    return parts.join(' · ');
  };

  server.registerTool(
    'list_in_area',
    {
      title: 'World objects around a point',
      description: [
        'What stands in the world around a point (x, z) or near a town / building (near is an id or a name, English or translated): buildings, walls, items.',
        'Each object is a line "file|owner|key" (move and remove accept it), the record, distance, position (y for zone objects is above ground; for towns from leveldata.level it is as in the file), rotation in degrees.',
        'Includes unsaved world edits of the mod (place / move / remove).',
      ].join('\n'),
      inputSchema: {
        near: z.string().optional().describe('Town or record (id or name): the center of the search'),
        x: z.number().optional(),
        z: z.number().optional(),
        radius: z.number().positive().max(20000).optional().describe('Radius, default 300'),
        target: z.string().optional().describe('Only objects of this record (id or name)'),
        limit: z.number().int().min(1).max(500).optional().describe('How many to show (default 50, nearest first)'),
      },
      annotations: { ...READ, title: 'World objects around a point' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        let c: { x: number; z: number; label: string };
        if (a.near !== undefined) c = centreOf(ctx, a.near);
        else if (a.x !== undefined && a.z !== undefined) c = { x: a.x, z: a.z, label: `${Math.round(a.x)} ${Math.round(a.z)}` };
        else throw new SessionError('Give near (a town or a record) or x and z');
        const r = a.radius ?? 300;
        const target = a.target !== undefined ? resolveId(ctx, a.target) : undefined;
        const hits: { p: Placement; d: number }[] = [];
        for (const p of session.world().placements()) {
          if (target !== undefined && p.target !== target) continue;
          const d = Math.hypot(p.position[0] - c.x, p.position[2] - c.z);
          if (d <= r) hits.push({ p, d });
        }
        hits.sort((u, v) => u.d - v.d);
        const zone = zoneOfPoint(c.x, c.z);
        const modLayer = session.opened ? modLayerOf(session) : undefined;
        const limit = a.limit ?? 50;
        const out = [`Around ${c.label} (zone ${zone.x}.${zone.y}), radius ${r}: objects ${hits.length}`];
        for (const { p, d } of hits.slice(0, limit)) out.push(line(ctx, p, d, modLayer));
        if (hits.length > limit) out.push(`… and ${hits.length - limit} more (limit or a smaller radius)`);
        return out;
      }),
  );

  server.registerTool(
    'place',
    {
      title: 'Place an object in the world',
      description: [
        'Place an instance of a record (building, wall, crate, furniture…) in the world at the point (x, z); y is the height above ground (default 0), angle is the rotation around the vertical in degrees.',
        'Written to the mod zone file (leveldata/zone.X.Y.zone) on save; undo with world_undo.',
        'A building is placed finished (state GAMESTATE_BUILDING: is complete, materials from the record); without it the game makes a for-sale construction site. No factions, residents or interior layout: the game picks the interior itself.',
      ].join('\n'),
      inputSchema: {
        target: z.string().describe('What to place: id or name of a record (English or translated)'),
        x: z.number(),
        z: z.number(),
        y: z.number().optional().describe('Height above ground, default 0'),
        angle: z.number().optional().describe('Rotation around the vertical, degrees'),
      },
      annotations: { ...EDIT, title: 'Place an object in the world' },
    },
    (a) =>
      run(async () => {
        const ctx = session.ctx();
        const edits = session.worldEdits();
        const target = resolveId(ctx, a.target, ['BUILDING']);
        const zone = zoneOfPoint(a.x, a.z);
        const path = `zone.${zone.x}.${zone.y}.zone`;
        const holder = edits.holders(path).find((h) => h.endsWith('buildinglist')) ?? '0-buildinglist';
        const rotation = turn([1, 0, 0, 0], a.angle ?? 0);
        const notes: string[] = [];
        // World height for the building state: ground from the game heightmap + y.
        const g = await session.groundAt([{ x: a.x, z: a.z }]);
        const states = newBuildingStates(ctx.get(target), (g?.[0] ?? 0) + (a.y ?? 0));
        if (states && !g) notes.push('no height map: world Y pos = y (the game may put the building at the wrong height)');
        const key = edits.place(path, holder, target, [a.x, a.y ?? 0, a.z], rotation, states ? { states } : {}, `New object: ${nameOf(ctx, target)}`);
        return [`Placed ${objectHandle({ file: path, holder, key })} — ${nameOf(ctx, target)} (${target})`, ...notes, ...pending(edits)];
      }),
  );

  server.registerTool(
    'move',
    {
      title: 'Move / rotate a world object',
      description: [
        'Move or rotate a world object (object is a "file|owner|key" line from list_in_area).',
        'x, z: the new place (or dx, dz: an offset); y is the height above ground; angle is the rotation around the vertical in degrees (or turn: rotate by).',
        'Only inside the same zone (4608 × 4608): to another zone use remove and place. For a building with a state, the world height (world Y pos) is recomputed from the terrain.',
      ].join('\n'),
      inputSchema: {
        object: z.string(),
        x: z.number().optional(),
        z: z.number().optional(),
        dx: z.number().optional(),
        dz: z.number().optional(),
        y: z.number().optional().describe('Height above ground'),
        angle: z.number().optional().describe('Rotation around the vertical, degrees (absolute)'),
        turn: z.number().optional().describe('Rotate by this many degrees'),
      },
      annotations: { ...EDIT, title: 'Move / rotate a world object' },
    },
    (a) =>
      run(async () => {
        const ctx = session.ctx();
        const edits = session.worldEdits();
        const h = parseHandle(a.object);
        const cur = edits.instance(h.file, h.holder, h.key);
        if (!cur) throw new SessionError(`No object ${a.object} (find it with list_in_area)`);
        const [x0, y0, z0] = cur.position;
        const x = a.x ?? x0 + (a.dx ?? 0);
        const z = a.z ?? z0 + (a.dz ?? 0);
        const y = a.y ?? y0;
        let rotation = cur.rotation;
        if (a.angle !== undefined) rotation = turn(rotation, a.angle - yawOf(rotation));
        if (a.turn !== undefined) rotation = turn(rotation, a.turn);
        const notes: string[] = [];
        let worldY: number | undefined;
        const p = placementOf(h);
        const b = p ? buildingOf(p) : undefined;
        if (b?.worldY !== undefined) {
          // World height: the previous one + lift above ground + terrain difference.
          let dg = 0;
          if (x !== x0 || z !== z0) {
            const g = await session.groundAt([{ x: x0, z: z0 }, { x, z }]);
            if (g) dg = g[1]! - g[0]!;
            else notes.push('no height map: world Y pos moved without the terrain');
          }
          worldY = b.worldY + (y - y0) + dg;
        }
        const turned = rotation !== cur.rotation;
        const step = x !== x0 || z !== z0 || y !== y0 ? 'Move' : turned ? 'Rotate' : undefined;
        if (!step) return ['Nothing changes: give x / z / dx / dz / y / angle / turn'];
        edits.move(h.file, h.holder, h.key, [x, y, z], rotation, worldY !== undefined ? { worldY } : {}, `${step}: ${nameOf(ctx, cur.target)}`);
        const moved = placementOf(h);
        return [moved ? line(ctx, moved, undefined, undefined) : a.object, ...notes, ...pending(edits)];
      }),
  );

  server.registerTool(
    'remove',
    {
      title: 'Remove an object from the world',
      description: 'Remove a world object (object is "file|owner|key" from list_in_area). An object of vanilla or another mod is removed by the mod with an empty record on top; undo with world_undo.',
      inputSchema: { object: z.string() },
      annotations: { ...EDIT, title: 'Remove an object from the world' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const edits = session.worldEdits();
        const h = parseHandle(a.object);
        const cur = edits.instance(h.file, h.holder, h.key);
        if (!cur) throw new SessionError(`No object ${a.object} (find it with list_in_area)`);
        edits.remove(h.file, h.holder, h.key, `Removal: ${nameOf(ctx, cur.target)}`);
        return [`Removed ${a.object} — ${nameOf(ctx, cur.target)} (${cur.target})`, ...pending(edits)];
      }),
  );

  server.registerTool(
    'world_history',
    {
      title: 'World edit history',
      description: 'Steps of the mod world edits (place / move / remove and interiors: interior_place / interior_move / interior_remove), a history of its own: not mixed with the record history.',
      inputSchema: {},
      annotations: { ...READ, title: 'World edit history' },
    },
    () =>
      run(() => {
        const edits = session.worldEdits();
        const { undo, redo } = edits.history();
        const out = undo.map((l, i) => `#${i + 1} ${l}`);
        if (!out.length) out.push('No world edits');
        if (redo.length) out.push(`can be redone: ${redo.length} (${redo.join(', ')})`);
        out.push(...pending(edits));
        return out;
      }),
  );

  server.registerTool(
    'world_undo',
    {
      title: 'Undo a world edit',
      description: 'Undo (or with redo: true, redo) the latest world edits; steps is how many steps.',
      inputSchema: {
        redo: z.boolean().optional(),
        steps: z.number().int().min(1).max(100).optional(),
      },
      annotations: { ...EDIT, title: 'Undo a world edit' },
    },
    (a) =>
      run(() => {
        const edits = session.worldEdits();
        const out: string[] = [];
        for (let i = 0; i < (a.steps ?? 1); i++) {
          const s = a.redo ? edits.redo() : edits.undo();
          if (!s) break;
          out.push(`${a.redo ? 'redone' : 'undone'}: ${s.label}`);
        }
        if (!out.length) out.push(a.redo ? 'Nothing to redo' : 'Nothing to undo');
        return [...out, ...pending(edits)];
      }),
  );

  registerInteriorTools(server, session, { run, resolveId });
}

function pending(edits: WorldEdits): string[] {
  return edits.isDirty() ? ['not saved: save writes the mod and the level files (leveldata)'] : [];
}

function modLayerOf(session: Session): string | undefined {
  try {
    return session.worldEdits().modLayer;
  } catch {
    return undefined;
  }
}
