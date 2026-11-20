/**
 * Game bridge tools (the Kenshi Bridge plugin): game state, commands and dialogue trace.
 * Reading is free; commands that change the game run only with confirm: true (after the user agrees).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatDumpStatus, formatFlyoverStatus, formatGameState, formatTraceRecord, formatVec3, type GameAction, type GameFlyoverArgs, type Vec3 } from '@kenshi-editor/core';
import type { GameBridge } from '@kenshi-editor/core/node';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function guarded(fn: () => Promise<string[]>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: (await fn()).join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

function describeAction(a: GameAction): string {
  switch (a.cmd) {
    case 'teleport':
      return `teleport the selected character to ${formatVec3(a.args.pos)}`;
    case 'camera':
      return `move the camera to ${formatVec3(a.args.pos)}`;
    case 'speed':
      return a.args.value === 0 ? 'pause the game (speed 0)' : `game speed ×${a.args.value}`;
    case 'pause':
      return a.args.on ? 'pause the game' : 'unpause the game';
    case 'spawn':
      return `spawn «${a.args.id}» ${a.args.pos ? `at ${formatVec3(a.args.pos)}` : 'at the camera'}${a.args.faction ? ` (faction ${a.args.faction})` : ''}`;
  }
}

export function registerGameTools(server: McpServer, game: GameBridge): void {
  server.registerTool(
    'game_state',
    {
      title: 'Game state',
      description:
        'What is in the running Kenshi now (through the Kenshi Bridge plugin for RE_Kenshi): the selected character with template, faction and coordinates, its conversation, time, pause, camera. Read only.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false, title: 'Game state' },
    },
    () =>
      guarded(async () => {
        const ping = await game.ping();
        const head = `game connected: ${ping.plugin} ${ping.version}, protocol ${ping.protocol}`;
        if (!ping.inGame) return [head, 'the game is in the menu or loading'];
        return [head, ...formatGameState(await game.state())];
      }),
  );

  server.registerTool(
    'game_towns',
    {
      title: 'Towns in the game',
      description:
        'Towns and outposts of the loaded world in the running game: center, border radius, type. near [x, y, z] + range: only near a point. Read only.',
      inputSchema: {
        near: vec3.optional().describe('Point [x, y, z] to search around'),
        range: z.number().gt(0).optional().describe('Distance from near to the town border'),
        mult: z.number().gt(0).max(20).optional().describe('Radius multiplier (default 1)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, title: 'Towns in the game' },
    },
    (a) =>
      guarded(async () => {
        const r = await game.towns({ ...(a.near ? { near: a.near } : {}), ...(a.range !== undefined ? { range: a.range } : {}), ...(a.mult !== undefined ? { mult: a.mult } : {}) });
        const out = [`towns: ${r.count}`];
        for (const t of r.towns) out.push(`${t.name} [${t.stringId}] — ${t.typeName}, radius ${Math.round(t.radius)}, center ${formatVec3(t.pos)}`);
        return out;
      }),
  );

  server.registerTool(
    'game_dump',
    {
      title: 'World dump from the game',
      description:
        'What the Kenshi Bridge plugin has dumped of the loaded world for the editor World view: real places of foliage (trees, rocks, bushes) and all buildings the game holds with every enabled mod, one file per zone, kept between runs. Shows the dump folder, how many of the 4096 zones are on disk and the zones loaded now. now: true writes the loaded zones right away. near [x, y, z] + range lists the foliage and buildings around a point (to compare with the editor). Changes nothing in the game.',
      inputSchema: {
        now: z.boolean().optional().describe('Write everything loaded to disk right away'),
        near: vec3.optional().describe('Point [x, y, z] to list foliage and buildings around'),
        range: z.number().gt(0).max(5000).optional().describe('Distance from near (default 300)'),
        limit: z.number().int().min(1).max(500).optional().describe('How many of each to list (default 60)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, title: 'World dump from the game' },
    },
    (a) =>
      guarded(async () =>
        formatDumpStatus(
          await game.dump({
            ...(a.now ? { now: true } : {}),
            ...(a.near ? { near: a.near } : {}),
            ...(a.range !== undefined ? { range: a.range } : {}),
            ...(a.limit !== undefined ? { limit: a.limit } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    'game_flyover',
    {
      title: 'Map fly-over for the dump',
      description:
        'Fly the game camera over the map zone by zone so that the plugin dumps foliage and buildings of every zone (see game_dump). action: start (rect [x0, y0, x1, y1] in zone indices 0..63, default the whole 64×64 map; zones already dumped are skipped unless force), stop, resume (continue a stopped fly-over, also after a game restart), status. The whole map takes hours and moves the camera all the time: start and resume run only with confirm: true, after the user explicitly asked for it. stop and status are free.',
      inputSchema: {
        action: z.enum(['start', 'stop', 'resume', 'status']),
        rect: z
          .tuple([z.number().int().min(0).max(63), z.number().int().min(0).max(63), z.number().int().min(0).max(63), z.number().int().min(0).max(63)])
          .optional()
          .describe('Zones [x0, y0, x1, y1], inclusive'),
        force: z.boolean().optional().describe('Visit zones that already have dump files too'),
        dwell: z.number().int().min(200).max(60000).optional().describe('Milliseconds to stay over a loaded zone (default 1500)'),
        timeout: z.number().int().min(5).max(600).optional().describe('Seconds to wait for a zone to load (default 40)'),
        confirm: z.boolean().optional().describe('true: the user asked for the fly-over, execute'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, title: 'Map fly-over for the dump' },
    },
    (a) =>
      guarded(async () => {
        const moves = a.action === 'start' || a.action === 'resume';
        if (moves && !a.confirm) {
          const where = a.rect ? `zones ${a.rect[0]}.${a.rect[1]} – ${a.rect[2]}.${a.rect[3]}` : 'the whole map (4096 zones, hours)';
          return [`not done: ${a.action} the camera fly-over of ${a.action === 'resume' ? 'the stopped run' : where}.`, 'Ask the user and repeat with confirm: true.'];
        }
        const args: GameFlyoverArgs = { action: a.action };
        if (a.action === 'start') {
          if (a.rect) args.rect = a.rect;
          if (a.force) args.force = true;
        }
        if (moves) {
          if (a.dwell !== undefined) args.dwell = a.dwell;
          if (a.timeout !== undefined) args.timeout = a.timeout;
        }
        return formatFlyoverStatus(await game.flyover(args));
      }),
  );

  server.registerTool(
    'game_command',
    {
      title: 'Command to the game',
      description:
        'Change the running game: teleport (the selected character to a point), camera (camera to a point), speed (0..20, 0 is pause), pause. Without confirm: true it only shows what would be done: ask the user first, then repeat with confirm: true.',
      inputSchema: {
        cmd: z.enum(['teleport', 'camera', 'speed', 'pause']),
        pos: vec3.optional().describe('Point [x, y, z] for teleport and camera (coordinates from where or game_state)'),
        value: z.number().min(0).max(20).optional().describe('Speed for speed'),
        on: z.boolean().optional().describe('For pause: true to pause, false to unpause'),
        confirm: z.boolean().optional().describe('true: the user agrees, execute'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, title: 'Command to the game' },
    },
    (a) =>
      guarded(async () => {
        let action: GameAction;
        if (a.cmd === 'teleport' || a.cmd === 'camera') {
          if (!a.pos) throw new Error(`${a.cmd}: a point pos [x, y, z] is needed`);
          action = { cmd: a.cmd, args: { pos: a.pos } };
        } else if (a.cmd === 'speed') {
          if (a.value === undefined) throw new Error('speed: value 0..20 is needed');
          action = { cmd: 'speed', args: { value: a.value } };
        } else {
          action = { cmd: 'pause', args: { on: a.on ?? true } };
        }
        const what = describeAction(action);
        if (!a.confirm) return [`not done: ${what}.`, 'Ask the user and repeat with confirm: true.'];
        const r = await game.action(action);
        return [`done: ${what}`, JSON.stringify(r)];
      }),
  );

  server.registerTool(
    'game_spawn',
    {
      title: 'Spawn a character or animal in the game',
      description:
        'Put a character or animal (a CHARACTER record of the vanilla game or a mod, by string id) into the running game: at the camera by default or at pos [x, y, z]. faction: "player" (the faction of the selected character), a FACTION string id, or omitted (the faction named in the record). It adds a real unit to the world: ask the user first. Without confirm: true it only shows what would be done; repeat with confirm: true.',
      inputSchema: {
        id: z.string().describe('String id of the CHARACTER record (find / show give it)'),
        pos: vec3.optional().describe('Point [x, y, z] (default: where the camera looks)'),
        faction: z.string().optional().describe('"player" or a FACTION string id'),
        confirm: z.boolean().optional().describe('true: the user agrees, execute'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, title: 'Spawn in the game' },
    },
    (a) =>
      guarded(async () => {
        const args: { id: string; pos?: Vec3; faction?: string } = { id: a.id };
        if (a.pos) args.pos = a.pos;
        if (a.faction) args.faction = a.faction;
        const action: GameAction = { cmd: 'spawn', args };
        const what = describeAction(action);
        if (!a.confirm) return [`not done: ${what}.`, 'Ask the user and repeat with confirm: true.'];
        const r = await game.action(action);
        return [`done: ${what}`, JSON.stringify(r)];
      }),
  );

  let since = 0;
  server.registerTool(
    'game_trace',
    {
      title: 'Dialogue trace in the game',
      description:
        'Which dialogue the game chose for an event and why the rivals dropped out (filtered by conditions / lost on weight). on turns it on (filter player: player clicks and squad conversations; all: everything), off turns it off, get returns the new entries since the last get (since: from a number). The trace changes nothing in the game.',
      inputSchema: {
        action: z.enum(['on', 'off', 'get']),
        filter: z.enum(['player', 'all']).optional(),
        since: z.number().int().min(0).optional().describe('Number of the entry to read after (default: since the last get)'),
        limit: z.number().int().min(1).optional().describe('How many latest entries to show (default 10)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, title: 'Dialogue trace' },
    },
    (a) =>
      guarded(async () => {
        if (a.action !== 'get') {
          const r = await game.setTrace(a.action === 'on', a.filter ?? 'player');
          return [r.on ? `trace on (${r.all ? 'all' : 'player'}); talk in the game, then game_trace get` : 'trace off'];
        }
        const pageRes = await game.traceGet(a.since ?? since);
        since = pageRes.next;
        const items = pageRes.items.slice(-(a.limit ?? 10));
        if (!items.length) return [`no new entries (next number ${pageRes.next})`];
        const out = items.flatMap(formatTraceRecord);
        if (pageRes.items.length > items.length) out.unshift(`showing the last ${items.length} of ${pageRes.items.length}`);
        return out;
      }),
  );
}
