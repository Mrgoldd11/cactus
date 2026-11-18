/**
 * Small still pictures of record models (the race card thumbnail): the model is built once in a hidden
 * viewer, rendered to PNG and the viewer is thrown away, so no WebGL context stays alive. Pictures are
 * cached by the model contents; renders run one at a time.
 */
import type { RecordModel } from '@kenshi-editor/core';
import type { GameInstallInfo } from '../../../shared/api.ts';
import { ModelViewer } from './viewer.ts';
import { buildModel, disposeModel } from './build.ts';

const MAX_CACHED = 32;
const cache = new Map<string, Promise<string | undefined>>();
let queue: Promise<unknown> = Promise.resolve();

export function modelKey(model: RecordModel): string {
  return JSON.stringify(model.pieces);
}

/** The page CSP allows `data:` pictures, not `blob:` ones. */
function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function render(game: GameInstallInfo, model: RecordModel, size: number): Promise<string | undefined> {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${size}px;height:${size}px;`;
  document.body.appendChild(host);
  const viewer = new ModelViewer(host);
  try {
    const built = await buildModel(game, model, { rig: true });
    if (built.triangles === 0) {
      disposeModel(built.group);
      return undefined;
    }
    viewer.setModel(built.group);
    const png = viewer.renderIcon(size);
    viewer.setModel(undefined);
    disposeModel(built.group);
    return `data:image/png;base64,${base64(png)}`;
  } catch {
    return undefined;
  } finally {
    viewer.renderer.forceContextLoss();
    viewer.dispose();
    host.remove();
  }
}

/** Data URL of a PNG picture of `model`, or undefined when it has no visible mesh. */
export function modelThumbnail(game: GameInstallInfo, model: RecordModel, size = 128): Promise<string | undefined> {
  const key = `${size}|${modelKey(model)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = queue.then(() => render(game, model, size));
  queue = job.catch(() => undefined);
  cache.set(key, job);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return job;
}
