/**
 * Критерий готовности этапа 1: Skeleton Cannibal Friend, собранный через ядро
 * (examples/skeleton-cannibal-friend), совпадает с установленным модом, который собрал
 * tools/build_skeleton_cannibal.py. Без игры или без мода тесты пропускаются.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeText, firstDifference, readDataFile, writeDataFile, type GameRecord } from '@kenshi-editor/core';
import { findInstalledMod, hasGame, resolveGamePaths } from '@kenshi-editor/core/node';
import { runBuild } from '../src/build.ts';
import { Workspace } from '../src/workspace.ts';

const paths = resolveGamePaths();
const installed = hasGame(paths) ? findInstalledMod(paths, 'Skeleton Cannibal Friend.mod') : undefined;
const script = join(import.meta.dirname, '..', 'examples', 'skeleton-cannibal-friend', 'build.ts');
const dir = mkdtempSync(join(tmpdir(), 'kedit-scf-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ws = new Workspace({ cwd: dir, env: process.env });
async function build(out: string, args: string[] = []): Promise<{ bytes: Uint8Array; log: string[] }> {
  const log: string[] = [];
  const r = await runBuild(ws, { source: script, out: join(dir, out), args, force: false }, (l) => log.push(l));
  return { bytes: readFileSync(r.outPath), log };
}

const view = (r: GameRecord): string =>
  JSON.stringify({ ...r, name: decodeText(r.name), strings: [...r.strings].map(([k, v]) => [k, decodeText(v)]) }, (_, v: unknown) =>
    v instanceof Map ? [...(v as Map<unknown, unknown>)] : v,
  );

describe.skipIf(installed === undefined)('Skeleton Cannibal Friend через ядро', () => {
  it('ваниль как у kdata.py: байт в байт как установленный мод', async () => {
    const expected = readFileSync(installed!);
    const { bytes, log } = await build('kdata.mod');
    expect(log, 'в scf_ids.json есть все уникальные записи').toEqual([]);
    expect(bytes.length).toBe(expected.length);
    expect(firstDifference(expected, bytes)).toBe(-1);
  });

  it('ваниль слоями: единственное отличие объяснено', async () => {
    const python = readDataFile(readFileSync(installed!));
    const layered = readDataFile((await build('layered.mod', ['--layered'])).bytes);
    expect(layered.records.map((r) => r.stringId)).toEqual(python.records.map((r) => r.stringId));
    const differ = python.records.filter((r, i) => view(r) !== view(layered.records[i]!)).map((r) => `${r.stringId} «${decodeText(r.name)}»`);
    // «Тюрьма Столицы людоедов» — копия отряда 2609-gamedata.base. kdata.py сливает файлы ванили,
    // дописывая ссылки: в копию попали и Cannibal 5–15 из gamedata.base, и 9–13 из rebirth.mod.
    // Наложением слоёв rebirth.mod заменяет значения ссылки, и остаётся одна: 9–13 (так видит игра).
    expect(differ).toEqual(['301-Skeleton Cannibal Friend.mod «Тюрьма Столицы людоедов»']);
    const i = python.records.findIndex((r) => r.stringId === '301-Skeleton Cannibal Friend.mod');
    const squad = (f: typeof python): unknown => f.records[i]!.refs.get('squad');
    expect(squad(python)).toEqual([
      { target: '2604-gamedata.base', v0: 5, v1: 15, v2: 0 },
      { target: '2604-gamedata.base', v0: 9, v1: 13, v2: 0 },
    ]);
    expect(squad(layered)).toEqual([{ target: '2604-gamedata.base', v0: 9, v1: 13, v2: 0 }]);
    // Других отличий нет: с исправленной ссылкой файлы совпадают байт в байт.
    python.records[i]!.refs.set('squad', [{ target: '2604-gamedata.base', v0: 9, v1: 13, v2: 0 }]);
    expect(firstDifference(writeDataFile(python), writeDataFile(layered))).toBe(-1);
  });
});
