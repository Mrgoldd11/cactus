/**
 * E2E: «Add animations» on the real game data. A .skeleton «exported from Blender» is built here from
 * the bones of the vanilla human skeleton plus own clips. Races → Greenlander → «Add animations…» →
 * a file with a broken bone hierarchy blocks «Add» → a good file: bones fit, the new clip is ticked, a
 * clip the game already has is not → «Add» copies the file into `<game>/mods/<mod>/animations/`, makes
 * the records as one undo step and plays the new clip in «Model» → another file of the same name asks
 * before overwriting and can be kept under a new name.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { parseOgreSkeleton, type OgreSkeleton } from '@kenshi-editor/core';
import { resolveGamePaths } from '@kenshi-editor/core/node';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots');
mkdirSync(shots, { recursive: true });

const GREENLANDER = '17-gamedata.quack';
const MOD = 'KeditE2E Anims';
const FILE = 'e2e_anims.skeleton';

/** Minimal Ogre skeleton writer: bones, parents, clips with rotation keys on one bone. */
function writeSkeleton(bones: OgreSkeleton['bones'], parentOf: (i: number) => number, clips: { name: string; bone: number }[]): Buffer {
  const parts: Buffer[] = [];
  const chunk = (id: number, body: Buffer): void => {
    const head = Buffer.alloc(6);
    head.writeUInt16LE(id, 0);
    head.writeUInt32LE(6 + body.length, 2);
    parts.push(head, body);
  };
  const floats = (...v: number[]): Buffer => {
    const b = Buffer.alloc(v.length * 4);
    v.forEach((x, i) => b.writeFloatLE(x, i * 4));
    return b;
  };
  const u16 = (...v: number[]): Buffer => {
    const b = Buffer.alloc(v.length * 2);
    v.forEach((x, i) => b.writeUInt16LE(x, i * 2));
    return b;
  };
  const line = (s: string): Buffer => Buffer.from(`${s}\n`, 'latin1');
  parts.push(u16(0x1000), line('[Serializer_v1.10]'));
  for (const b of bones) {
    // Ogre's own length rule: the chunk length does not count the name.
    const body = Buffer.concat([line(b.name), u16(b.handle), floats(...b.position), floats(...b.rotation)]);
    const head = Buffer.alloc(6);
    head.writeUInt16LE(0x2000, 0);
    head.writeUInt32LE(6 + 2 + 12 + 16, 2);
    parts.push(head, body);
  }
  bones.forEach((b, i) => {
    const p = parentOf(i);
    if (p >= 0) chunk(0x3000, u16(b.handle, bones[p]!.handle));
  });
  for (const c of clips) {
    const keys: Buffer[] = [];
    for (const [t, angle] of [[0, 0], [1, 0.8], [2, 0]] as const) {
      const key = floats(t, 0, Math.sin(angle / 2), 0, Math.cos(angle / 2), 0, 0, 0);
      const head = Buffer.alloc(6);
      head.writeUInt16LE(0x4110, 0);
      head.writeUInt32LE(6 + key.length, 2);
      keys.push(head, key);
    }
    const track = Buffer.concat([u16(bones[c.bone]!.handle), ...keys]);
    const trackHead = Buffer.alloc(6);
    trackHead.writeUInt16LE(0x4100, 0);
    trackHead.writeUInt32LE(6 + track.length, 2);
    chunk(0x4000, Buffer.concat([line(c.name), floats(2), trackHead, track]));
  }
  return Buffer.concat(parts);
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = { KEDIT_USER_DATA: userData, KEDIT_LIVE_FILE: join(userData, 'live.json') };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && !(k in env)) env[k] = v;
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function closeApp(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
    })
    .catch(() => undefined);
  await app.close();
}

test('add animations: bone check, copy into the mod folder, records in one undo step, clip in «Model»', async () => {
  const game = resolveGamePaths();
  const modDir = join(game.kenshi, 'mods', MOD);
  const male = parseOgreSkeleton(readFileSync(join(game.kenshi, 'data/character/meshes/male_skeleton/male_skeleton.skeleton')));
  const head = male.bones.findIndex((b) => /head/i.test(b.name));
  expect(head).toBeGreaterThan(0);
  const root = male.bones.findIndex((b) => b.parent < 0);
  // A bone two levels down, hung straight on the root: «difference hierarchy» for Ogre.
  const moved = male.bones.findIndex((b) => b.parent >= 0 && male.bones[b.parent]!.parent >= 0);
  const same = (i: number): number => male.bones[i]!.parent;

  const dir = mkdtempSync(join(tmpdir(), 'kedit-e2e-anims-'));
  const good = join(dir, 'good', FILE);
  const broken = join(dir, 'broken', FILE);
  const other = join(dir, 'other', FILE);
  for (const p of [good, broken, other]) mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(good, writeSkeleton(male.bones, same, [{ name: 'e2e_wave', bone: head }, { name: 'walk lower', bone: head }]));
  writeFileSync(broken, writeSkeleton(male.bones, (i) => (i === moved ? root : same(i)), [{ name: 'e2e_wave', bone: head }]));
  writeFileSync(other, writeSkeleton(male.bones, same, [{ name: 'e2e_nod', bone: head }]));
  rmSync(modDir, { recursive: true, force: true });

  const { app, page } = await launch();
  const pickFile = async (p: string): Promise<void> => {
    await app.evaluate(({ dialog }, q) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [q] });
    }, p);
    await page.getByTestId('aa-male-pick').click();
  };
  try {
    await page.getByTestId('new-mod-name').fill(MOD);
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    // The button is offered only in the races category.
    await expect(page.getByTestId('list-add-anims')).toHaveCount(0);
    await page.getByTestId('cat-Races').click();
    await page.locator(`[data-testid="record-list"] [data-sid="${GREENLANDER}"]`).click();
    await page.getByTestId('list-add-anims').click();
    const panel = page.getByTestId('add-anims-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('aa-race')).toHaveValue(GREENLANDER);
    await expect(panel).toHaveAttribute('data-type', 'ANIMATION');
    const apply = panel.getByTestId('aa-apply');
    await expect(apply).toBeDisabled();

    // A bone on another parent: Ogre would refuse the file (likely a crash) — no «Add».
    await pickFile(broken);
    await expect(panel.getByTestId('aa-fit')).toHaveAttribute('data-verdict', 'error', { timeout: 60_000 });
    await expect(panel.getByTestId('aa-fit')).toContainText(male.bones[moved]!.name);
    await expect(apply).toBeDisabled();

    // The good file: bones fit; the new clip is ticked, the clip the game already has is not.
    await pickFile(good);
    await expect(panel.getByTestId('aa-male')).toHaveAttribute('data-clips', '2');
    await expect(panel.getByTestId('aa-fit')).toHaveAttribute('data-verdict', 'ok');
    const wave = panel.locator('[data-testid="aa-clip"][data-clip="e2e_wave"]');
    const walk = panel.locator('[data-testid="aa-clip"][data-clip="walk lower"]');
    await expect(wave.getByTestId('aa-clip-on')).toBeChecked();
    await expect(walk.getByTestId('aa-clip-on')).not.toBeChecked();
    await expect(walk.getByTestId('aa-clip-has')).toBeVisible();
    // A clip of the race itself is not a typo of a record.
    await expect(walk.getByTestId('aa-near-miss')).toHaveCount(0);
    await expect(panel.getByTestId('aa-file-name')).toHaveValue('e2e_anims');
    await expect(panel.getByTestId('aa-copy-to')).toContainText(`mods/${MOD}/animations/${FILE}`);
    await expect(apply).toBeEnabled();
    await page.screenshot({ path: join(shots, '60-add-anims.png') });

    await apply.click();
    // The file is in the mod folder; «Model» shows the race playing the new clip.
    await expect.poll(() => existsSync(join(modDir, 'animations', FILE))).toBe(true);
    expect(readFileSync(join(modDir, 'animations', FILE)).equals(readFileSync(good))).toBe(true);
    const view = page.getByTestId('model-view');
    await expect(view).toHaveAttribute('data-sid', GREENLANDER);
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await expect(view).toHaveAttribute('data-clip', 'e2e_wave');
    await expect(view).toHaveAttribute('data-playing', 'true');
    await page.screenshot({ path: join(shots, '61-add-anims-model.png') });

    // All of it is one undo step.
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('redo')).toBeEnabled();
    await expect(page.getByTestId('undo')).toBeDisabled();

    // Another file of the same name: asked first, kept under a new name on request.
    await page.locator(`[data-testid="record-list"] [data-sid="${GREENLANDER}"]`).click();
    await page.getByTestId('list-add-anims').click();
    await expect(panel).toBeVisible();
    await pickFile(other);
    await expect(panel.getByTestId('aa-male')).toHaveAttribute('data-clips', '1');
    await panel.getByTestId('aa-apply').click();
    await expect(panel.getByTestId('aa-conflict')).toBeVisible();
    expect(readFileSync(join(modDir, 'animations', FILE)).equals(readFileSync(good))).toBe(true);
    await panel.getByTestId('aa-rename').click();
    await expect.poll(() => existsSync(join(modDir, 'animations', 'e2e_anims_2.skeleton'))).toBe(true);
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await expect(view).toHaveAttribute('data-clip', 'e2e_nod');
  } finally {
    await closeApp(app);
    rmSync(modDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
