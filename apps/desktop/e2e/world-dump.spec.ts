/**
 * E2E: the World panel takes foliage and buildings from the game dump of the Kenshi Bridge plugin.
 * The dump here is synthetic (written by the test into a temporary folder, `KENSHI_BRIDGE_DUMP`):
 * rocks on rings around the camera, campfires the editor data does not have, and a record of an
 * unknown mod. Screenshot: `out/screenshots/70-world-dump.png`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { dumpFileName, writeFoliageDump, ZONE_SIZE } from '@kenshi-editor/core';

const appDir = resolve(import.meta.dirname, '..');
const shots = join(resolve(appDir, '../..'), 'out', 'screenshots');
mkdirSync(shots, { recursive: true });

const ROCK = '43870-Newwworld.mod'; // FOLIAGE_MESH "MonuRock01 Lower slopes"
const CAMPFIRE = '16848-nodes_otto1.mod'; // BUILDING "Campfire"

async function stat(page: Page, name: string): Promise<number> {
  return Number(await page.getByTestId('world-stats').getAttribute(`data-${name}`));
}

const zoneOf = (v: number): number => Math.floor(v / ZONE_SIZE) + 32;

test('World panel: foliage and buildings from the game dump', async () => {
  test.setTimeout(300_000);
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const dump = mkdtempSync(join(tmpdir(), 'kedit-dump-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env['KEDIT_USER_DATA'] = userData;
  env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');
  env['KENSHI_BRIDGE_DUMP'] = dump;
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 950 }).catch(() => undefined);
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-scene').click();
    const view = page.getByTestId('world-view');
    await expect(view).toHaveAttribute('data-ready', 'yes', { timeout: 90_000 });

    // Down to the ground near the Hub: the scatter gives some foliage, none of it "from the game".
    await page.getByTestId('world-search').fill('Хаб');
    await page.getByTestId('world-search').press('Enter');
    await page.waitForTimeout(4000);
    const box = (await page.getByTestId('world-canvas').boundingBox())!;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.3);
    await page.waitForTimeout(3000);
    await page.keyboard.press('Escape');
    await expect.poll(() => stat(page, 'models'), { timeout: 60_000 }).toBeGreaterThan(5);
    expect(await stat(page, 'foliage-game')).toBe(0);
    expect(await stat(page, 'dump-zones')).toBe(0);

    // The "game" dumps the zones around the camera.
    const [cx, cy, cz] = (await page.getByTestId('world-stats').getAttribute('data-camera'))!.split(',').map(Number) as [number, number, number];
    const zones = new Map<string, { x: number; y: number; data: number[] }>();
    let placed = 0;
    for (const radius of [300, 700, 1200, 2000])
      for (let a = 0; a < 24; a++) {
        const x = cx + Math.cos((a / 24) * Math.PI * 2) * radius;
        const z = cz + Math.sin((a / 24) * Math.PI * 2) * radius;
        const k = `${zoneOf(x)}.${zoneOf(z)}`;
        let zone = zones.get(k);
        if (!zone) zones.set(k, (zone = { x: zoneOf(x), y: zoneOf(z), data: [] }));
        zone.data.push(x, cy - 150, z, a * 15, 1);
        placed++;
      }
    for (const zone of zones.values()) {
      const n = zone.data.length / 5;
      writeFileSync(
        join(dump, dumpFileName('foliage', zone.x, zone.y)),
        writeFoliageDump({ zone: [zone.x, zone.y], meshes: [ROCK], data: new Float32Array(zone.data), mesh: new Uint16Array(n), flags: new Uint16Array(n) }),
      );
    }
    const zx = zoneOf(cx);
    const zy = zoneOf(cz);
    writeFileSync(
      join(dump, dumpFileName('buildings', zx, zy)),
      JSON.stringify({
        v: 1,
        zone: [zx, zy],
        buildings: [
          // A ring of campfires: some of them are in front of the camera wherever it looks.
          ...Array.from({ length: 8 }, (_, a) => ({
            id: CAMPFIRE,
            name: 'Campfire',
            p: [cx + Math.cos((a / 8) * Math.PI * 2) * 250, cy - 150, cz + Math.sin((a / 8) * Math.PI * 2) * 250],
            q: [1, 0, 0, 0],
            f: 0,
          })),
          { id: CAMPFIRE, name: 'Campfire inside', p: [cx + 40, cy - 150, cz], q: [1, 0, 0, 0], f: 1 },
          { id: '1-no such mod.mod', name: 'Torch of another mod', p: [cx - 30, cy - 150, cz], q: [1, 0, 0, 0], f: 0 },
        ],
      }),
    );

    // The panel re-reads the zone list every 20 s and switches these zones to the dump.
    await expect.poll(() => stat(page, 'dump-zones'), { timeout: 60_000 }).toBeGreaterThan(0);
    await expect.poll(() => stat(page, 'foliage-game'), { timeout: 60_000 }).toBeGreaterThan(20);
    expect(await stat(page, 'foliage-game')).toBeLessThanOrEqual(placed);
    // Buildings the opened data does not have (other mods) stay hidden until the box is ticked.
    await page.waitForTimeout(3000);
    expect(await stat(page, 'dump-buildings')).toBe(0);
    await page.getByTestId('world-game-buildings').check();
    // Interior entries are not drawn; the campfire is, the unknown record is counted as "no model".
    await expect.poll(() => stat(page, 'dump-buildings'), { timeout: 30_000 }).toBe(9);
    await expect.poll(() => stat(page, 'dump-buildings-no-model'), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => stat(page, 'dump-buildings-drawn'), { timeout: 30_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(shots, '70-world-dump.png') });
    console.log('dump stats', {
      foliage: await stat(page, 'foliage'),
      fromGame: await stat(page, 'foliage-game'),
      drawn: await stat(page, 'foliage-drawn'),
      buildings: await stat(page, 'dump-buildings'),
      buildingsDrawn: await stat(page, 'dump-buildings-drawn'),
    });
  } finally {
    await app.close();
  }
});
