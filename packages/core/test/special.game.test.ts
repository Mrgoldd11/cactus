/**
 * Специальные редакторы (этап 5) на ванили установленной игры. Без игры тесты пропускаются.
 */
import { describe, expect, it } from 'vitest';
import { factionMatrix, type Layer, type ModContext } from '../src/index.ts';
import { hasGame, loadModContext, loadVanillaLayers, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);

let vanillaCache: Layer[] | undefined;
const vanilla = (): Layer[] => (vanillaCache ??= loadVanillaLayers(paths));
let ctxCache: ModContext | undefined;
const ctx = (): ModContext => (ctxCache ??= loadModContext({ paths, dependencies: [], vanilla: vanilla(), schema: false }).ctx);

describe.skipIf(!game)('специальные редакторы на ванили', () => {
  it('матрица отношений: Священная нация враждует с Объединёнными городами', () => {
    const m = factionMatrix(ctx());
    expect(m.factions.length).toBeGreaterThan(90);
    const hn = m.factions.find((f) => f.sid === '1083-gamedata.base')!;
    expect(hn.name).toBe('The Holy Nation');
    expect(m.cell('1083-gamedata.base', 'defaultEmpireFactionSID')).toMatchObject({ value: -100, explicit: true, kind: 'enemy' });
    // Ваниль — не «моды»: кто поменял — пусто.
    expect(m.layers).toEqual([]);
  });
});
