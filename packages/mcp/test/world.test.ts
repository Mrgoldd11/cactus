/**
 * MCP: инструменты мира — list_in_area, place, move, remove, world_history, world_undo и запись
 * файлов уровня мода инструментом save. Синтетическая «папка игры» с одной зоной ванили.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeText, emptyRecord, encodeText, FileType, itemTypeId, readDataFile, type GameRecord } from '@kenshi-editor/core';
import { defaultWorkshopDir, writeDataFileSync } from '@kenshi-editor/core/node';
import { createServer, Session } from '../src/index.ts';
import { makeFixture, type Fixture } from '../../cli/test/fixture.ts';
import { turn, yawOf } from '../src/world-tools.ts';

const ZONE = 'zone.32.32.zone';

function rec(type: string, sid: string, fill: (r: GameRecord) => void): GameRecord {
  const r = emptyRecord(itemTypeId(type)!, sid, encodeText(sid));
  fill(r);
  return r;
}

let fx: Fixture;
let client: Client;

beforeEach(async () => {
  fx = makeFixture();
  const dir = join(fx.game, 'data', 'newland', 'leveldata');
  mkdirSync(dir, { recursive: true });
  writeDataFileSync(join(dir, ZONE), {
    fileType: FileType.Data,
    lastId: 2,
    tail: new Uint8Array(),
    records: [
      rec('INSTANCE_COLLECTION', '0-buildinglist', (r) => {
        r.instances.set('1-base', { target: 'X', position: [100, 2, 200], rotation: [1, 0, 0, 0], states: [encodeText('1-base-S23')] });
        r.instances.set('2-base', { target: 'Y', position: [150, 0, 250], rotation: [1, 0, 0, 0], states: [] });
      }),
      rec('GAMESTATE_BUILDING', '1-base-S23', (r) => {
        r.floats.set('world Y pos', 502);
        r.strings.set('name', encodeText('Kiosk'));
      }),
    ],
  });
  const session = new Session({ kenshi: fx.game, workshop: defaultWorkshopDir(fx.game) }, fx.game);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(session).connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

afterEach(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError ?? false };
}

describe('kenshi-mcp: мир', () => {
  it('поворот вокруг вертикали: градусы ↔ кватернион', () => {
    expect(yawOf(turn([1, 0, 0, 0], 90))).toBe(90);
    expect(yawOf(turn(turn([1, 0, 0, 0], 90), -135))).toBe(315);
  });

  it('инструменты мира помечены: чтение и правка', async () => {
    const tools = (await client.listTools()).tools;
    const hint = (n: string): boolean | undefined => tools.find((t) => t.name === n)?.annotations?.readOnlyHint;
    expect(hint('list_in_area')).toBe(true);
    expect(hint('world_history')).toBe(true);
    for (const n of ['place', 'move', 'remove', 'world_undo']) expect(hint(n)).toBe(false);
  });

  it('list_in_area → place / move / remove → отмена → save пишет leveldata', async () => {
    const list = await call('list_in_area', { x: 100, z: 200, radius: 100 });
    expect(list.text).toContain('Вокруг 100 200 (зона 32.32), радиус 100: объектов 2');
    expect(list.text).toContain(`${ZONE}|0-buildinglist|1-base — Меч (X) · 0 м · x 100 y 2 z 200 · 0° · здание «Kiosk»`);
    expect((await call('list_in_area', {})).isError).toBe(true);

    await call('open_mod', { mod: 'My' });
    const placed = await call('place', { target: 'Shield', x: 300, z: 320, angle: 90 });
    expect(placed.isError).toBe(false);
    const handle = /Поставлен (\S+)/.exec(placed.text)![1]!;
    expect(handle.startsWith(`${ZONE}|0-buildinglist|`)).toBe(true);

    const moved = await call('move', { object: `${ZONE}|0-buildinglist|1-base`, dx: 10, y: 3, turn: 45 });
    expect(moved.text).toContain('x 110 y 3 z 200 · 45°');
    expect(moved.text).toContain('карты высот нет');
    expect((await call('move', { object: `${ZONE}|0-buildinglist|1-base`, x: 9000 })).isError).toBe(true);
    expect((await call('move', { object: 'nope' })).isError).toBe(true);

    expect((await call('remove', { object: `${ZONE}|0-buildinglist|2-base` })).text).toContain('Убран');
    const after = await call('list_in_area', { x: 100, z: 200, radius: 500 });
    expect(after.text).toContain('объектов 2');
    expect(after.text).toContain('Shield (Y) · ');
    expect(after.text).toContain('изменено в моде');
    expect(after.text).not.toContain('|2-base');

    const hist = await call('world_history');
    expect(hist.text).toContain('#1 Новый объект: Shield');
    expect(hist.text).toContain('#2 Сдвиг: Меч');
    expect(hist.text).toContain('#3 Удаление: Shield');
    expect((await call('world_undo')).text).toContain('отменено: Удаление: Shield');
    expect((await call('world_undo', { redo: true })).text).toContain('повторено: Удаление: Shield');

    const saved = await call('save', { force: true });
    expect(saved.text).toContain(`файлы уровня: leveldata/${ZONE}`);
    const file = readDataFile(readFileSync(join(fx.game, 'mods', 'My', 'leveldata', ZONE)));
    const holder = file.records.find((r) => r.stringId === '0-buildinglist')!;
    expect(holder.instances.get('1-base')!.position).toEqual([110, 3, 200]);
    expect(holder.instances.get('2-base')!.target).toBe('');
    const key = handle.split('|')[2]!;
    expect(holder.instances.get(key)!.target).toBe('Y');
    const state = file.records.find((r) => r.stringId === '1-base-S23')!;
    expect(state.floats.get('world Y pos')).toBe(503);
    expect(decodeText(state.strings.get('name')!)).toBe('Kiosk');
    expect((await call('world_history')).text).not.toContain('не сохранено');
  });
});
