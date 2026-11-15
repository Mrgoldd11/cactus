/**
 * World dump of the Kenshi Bridge plugin: zone file formats and the folder listing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DUMP_BUILDING,
  dumpFileName,
  isOutdoorDumpBuilding,
  parseBuildingDump,
  parseDumpFileName,
  parseFoliageDump,
  writeFoliageDump,
} from '../src/index.ts';
import { gameDumpDir, listGameDump, readGameDumpFile } from '../src/node/index.ts';

const sample = () =>
  writeFoliageDump({
    zone: [14, 21],
    meshes: ['1234-rebirth.mod', '77-Newwworld.mod'],
    data: new Float32Array([-80018, 512.5, -47523, 90, 1.25, -80000, 500, -47500, 359.5, 0.5]),
    mesh: new Uint16Array([1, 0]),
    flags: new Uint16Array([0, 1]),
  });

describe('game world dump', () => {
  it('foliage file round trip', () => {
    const d = parseFoliageDump(sample());
    expect(d.zone).toEqual([14, 21]);
    expect(d.meshes).toEqual(['1234-rebirth.mod', '77-Newwworld.mod']);
    expect(d.count).toBe(2);
    expect(Array.from(d.data.subarray(0, 5))).toEqual([-80018, 512.5, -47523, 90, 1.25]);
    expect(Array.from(d.mesh)).toEqual([1, 0]);
    expect(Array.from(d.flags)).toEqual([0, 1]);
  });

  it('broken foliage files are refused', () => {
    const ok = sample();
    expect(() => parseFoliageDump(ok.subarray(0, ok.length - 3))).toThrow(/cut short/);
    const bad = ok.slice();
    bad[0] = 0x58;
    expect(() => parseFoliageDump(bad)).toThrow(/KBF1/);
    expect(() => parseFoliageDump(new Uint8Array(4))).toThrow();
  });

  it('building file', () => {
    const text = JSON.stringify({
      v: 1,
      zone: [14, 21],
      buildings: [
        { id: '55-a.mod', name: 'Torch post', p: [1, 2, 3], q: [1, 0, 0, 0], f: 0, town: 'Fog King throne' },
        { id: '56-a.mod', name: 'Door', p: [1, 2, 3], q: [1, 0, 0, 0], f: DUMP_BUILDING.door },
        { id: '57-a.mod', name: 'no place' },
      ],
    });
    const d = parseBuildingDump(text);
    expect(d.zone).toEqual([14, 21]);
    expect(d.buildings).toHaveLength(2);
    expect(d.buildings[0]).toEqual({ id: '55-a.mod', name: 'Torch post', position: [1, 2, 3], rotation: [1, 0, 0, 0], flags: 0, town: 'Fog King throne' });
    expect(d.buildings.map(isOutdoorDumpBuilding)).toEqual([true, false]);
    expect(() => parseBuildingDump('{"v":2}')).toThrow(/unknown format/);
  });

  it('file names', () => {
    expect(dumpFileName('foliage', 14, 21)).toBe('foliage.14.21.bin');
    expect(parseDumpFileName('buildings.3.63.json')).toEqual({ kind: 'buildings', x: 3, y: 63 });
    expect(parseDumpFileName('foliage.14.21.json')).toBeUndefined();
    expect(parseDumpFileName('foliage.64.1.bin')).toBeUndefined();
    expect(parseDumpFileName('flyover.json')).toBeUndefined();
  });

  it('folder listing and reading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-dump-'));
    try {
      writeFileSync(join(dir, 'foliage.14.21.bin'), sample());
      writeFileSync(join(dir, 'buildings.14.21.json'), '{"v":1,"zone":[14,21],"buildings":[]}');
      writeFileSync(join(dir, 'flyover.json'), '{}');
      const index = listGameDump(dir);
      expect(index.foliage.map((z) => [z.x, z.y])).toEqual([[14, 21]]);
      expect(index.buildings).toHaveLength(1);
      expect(parseFoliageDump(readGameDumpFile('foliage', 14, 21, dir)!).count).toBe(2);
      expect(readGameDumpFile('foliage', 1, 1, dir)).toBeNull();
      expect(readGameDumpFile('foliage', 99, 1, dir)).toBeNull();
      expect(listGameDump(join(dir, 'missing'))).toEqual({ dir: join(dir, 'missing'), foliage: [], buildings: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dump folder', () => {
    expect(gameDumpDir({ KENSHI_BRIDGE_DUMP: 'X:\\d' })).toBe('X:\\d');
    expect(gameDumpDir({ LOCALAPPDATA: 'C:\\L' })).toBe(join('C:\\L', 'KenshiBridge', 'world'));
    expect(gameDumpDir({})).toBeUndefined();
  });
});
