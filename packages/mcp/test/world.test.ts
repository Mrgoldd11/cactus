/**
 * MCP: world tools — list_in_area, place, move, remove, world_history, world_undo, interiors
 * (interior, interior_place / _move / _remove) and writing the mod level files with the save tool.
 * A synthetic "game folder" with one zone and one vanilla interior.
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
  // Interior of building X: layout "Hall" with one object (Y) on floor 0.
  writeDataFileSync(join(dir, 'interiors.level'), {
    fileType: FileType.Data,
    lastId: 11,
    tail: new Uint8Array(),
    records: [
      rec('INSTANCE_COLLECTION', 'X-Hall', (r) => {
        r.name = encodeText('Hall');
        r.strings.set('associated building', encodeText('X'));
        r.bools.set('is exterior', false);
        r.instances.set('10-base', { target: 'Y', position: [1, 50, 2], rotation: [1, 0, 0, 0], states: [encodeText('10-base-S23')] });
      }),
      rec('GAMESTATE_BUILDING', '10-base-S23', (r) => r.ints.set('floornum', 0)),
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

describe('kenshi-mcp: world', () => {
  it('rotation around the vertical: degrees ↔ quaternion', () => {
    expect(yawOf(turn([1, 0, 0, 0], 90))).toBe(90);
    expect(yawOf(turn(turn([1, 0, 0, 0], 90), -135))).toBe(315);
  });

  it('world tools are marked: reading and editing', async () => {
    const tools = (await client.listTools()).tools;
    const hint = (n: string): boolean | undefined => tools.find((t) => t.name === n)?.annotations?.readOnlyHint;
    expect(hint('list_in_area')).toBe(true);
    expect(hint('world_history')).toBe(true);
    expect(hint('interior')).toBe(true);
    for (const n of ['place', 'move', 'remove', 'world_undo', 'interior_place', 'interior_move', 'interior_remove']) expect(hint(n)).toBe(false);
  });

  it('list_in_area → place / move / remove → undo → save writes leveldata', async () => {
    const list = await call('list_in_area', { x: 100, z: 200, radius: 100 });
    expect(list.text).toContain('Around 100 200 (zone 32.32), radius 100: objects 2');
    expect(list.text).toContain(`${ZONE}|0-buildinglist|1-base — Меч (X) · 0 m · x 100 y 2 z 200 · 0° · building "Kiosk"`);
    expect((await call('list_in_area', {})).isError).toBe(true);

    await call('open_mod', { mod: 'My' });
    const placed = await call('place', { target: 'Shield', x: 300, z: 320, angle: 90 });
    expect(placed.isError).toBe(false);
    const handle = /Placed (\S+)/.exec(placed.text)![1]!;
    expect(handle.startsWith(`${ZONE}|0-buildinglist|`)).toBe(true);

    const moved = await call('move', { object: `${ZONE}|0-buildinglist|1-base`, dx: 10, y: 3, turn: 45 });
    expect(moved.text).toContain('x 110 y 3 z 200 · 45°');
    expect(moved.text).toContain('no height map');
    expect((await call('move', { object: `${ZONE}|0-buildinglist|1-base`, x: 9000 })).isError).toBe(true);
    expect((await call('move', { object: 'nope' })).isError).toBe(true);

    expect((await call('remove', { object: `${ZONE}|0-buildinglist|2-base` })).text).toContain('Removed');
    const after = await call('list_in_area', { x: 100, z: 200, radius: 500 });
    expect(after.text).toContain('objects 2');
    expect(after.text).toContain('Shield (Y) · ');
    expect(after.text).toContain('changed in the mod');
    expect(after.text).not.toContain('|2-base');

    const hist = await call('world_history');
    expect(hist.text).toContain('#1 New object: Shield');
    expect(hist.text).toContain('#2 Move: Меч');
    expect(hist.text).toContain('#3 Removal: Shield');
    expect((await call('world_undo')).text).toContain('undone: Removal: Shield');
    expect((await call('world_undo', { redo: true })).text).toContain('redone: Removal: Shield');

    const saved = await call('save', { force: true });
    expect(saved.text).toContain(`level files: leveldata/${ZONE}`);
    const file = readDataFile(readFileSync(join(fx.game, 'mods', 'My', 'leveldata', ZONE)));
    const holder = file.records.find((r) => r.stringId === '0-buildinglist')!;
    expect(holder.instances.get('1-base')!.position).toEqual([110, 3, 200]);
    expect(holder.instances.get('2-base')!.target).toBe('');
    const key = handle.split('|')[2]!;
    expect(holder.instances.get(key)!.target).toBe('Y');
    const state = file.records.find((r) => r.stringId === '1-base-S23')!;
    expect(state.floats.get('world Y pos')).toBe(503);
    expect(decodeText(state.strings.get('name')!)).toBe('Kiosk');
    expect((await call('world_history')).text).not.toContain('not saved');
  });

  it('interior: layouts, objects, jump from the world; edits in the mod interiors.level', async () => {
    const world = await call('interior', { building: `${ZONE}|0-buildinglist|1-base` });
    expect(world.isError, world.text).toBe(false);
    expect(world.text).toContain('"Меч" (X): layouts 1');
    expect(world.text).toContain('X-Hall — "Hall": objects 1  ← shown');
    expect(world.text).toContain('has no named layout: the game picks one itself');
    expect(world.text).toContain('in the world it is named for 0 buildings; 1 more of 1');
    expect(world.text).toContain('interiors.level|X-Hall|10-base — Shield (Y) · other · x 1 y 50 z 2 · 0° · floor 0');
    expect((await call('interior', { building: 'Sword', layout: 'nope' })).isError).toBe(true);

    await call('open_mod', { mod: 'My' });
    const made = await call('edit', { label: 'кровать', ops: [{ op: 'create', type: 'BUILDING', name: 'Bed', as: '$b' }] });
    const bed = /\$b = (\S+)/.exec(made.text)![1]!;
    const placed = await call('interior_place', { target: bed, layout: 'X-Hall', x: 5, y: 51, z: 5, angle: 90 });
    expect(placed.isError, placed.text).toBe(false);
    expect(placed.text).toContain('furniture · x 5 y 51 z 5 · 90° · floor 0');
    expect(placed.text).toContain('the state was built from scratch');
    expect((await call('interior_place', { target: 'Sword', layout: 'X-Hall', x: 0, y: 0, z: 0 })).isError).toBe(true);
    const handle = /Placed (\S+)/.exec(placed.text)![1]!;
    expect((await call('interior_move', { object: 'interiors.level|X-Hall|10-base', dy: 10, turn: 180 })).text).toContain('x 1 y 60 z 2 · 180°');
    expect((await call('interior_remove', { object: handle })).text).toContain('Removed');
    expect((await call('interior_remove', { object: 'zone|a|b' })).isError).toBe(true);
    expect((await call('world_history')).text).toContain('#3 From an interior: Bed');
    await call('world_undo');

    const saved = await call('save', { force: true });
    expect(saved.text).toContain('leveldata/interiors.level');
    const file = readDataFile(readFileSync(join(fx.game, 'mods', 'My', 'leveldata', 'interiors.level')));
    const hall = file.records.find((r) => r.stringId === 'X-Hall')!;
    expect(hall.instances.get('10-base')!.position).toEqual([1, 60, 2]);
    expect(decodeText(hall.strings.get('associated building')!)).toBe('X');
    const key = handle.split('|')[2]!;
    expect(hall.instances.get(key)!.target).toBe(bed);
    const st = file.records.find((r) => r.stringId === `${key}-S23`)!;
    expect(decodeText(st.strings.get('name')!)).toBe('Bed');
    // The zone is untouched: the mod has no zone file.
    expect(saved.text).not.toContain(ZONE);
  });
});
