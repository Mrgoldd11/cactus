/**
 * Инструменты мира: что стоит вокруг точки или города (`list_in_area`), поставить / сдвинуть /
 * убрать объект (`place`, `move`, `remove`), история и отмена правок мира (`world_history`,
 * `world_undo`). Правки — в файлах уровня мода (`leveldata/zone.X.Y.zone`), пишутся вместе с
 * модом инструментом save. y везде — высота над землёй (как в файлах игры).
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

/** Объект мира одной строкой: `файл|владелец|ключ` (так его принимают move и remove). */
export function objectHandle(p: { file: string; holder: string; key: string }): string {
  return `${p.file}|${p.holder}|${p.key}`;
}

function parseHandle(spec: string): { file: string; holder: string; key: string } {
  const parts = spec.split('|');
  if (parts.length !== 3 || parts.some((s) => s === '')) throw new SessionError(`Объект «${spec}»: нужен вид файл|владелец|ключ (как в list_in_area)`);
  const [file, holder, key] = parts as [string, string, string];
  return { file, holder, key };
}

/** Угол поворота вокруг вертикали в градусах (из кватерниона w, x, y, z). */
export function yawOf(q: Vec4): number {
  const [w, x, y, z] = q;
  const deg = (Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y)) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}

/** Повернуть кватернион вокруг вертикали на `deg` градусов (наклон сохраняется). */
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

  /** Точка «рядом с»: город или размещённая запись по id или имени. */
  const centreOf = (ctx: ModContext, spec: string): { x: number; z: number; label: string } => {
    const id = resolveId(ctx, spec, ['TOWN', 'BUILDING']);
    const w = session.world();
    const p = w.towns(id)[0] ?? w.instancesOf(id)[0];
    if (!p) throw new SessionError(`«${nameOf(ctx, id)}» (${id}) не размещена в мире`);
    return { x: p.position[0], z: p.position[2], label: `${nameOf(ctx, id)} (${id})` };
  };

  const line = (ctx: ModContext, p: Placement, d: number | undefined, modLayer: string | undefined): string => {
    const b = buildingOf(p);
    const parts = [
      `${objectHandle(p)} — ${nameOf(ctx, p.target)} (${p.target})`,
      ...(d !== undefined ? [`${Math.round(d)} м`] : []),
      `x ${round(p.position[0])} y ${round(p.position[1])} z ${round(p.position[2])}`,
      `${yawOf(p.rotation)}°`,
    ];
    if (b?.name) parts.push(`здание «${b.name}»`);
    if (modLayer !== undefined && p.layer === modLayer) parts.push('изменено в моде');
    return parts.join(' · ');
  };

  server.registerTool(
    'list_in_area',
    {
      title: 'Объекты мира вокруг точки',
      description: [
        'Что стоит в мире вокруг точки (x, z) или рядом с городом / зданием (near — id или имя, англ. или рус.): здания, стены, предметы.',
        'Каждый объект — строкой «файл|владелец|ключ» (её принимают move и remove), запись, расстояние, позиция (y у объектов зон — над землёй; у городов из leveldata.level — как в файле), поворот в градусах.',
        'С несохранёнными правками мира мода (place / move / remove).',
      ].join('\n'),
      inputSchema: {
        near: z.string().optional().describe('Город или запись (id или имя): центр поиска'),
        x: z.number().optional(),
        z: z.number().optional(),
        radius: z.number().positive().max(20000).optional().describe('Радиус, по умолчанию 300'),
        target: z.string().optional().describe('Только объекты этой записи (id или имя)'),
        limit: z.number().int().min(1).max(500).optional().describe('Сколько показать (по умолчанию 50, ближние первыми)'),
      },
      annotations: { ...READ, title: 'Объекты мира вокруг точки' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        let c: { x: number; z: number; label: string };
        if (a.near !== undefined) c = centreOf(ctx, a.near);
        else if (a.x !== undefined && a.z !== undefined) c = { x: a.x, z: a.z, label: `${Math.round(a.x)} ${Math.round(a.z)}` };
        else throw new SessionError('Укажите near (город или запись) или x и z');
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
        const out = [`Вокруг ${c.label} (зона ${zone.x}.${zone.y}), радиус ${r}: объектов ${hits.length}`];
        for (const { p, d } of hits.slice(0, limit)) out.push(line(ctx, p, d, modLayer));
        if (hits.length > limit) out.push(`… ещё ${hits.length - limit} (limit или меньший radius)`);
        return out;
      }),
  );

  server.registerTool(
    'place',
    {
      title: 'Поставить объект в мир',
      description: [
        'Поставить в мир экземпляр записи (здание, стену, ящик, мебель…) в точку (x, z); y — высота над землёй (по умолчанию 0), angle — поворот вокруг вертикали в градусах.',
        'Пишется в файл зоны мода (leveldata/zone.X.Y.zone) при save; отмена — world_undo.',
        'Здание ставится готовым (состояние GAMESTATE_BUILDING: is complete, материалы из записи) — без него игра делает стройплощадку «на продажу». Фракции, жителей и раскладки интерьера нет: интерьер игра выбирает сама.',
      ].join('\n'),
      inputSchema: {
        target: z.string().describe('Что поставить: id или имя записи (англ. или рус.)'),
        x: z.number(),
        z: z.number(),
        y: z.number().optional().describe('Высота над землёй, по умолчанию 0'),
        angle: z.number().optional().describe('Поворот вокруг вертикали, градусы'),
      },
      annotations: { ...EDIT, title: 'Поставить объект в мир' },
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
        // Высота в мире для состояния здания: земля по карте высот игры + y.
        const g = await session.groundAt([{ x: a.x, z: a.z }]);
        const states = newBuildingStates(ctx.get(target), (g?.[0] ?? 0) + (a.y ?? 0));
        if (states && !g) notes.push('карты высот нет: world Y pos = y (игра может поставить здание не на ту высоту)');
        const key = edits.place(path, holder, target, [a.x, a.y ?? 0, a.z], rotation, states ? { states } : {}, `Новый объект: ${nameOf(ctx, target)}`);
        return [`Поставлен ${objectHandle({ file: path, holder, key })} — ${nameOf(ctx, target)} (${target})`, ...notes, ...pending(edits)];
      }),
  );

  server.registerTool(
    'move',
    {
      title: 'Сдвинуть / повернуть объект мира',
      description: [
        'Сдвинуть или повернуть объект мира (object — строка «файл|владелец|ключ» из list_in_area).',
        'x, z — новое место (или dx, dz — сдвиг); y — высота над землёй; angle — поворот вокруг вертикали в градусах (или turn — повернуть на).',
        'Только в пределах той же зоны (4608 × 4608): в другую — remove и place. У здания с состоянием высота в мире (world Y pos) пересчитывается по рельефу.',
      ].join('\n'),
      inputSchema: {
        object: z.string(),
        x: z.number().optional(),
        z: z.number().optional(),
        dx: z.number().optional(),
        dz: z.number().optional(),
        y: z.number().optional().describe('Высота над землёй'),
        angle: z.number().optional().describe('Поворот вокруг вертикали, градусы (абсолютный)'),
        turn: z.number().optional().describe('Повернуть на столько градусов'),
      },
      annotations: { ...EDIT, title: 'Сдвинуть / повернуть объект мира' },
    },
    (a) =>
      run(async () => {
        const ctx = session.ctx();
        const edits = session.worldEdits();
        const h = parseHandle(a.object);
        const cur = edits.instance(h.file, h.holder, h.key);
        if (!cur) throw new SessionError(`Нет объекта ${a.object} (list_in_area — найти)`);
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
          // Высота в мире: прежняя + подъём над землёй + перепад рельефа.
          let dg = 0;
          if (x !== x0 || z !== z0) {
            const g = await session.groundAt([{ x: x0, z: z0 }, { x, z }]);
            if (g) dg = g[1]! - g[0]!;
            else notes.push('карты высот нет: world Y pos сдвинут без учёта рельефа');
          }
          worldY = b.worldY + (y - y0) + dg;
        }
        const turned = rotation !== cur.rotation;
        const step = x !== x0 || z !== z0 || y !== y0 ? 'Сдвиг' : turned ? 'Поворот' : undefined;
        if (!step) return ['Ничего не меняется: укажите x / z / dx / dz / y / angle / turn'];
        edits.move(h.file, h.holder, h.key, [x, y, z], rotation, worldY !== undefined ? { worldY } : {}, `${step}: ${nameOf(ctx, cur.target)}`);
        const moved = placementOf(h);
        return [moved ? line(ctx, moved, undefined, undefined) : a.object, ...notes, ...pending(edits)];
      }),
  );

  server.registerTool(
    'remove',
    {
      title: 'Убрать объект из мира',
      description: 'Убрать объект мира (object — «файл|владелец|ключ» из list_in_area). Объект ванили или другого мода мод убирает пустой записью поверх; отмена — world_undo.',
      inputSchema: { object: z.string() },
      annotations: { ...EDIT, title: 'Убрать объект из мира' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const edits = session.worldEdits();
        const h = parseHandle(a.object);
        const cur = edits.instance(h.file, h.holder, h.key);
        if (!cur) throw new SessionError(`Нет объекта ${a.object} (list_in_area — найти)`);
        edits.remove(h.file, h.holder, h.key, `Удаление: ${nameOf(ctx, cur.target)}`);
        return [`Убран ${a.object} — ${nameOf(ctx, cur.target)} (${cur.target})`, ...pending(edits)];
      }),
  );

  server.registerTool(
    'world_history',
    {
      title: 'История правок мира',
      description: 'Шаги правок мира мода (place / move / remove и интерьеры: interior_place / interior_move / interior_remove), своя история — не путается с history записей.',
      inputSchema: {},
      annotations: { ...READ, title: 'История правок мира' },
    },
    () =>
      run(() => {
        const edits = session.worldEdits();
        const { undo, redo } = edits.history();
        const out = undo.map((l, i) => `#${i + 1} ${l}`);
        if (!out.length) out.push('Правок мира нет');
        if (redo.length) out.push(`можно повторить: ${redo.length} (${redo.join(', ')})`);
        out.push(...pending(edits));
        return out;
      }),
  );

  server.registerTool(
    'world_undo',
    {
      title: 'Отменить правку мира',
      description: 'Отменить (или с redo: true — повторить) последние правки мира; steps — сколько шагов.',
      inputSchema: {
        redo: z.boolean().optional(),
        steps: z.number().int().min(1).max(100).optional(),
      },
      annotations: { ...EDIT, title: 'Отменить правку мира' },
    },
    (a) =>
      run(() => {
        const edits = session.worldEdits();
        const out: string[] = [];
        for (let i = 0; i < (a.steps ?? 1); i++) {
          const s = a.redo ? edits.redo() : edits.undo();
          if (!s) break;
          out.push(`${a.redo ? 'повторено' : 'отменено'}: ${s.label}`);
        }
        if (!out.length) out.push(a.redo ? 'Нечего повторять' : 'Нечего отменять');
        return [...out, ...pending(edits)];
      }),
  );

  registerInteriorTools(server, session, { run, resolveId });
}

function pending(edits: WorldEdits): string[] {
  return edits.isDirty() ? ['не сохранено: save запишет мод и файлы уровня (leveldata)'] : [];
}

function modLayerOf(session: Session): string | undefined {
  try {
    return session.worldEdits().modLayer;
  } catch {
    return undefined;
  }
}
