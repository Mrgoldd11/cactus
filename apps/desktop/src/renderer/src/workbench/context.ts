/**
 * What the shell gives panels: the project, the shared selection, opening panels, status bar
 * messages. A panel gets these through `useWorkbench()`, and its record through `useFollowed()`.
 */
import { createContext, useContext, type RefObject } from 'react';
import type { Strings } from '../i18n.ts';
import type { Project } from '../project.ts';
import type { PanelDef, PanelParams } from './registry.ts';
import { useSelectionVersion, type Selection, type SelectionService } from './selection.ts';
import { useProjectVersion } from '../hooks.ts';
import type { ValueStore } from './store.ts';

export interface StatusMessage {
  /** The text is built at display time — the message is translated when the language changes. */
  text: (t: Strings) => string;
  kind: 'info' | 'error';
}

export interface Workbench {
  project: Project;
  selection: SelectionService;
  /** Select a record (and push it to the «back/forward» history). */
  go: (sid: string) => void;
  /** Edit error — to the status bar. */
  report: (err: string | undefined) => void;
  status: (msg: StatusMessage) => void;
  /** Open (or show) a panel; with `params.sid` a multi-instance panel gets a separate tab. */
  open: (panelId: string, params?: PanelParams) => void;
  /** Whether a panel of this kind is open anywhere. */
  hasPanel: (panelId: string) => boolean;
  /** Record creation window. */
  newRecord: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Category in the tree — filter of the record list. */
  category: ValueStore<string>;
  /** Rebuild the context with other dependencies or context mods (edits are kept). */
  reload: (change: { dependencies?: string[]; contextMods?: string[] }) => Promise<void>;
}

export const WorkbenchContext = createContext<Workbench | null>(null);

export function useWorkbench(): Workbench {
  const wb = useContext(WorkbenchContext);
  if (!wb) throw new Error('Panel outside the workspace');
  return wb;
}

/** Whether the selection suits the panel (kind and record type). */
export function accepts(project: Project, def: PanelDef, s: Selection): boolean {
  const shows = def.shows;
  if (!shows?.kinds.includes(s.kind)) return false;
  if (!shows.types) return true;
  const sid = s.kind === 'scene' ? s.sid : s.sid;
  const rec = sid === undefined ? undefined : project.record(sid);
  return rec !== undefined && shows.types.includes(project.ctx.typeName(rec.type));
}

export interface Followed {
  /** The record the panel shows. */
  sid: string | undefined;
  /** The whole selection (for a line — its dialogue too). */
  item: Selection | undefined;
  pinned: boolean;
  /** Project data version: changes with every edit. */
  version: number;
}

/**
 * The panel's record: pinned (`params.sid`) or the last matching selection. The panel
 * re-renders when the selection changes and on edits.
 */
export function useFollowed(def: PanelDef, params: PanelParams): Followed {
  const { project, selection } = useWorkbench();
  useSelectionVersion(selection);
  const version = useProjectVersion(project);
  if (params.sid !== undefined) return { sid: params.sid, item: { kind: 'record', sid: params.sid }, pinned: true, version };
  const item = selection.latest((s) => accepts(project, def, s));
  const sid = item === undefined ? undefined : item.kind === 'scene' ? item.sid : item.sid;
  return { sid, item, pinned: false, version };
}
