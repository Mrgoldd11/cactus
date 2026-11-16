/**
 * Live AI link in the window: `LiveHost` executes MCP requests (via main) on the open
 * project. AI edits are visible in the window at once and pile up in the change set list.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { LiveHost, type HostedChangeset } from '@kenshi-editor/core';
import type { LiveStatus } from '../../shared/api.ts';
import type { Project } from './project.ts';

let current: { project: Project; session: number } | undefined;
let sessions = 0;
let hostVersion = 0;

export const liveHost = new LiveHost(() => {
  if (!current) return undefined;
  const p = current.project;
  return {
    ctx: p.ctx,
    version: p.version,
    session: current.session,
    ...(p.path !== undefined ? { modPath: p.path } : {}),
    game: p.bundle.game.kenshi,
    dependencies: p.bundle.dependencies.map((d) => ({ name: d.name, path: d.path })),
  };
});
liveHost.subscribe(() => {
  hostVersion++;
});

/** Another project was opened (or closed): the earlier change sets do not belong to it. */
export function setLiveProject(p: Project | undefined): void {
  if (current?.project === p) return;
  current = p ? { project: p, session: ++sessions } : undefined;
  liveHost.reset();
}

export function startLiveBridge(): void {
  window.kedit.onLiveRequest((req) => {
    try {
      return { ok: true, result: liveHost.handle(req) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** AI change sets; the component re-renders on every change of them. */
export function useAiChangesets(): readonly HostedChangeset[] {
  useSyncExternalStore(
    (cb) => liveHost.subscribe(cb),
    () => hostVersion,
  );
  return liveHost.changesets;
}

export function useLiveStatus(): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>({ clients: [] });
  useEffect(() => {
    let alive = true;
    void window.kedit.getLiveStatus().then((s) => {
      if (alive) setStatus(s);
    });
    const off = window.kedit.onLiveStatus(setStatus);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}
