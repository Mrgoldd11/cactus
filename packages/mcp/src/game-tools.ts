/**
 * Инструменты моста к игре (плагин Kenshi Bridge): состояние игры, команды и трассировка диалога.
 * Чтение — свободно; команды, меняющие игру, выполняются только с confirm: true (после согласия пользователя).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatGameState, formatTraceRecord, formatVec3, type GameAction } from '@kenshi-editor/core';
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
      return `перенести выбранного персонажа в ${formatVec3(a.args.pos)}`;
    case 'camera':
      return `поставить камеру в ${formatVec3(a.args.pos)}`;
    case 'speed':
      return a.args.value === 0 ? 'поставить игру на паузу (скорость 0)' : `скорость времени ×${a.args.value}`;
    case 'pause':
      return a.args.on ? 'поставить игру на паузу' : 'снять паузу';
  }
}

export function registerGameTools(server: McpServer, game: GameBridge): void {
  server.registerTool(
    'game_state',
    {
      title: 'Состояние игры',
      description:
        'Что сейчас в запущенной Kenshi (через плагин Kenshi Bridge для RE_Kenshi): выбранный персонаж с шаблоном, фракцией и координатами, его разговор, время, пауза, камера. Только чтение.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false, title: 'Состояние игры' },
    },
    () =>
      guarded(async () => {
        const ping = await game.ping();
        const head = `игра подключена: ${ping.plugin} ${ping.version}, протокол ${ping.protocol}`;
        if (!ping.inGame) return [head, 'игра в меню или загружается'];
        return [head, ...formatGameState(await game.state())];
      }),
  );

  server.registerTool(
    'game_command',
    {
      title: 'Команда игре',
      description:
        'Изменить запущенную игру: teleport (выбранный персонаж в точку), camera (камера в точку), speed (0..20, 0 — пауза), pause. Без confirm: true только показывает, что будет сделано: сначала спросите пользователя, затем повторите с confirm: true.',
      inputSchema: {
        cmd: z.enum(['teleport', 'camera', 'speed', 'pause']),
        pos: vec3.optional().describe('Точка [x, y, z] для teleport и camera (координаты из where или game_state)'),
        value: z.number().min(0).max(20).optional().describe('Скорость для speed'),
        on: z.boolean().optional().describe('Для pause: true — пауза, false — снять'),
        confirm: z.boolean().optional().describe('true — пользователь согласен, выполнить'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, title: 'Команда игре' },
    },
    (a) =>
      guarded(async () => {
        let action: GameAction;
        if (a.cmd === 'teleport' || a.cmd === 'camera') {
          if (!a.pos) throw new Error(`${a.cmd}: нужна точка pos [x, y, z]`);
          action = { cmd: a.cmd, args: { pos: a.pos } };
        } else if (a.cmd === 'speed') {
          if (a.value === undefined) throw new Error('speed: нужно value 0..20');
          action = { cmd: 'speed', args: { value: a.value } };
        } else {
          action = { cmd: 'pause', args: { on: a.on ?? true } };
        }
        const what = describeAction(action);
        if (!a.confirm) return [`не выполнено: ${what}.`, 'Спросите пользователя и повторите с confirm: true.'];
        const r = await game.action(action);
        return [`выполнено: ${what}`, JSON.stringify(r)];
      }),
  );

  let since = 0;
  server.registerTool(
    'game_trace',
    {
      title: 'Трассировка диалога в игре',
      description:
        'Какой диалог игра выбрала на событие и почему выпали соперники (отсеян условиями / не дошла очередь по весу). on — включить (filter player: клики игрока и разговоры с отрядом; all — всё), off — выключить, get — новые записи с прошлого get (since — с номера). Трассировка ничего не меняет в игре.',
      inputSchema: {
        action: z.enum(['on', 'off', 'get']),
        filter: z.enum(['player', 'all']).optional(),
        since: z.number().int().min(0).optional().describe('Номер записи, после которой читать (по умолчанию — с прошлого get)'),
        limit: z.number().int().min(1).optional().describe('Сколько последних записей показать (по умолчанию 10)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, title: 'Трассировка диалога' },
    },
    (a) =>
      guarded(async () => {
        if (a.action !== 'get') {
          const r = await game.setTrace(a.action === 'on', a.filter ?? 'player');
          return [r.on ? `трассировка включена (${r.all ? 'всё' : 'игрок'}); поговорите в игре, затем game_trace get` : 'трассировка выключена'];
        }
        const pageRes = await game.traceGet(a.since ?? since);
        since = pageRes.next;
        const items = pageRes.items.slice(-(a.limit ?? 10));
        if (!items.length) return [`новых записей нет (следующий номер ${pageRes.next})`];
        const out = items.flatMap(formatTraceRecord);
        if (pageRes.items.length > items.length) out.unshift(`показаны последние ${items.length} из ${pageRes.items.length}`);
        return out;
      }),
  );
}
