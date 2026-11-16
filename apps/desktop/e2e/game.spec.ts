/**
 * E2E: game link on a fake Kenshi Bridge plugin (TCP on a free port,
 * `KENSHI_BRIDGE_PORT`). Status bar icon, «Показать в игре» in «Где в игре»,
 * the «Игра» panel and «Как было в игре» in the conversation player.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const shots = join(resolve(appDir, '../..'), 'out', 'screenshots');
mkdirSync(shots, { recursive: true });

const BARMAN = '50638-rebirth.mod';

interface Fake {
  server: Server;
  port: number;
  seen: { cmd: string; args: Record<string, unknown> }[];
}

function fakeGame(): Promise<Fake> {
  const seen: Fake['seen'] = [];
  let traceOn = false;
  const reply = (cmd: string, args: Record<string, unknown>): unknown => {
    switch (cmd) {
      case 'ping':
        return { plugin: 'kenshi-bridge', version: '0.1.0', protocol: 1, inGame: true };
      case 'state':
        return {
          paused: false,
          speed: 1,
          time: { days: 4, hours: 106.5 },
          selected: { name: 'Бип', template: { stringId: BARMAN, name: 'Swamp Barman' }, faction: { name: 'Болотники', stringId: 'f' }, pos: [100, 5, 200] },
          selectedDialogue: null,
          selectedIsPlayer: true,
          camera: { center: [0, 0, 0] },
          playerCharacters: 2,
          trace: traceOn,
          build: 'Steam',
        };
      case 'trace':
        traceOn = args['on'] === true;
        return { on: traceOn, all: false };
      case 'trace_get':
        return {
          // Like the plugin: number of the last entry (no entries before it is turned on).
          next: traceOn ? 1 : 0,
          items:
            traceOn && Number(args['since']) < 1
              ? [
                  {
                    seq: 1,
                    event: 1,
                    wordswap: false,
                    speaker: { name: 'Трактирщик', templateId: BARMAN, player: false },
                    target: { name: 'Бип', templateId: 'p', player: true },
                    chosen: { dialogue: '48721-Dialogue.mod', dialogueName: 'Swamp Barman', line: 'l' },
                    candidates: [
                      { id: '14394-Dialogue (4).mod', name: 'Bandit', score: 30, scoreForTarget: 30, interjection: false, chanceTemporary: 100, chancePermanent: 100, conditions: 'fail', chosen: false },
                      { id: '48721-Dialogue.mod', name: 'Swamp Barman', score: 10, scoreForTarget: 10, interjection: false, chanceTemporary: 100, chancePermanent: 100, conditions: 'pass', chosen: true },
                    ],
                    checks: [],
                  },
                ]
              : [],
        };
      default:
        return { done: cmd };
    }
  };
  const server = createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, i)) as { id: number; cmd: string; args: Record<string, unknown> };
        buf = buf.slice(i + 1);
        seen.push({ cmd: req.cmd, args: req.args });
        sock.write(`${JSON.stringify({ id: req.id, ok: true, result: reply(req.cmd, req.args) })}\n`);
      }
    });
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      done({ server, port: typeof a === 'object' && a ? a.port : 0, seen });
    });
  });
}

test('game link: icon, Show in game, Game panel, How it was in game', async () => {
  const fake = await fakeGame();
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env['KEDIT_USER_DATA'] = userData;
  env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');
  env['KENSHI_BRIDGE_PORT'] = String(fake.port);
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('game-link')).toHaveAttribute('data-state', 'game', { timeout: 10_000 });

    // «Где в игре»: the game camera goes to the trader point.
    await page.getByTestId('search').fill('katana');
    await page.getByTestId('record-list').locator('[data-sid="476-gamedata.base"]').click();
    await page.getByTestId('tab-where').click();
    const place = page.locator('[data-testid="where-place"][data-place="1078-gamedata.base"]').first();
    await expect(place).toBeAttached({ timeout: 60_000 });
    // The point list is collapsed if there are many.
    await place.evaluate((tr) => {
      const d = tr.closest('details');
      if (d) d.open = true;
    });
    await expect(place).toBeVisible();
    await place.getByTestId('show-in-game').click();
    await expect.poll(() => fake.seen.filter((s) => s.cmd === 'camera').length).toBe(1);
    const cam = fake.seen.find((s) => s.cmd === 'camera');
    expect(Array.isArray(cam?.args['pos'])).toBe(true);
    expect(fake.seen.some((s) => s.cmd === 'teleport')).toBe(false);

    // «Игра» panel: the selected character, its template as a link, the trace.
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-panel-game').click();
    const panel = page.getByTestId('game-panel');
    await expect(panel).toHaveAttribute('data-state', 'game');
    await expect(panel.getByTestId('game-selected')).toContainText('Бип');
    await expect(panel.getByTestId('game-selected')).toContainText(BARMAN);
    await panel.getByTestId('game-trace-toggle').click();
    await expect(panel.getByTestId('game-trace-record')).toBeVisible();
    await page.screenshot({ path: join(shots, '40-game-panel.png') });

    // Player: «как было в игре» next to the editor calculation.
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    await page.getByTestId('search').fill(BARMAN);
    await page.getByTestId('record-list').locator(`[data-sid="${BARMAN}"]`).click();
    const player = page.getByTestId('player');
    await expect(player).toHaveAttribute('data-sid', BARMAN);
    const asIn = player.getByTestId('as-in-game');
    await expect(asIn.locator('[data-cand="48721-Dialogue.mod"]')).toHaveAttribute('data-status', 'chosen');
    await expect(asIn.locator('[data-cand="14394-Dialogue (4).mod"]')).toHaveAttribute('data-status', 'fail');
    // By default the editor treats conditions as met and picks the bandit — the mismatch is visible.
    await expect(asIn.getByTestId('as-in-game-verdict')).toContainText('другой диалог');
    await player.getByTestId('pl-mode').selectOption('none');
    await expect(asIn.getByTestId('as-in-game-verdict')).toContainText('совпадает');
    await page.screenshot({ path: join(shots, '41-as-in-game.png') });
  } finally {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
      })
      .catch(() => undefined);
    await app.close();
    fake.server.close();
  }
});
