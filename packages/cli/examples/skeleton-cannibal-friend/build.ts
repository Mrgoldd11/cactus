/**
 * Сборка «Skeleton Cannibal Friend» через ядро: `kedit build examples/skeleton-cannibal-friend/build.ts --out out/…`.
 *
 * Режимы:
 * - по умолчанию — ваниль как её видел tools/kdata.py (четыре файла слиты в одну запись, см. kdata.ts):
 *   файл совпадает с собранным Python-сборщиком байт в байт;
 * - `-- --layered` — ваниль настоящим наложением слоёв (как в игре). Отличия от Python-файла
 *   разобраны в test/scf.game.test.ts.
 *
 * Постоянные id — из scf_ids.json рядом (копия tools/scf_ids.json, только чтение). Если появились
 * новые уникальные пары (тип, имя), сборщик пишет об этом: их номера надо добавить в таблицу.
 */
import { readFileSync } from 'node:fs';
import { ModContext, type GameRecord } from '@kenshi-editor/core';
import type { BuildEnv } from '../../src/build.ts';
import { kdataLayer, kdataMerge } from './kdata.ts';
import { buildSkeletonCannibalFriend, MOD_FILE, type ScfIds, type ScfSource } from './mod.ts';

export default function build(env: BuildEnv): ModContext {
  const pinned = JSON.parse(readFileSync(new URL('./scf_ids.json', import.meta.url), 'utf8')) as ScfIds;
  let ctx: ModContext;
  let src: ScfSource;
  if (env.args.includes('--layered')) {
    ({ ctx } = env.open({ name: MOD_FILE, dependencies: [], po: false }));
    const layered = ctx;
    src = {
      get: (sid) => layered.lower(sid),
      *all() {
        const seen = new Set<string>();
        for (const layer of layered.layers) {
          for (const r of layer.file.records) {
            if (seen.has(r.stringId)) continue;
            seen.add(r.stringId);
            const rec = layered.lower(r.stringId);
            if (rec) yield rec;
          }
        }
      },
    };
  } else {
    const merged = kdataMerge(env.vanilla());
    ctx = new ModContext({ layers: [kdataLayer(merged)], modName: MOD_FILE });
    src = { get: (sid) => merged.get(sid), all: (): Iterable<GameRecord> => merged.values() };
  }
  const r = ctx.transaction('Skeleton Cannibal Friend', () => buildSkeletonCannibalFriend(ctx, src, pinned));
  if (r.added.length) env.log(`scf_ids.json: новые ключи (добавьте в таблицу, next=${r.ids.next}): ${r.added.join('; ')}`);
  return ctx;
}
