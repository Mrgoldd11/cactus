/**
 * Симулятор разговора на файлах установленной игры. Без игры тесты пропускаются.
 */
import { describe, expect, it } from 'vitest';
import { simulateTalk } from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();

describe.skipIf(!hasGame(paths))('симулятор разговора: ваниль', () => {
  it('трактирщик: торговый диалог из пакета персонажа', () => {
    const { ctx } = loadModContext({ paths, schema: false });
    const sim = simulateTalk(ctx, '1187-gamedata.base');
    const trader = sim.candidates.find((x) => x.dialog === '161-gamedata.quack')!;
    expect(trader.actions).toContain('trade');
    expect(trader.sources[0]!.via).toBe('character-package');
  });
});
