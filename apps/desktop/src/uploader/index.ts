/**
 * Workshop uploader: a separate short-lived process (Electron's binary run as Node, see
 * `src/main/publish.ts`). It talks to Steam through steamworks.js and exits when done, so the
 * Steam connection never lives inside the editor window's process.
 *
 * With `KEDIT_FAKE_STEAM` set (tests, manual checks) steamworks.js is never loaded.
 */
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { UPLOAD_PHASES } from '@kenshi-editor/core';
import { uploaderMain, type SteamWorkshopApi } from '@kenshi-editor/core/node';

type Steamworks = typeof import('steamworks.js');
type SteamClient = ReturnType<Steamworks['init']>;

/** steamworks.js 0.4.0 behind the uploader's interface. Loaded only for a real upload. */
function loadSteamworks(): SteamWorkshopApi {
  const require = createRequire(import.meta.url);
  const sw = require('steamworks.js') as Steamworks;
  let client: SteamClient | undefined;
  const c = (): SteamClient => {
    if (!client) throw new Error('steam client is not initialised');
    return client;
  };
  return {
    init(appId) {
      client = sw.init(appId);
    },
    ownsApp(appId) {
      return c().apps.isSubscribedApp(appId);
    },
    async createItem(appId) {
      const r = await c().workshop.createItem(appId);
      return { itemId: r.itemId.toString(), needsToAcceptAgreement: r.needsToAcceptAgreement };
    },
    updateItem(itemId, d, appId, onProgress) {
      return new Promise((resolve, reject) => {
        c().workshop.updateItemWithCallback(
          BigInt(itemId),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- visibility is Steam's own number 0..3 (WORKSHOP_VISIBILITY)
          { title: d.title, description: d.description, changeNote: d.changeNote, previewPath: d.previewPath, contentPath: d.contentPath, tags: d.tags, visibility: d.visibility },
          appId,
          (r) => {
            resolve({ needsToAcceptAgreement: r.needsToAcceptAgreement });
          },
          (err: unknown) => {
            reject(err instanceof Error ? err : new Error(String(err)));
          },
          (p) => {
            onProgress(UPLOAD_PHASES[p.status] ?? 'invalid', Number(p.progress), Number(p.total));
          },
          250,
        );
      });
    },
  };
}

uploaderMain({
  loadReal: loadSteamworks,
  appendFakeLog: (path, line) => {
    appendFileSync(path, `${line}\n`);
  },
});
