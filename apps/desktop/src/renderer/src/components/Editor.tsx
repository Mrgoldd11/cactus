/**
 * Open project window: command bar, workspace of panels (dockview), status
 * bar. Navigation through records — via the shared selection (back/forward), hotkeys.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DockviewApi } from 'dockview-react';
import type { Lang, Settings, WorkspaceSettings } from '../../../shared/api.ts';
import { errorText, useT } from '../i18n.ts';
import { isTypingIn, shortcut } from '../keys.ts';
import { useProjectVersion, tryEdit } from '../hooks.ts';
import { MOD_CHANGES_ID, reloadProject, reloadWithDependencies, restoreProject, type Project } from '../project.ts';
import { LangSwitch } from '../App.tsx';
import { BackupsModal, SettingsModal, formatClock, formatTime } from './BackupModals.tsx';
import { DependenciesModal, ModInfoModal, NewRecordModal } from './Modals.tsx';
import { PublishModal } from './PublishModal.tsx';
import { RESCAN_EVENT } from './IssueFixer.tsx';
import { useAiChangesets, useLiveStatus } from '../live.ts';
import { SelectionService, useSelectionVersion } from '../workbench/selection.ts';
import { ValueStore, useStore } from '../workbench/store.ts';
import { findNode, initialCategory } from '../workbench/category.ts';
import type { StatusMessage, Workbench as WorkbenchValue } from '../workbench/context.ts';
import { Workbench } from '../workbench/Workbench.tsx';
import { LayoutSwitch, WindowMenu } from '../workbench/WindowMenu.tsx';
import { UndoRedoButtons, stepOf } from './History.tsx';
import { GameIndicator } from './GameLink.tsx';
import { applyPreset, isPreset, openPanel, type PresetId } from '../workbench/layouts.ts';
import type { PanelParams } from '../workbench/registry.ts';

export type { StatusMessage } from '../workbench/context.ts';

interface Props {
  project: Project;
  onReplace: (p: Project) => void;
  onClose: () => void;
  lang: Lang;
  onLang: (l: Lang) => void;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
}

type ModalKind = 'deps' | 'info' | 'new' | 'backups' | 'settings' | 'publish';

/** A saved mod in `<game>/mods/` (not a Workshop download) — what may be published. */
function publishable(project: Project): boolean {
  if (project.path === undefined || project.provenance?.inWorkshop === true) return false;
  const norm = (x: string): string => x.replace(/\\/g, '/').toLowerCase();
  return norm(project.path).startsWith(`${norm(project.bundle.game.kenshi).replace(/\/$/, '')}/mods/`);
}

function blurActive(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

export function Editor({ project, onReplace, onClose, lang, onLang, settings, onSettings }: Props): ReactNode {
  const t = useT();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const selection = useMemo(() => new SelectionService(), [project]);
  const extensionCount = project.bundle.extensions?.length ?? 0;
  const category = useMemo(() => new ValueStore(initialCategory(project)), [project]);
  useSelectionVersion(selection);
  const nodeId = useStore(category);
  const [status, setStatus] = useState<StatusMessage | undefined>();
  const [modal, setModal] = useState<ModalKind | undefined>();
  const searchRef = useRef<HTMLInputElement>(null);
  const aiChangesets = useAiChangesets();
  const liveStatus = useLiveStatus();
  const aiPending = aiChangesets.filter((c) => c.status === 'pending').length;
  const apiRef = useRef<DockviewApi | undefined>(undefined);
  const [, setLayoutTick] = useState(0);
  // The saved layout is read before the workspace is first shown.
  const [workspace, setWorkspace] = useState<WorkspaceSettings | undefined | null>(null);
  const [preset, setPreset] = useState<PresetId>('data');
  useEffect(() => {
    void window.kedit.getSettings().then((s) => {
      const p = s.workspace?.preset;
      if (isPreset(p)) setPreset(p);
      setWorkspace(s.workspace);
    });
  }, []);

  // Autosave: on a timer, only if there are unsaved edits and they changed since last time.
  const autosavedVersion = useRef(-1);
  const autosaveWritten = useRef(false);
  const autosaveMinutes = settings.autosaveMinutes;
  useEffect(() => {
    autosavedVersion.current = -1;
    autosaveWritten.current = false;
    if (!(autosaveMinutes > 0)) return;
    const id = setInterval(() => {
      if (!project.dirty) {
        // Edits were undone back to the saved state: the autosave is no longer needed.
        if (autosaveWritten.current) {
          autosaveWritten.current = false;
          void window.kedit.autosaveClear(project.ref);
        }
        return;
      }
      if (project.version === autosavedVersion.current) return;
      const version = project.version;
      void window.kedit.autosave(project.ref, project.currentBytes()).then((r) => {
        if (r.ok) {
          autosavedVersion.current = version;
          autosaveWritten.current = true;
          const time = formatClock(r.savedAt, lang);
          setStatus({ text: (s) => s.autosavedAt(time), kind: 'info' });
        } else {
          setStatus({ text: (s) => s.autosaveFailed(r.error), kind: 'error' });
        }
      });
    }, autosaveMinutes * 60_000);
    return () => {
      clearInterval(id);
    };
  }, [project, autosaveMinutes, lang]);

  const go = useCallback(
    (sid: string) => {
      selection.select({ kind: 'record', sid });
    },
    [selection],
  );

  const report = useCallback((err: string | undefined) => {
    if (err !== undefined) setStatus({ text: (s) => `${s.editFailed}: ${err}`, kind: 'error' });
  }, []);

  const tRef = useRef(t);
  tRef.current = t;
  const open = useCallback((panelId: string, params?: PanelParams) => {
    const api = apiRef.current;
    if (api) openPanel(api, tRef.current, panelId, params, params?.sid !== undefined ? panelId : undefined);
  }, []);

  const wb = useMemo<WorkbenchValue>(
    () => ({
      project,
      selection,
      go,
      report,
      status: setStatus,
      open,
      hasPanel: (panelId) => apiRef.current?.panels.some((p) => p.api.component === panelId) ?? false,
      newRecord: () => {
        setModal('new');
      },
      searchRef,
      category,
      reload: (change) =>
        reloadProject(project, change).then(onReplace, (e: unknown) => {
          const msg = errorText(e);
          setStatus({ text: () => msg, kind: 'error' });
        }),
    }),
    [project, selection, go, report, open, category, onReplace],
  );

  // Records that no longer exist (creation undone) are removed from the selection.
  useEffect(() => {
    selection.prune((sid) => project.record(sid) !== undefined);
  }, [selection, project, version]);

  // A new AI edit arrived — show the panel.
  const aiSeen = useRef(0);
  useEffect(() => {
    if (aiChangesets.length > aiSeen.current) open('ai');
    aiSeen.current = aiChangesets.length;
  }, [aiChangesets.length, open]);
  const aiOpen = apiRef.current?.getPanel('ai') !== undefined;
  const toggleAi = (): void => {
    const p = apiRef.current?.getPanel('ai');
    if (p) p.api.close();
    else open('ai');
  };

  const choosePreset = (p: PresetId): void => {
    setPreset(p);
    if (apiRef.current) applyPreset(apiRef.current, p, t);
  };

  const back = (): void => {
    selection.back();
  };
  const forward = (): void => {
    selection.forward();
  };

  const undo = (): void => {
    const cs = ctx.undo();
    if (cs) setStatus({ text: (s) => `${s.undo}: ${stepOf(project, cs, lang).text}`, kind: 'info' });
  };
  const redo = (): void => {
    const cs = ctx.redo();
    if (cs) setStatus({ text: (s) => `${s.redo}: ${stepOf(project, cs, lang).text}`, kind: 'info' });
  };
  const save = async (saveAs: boolean): Promise<void> => {
    blurActive();
    const r = await project.save(saveAs);
    if (r.ok) {
      autosaveWritten.current = false;
      const warn = r.backupError;
      if (warn !== undefined) setStatus({ text: (s) => s.backupWarn(warn), kind: 'error' });
      else setStatus({ text: (s) => `${s.saved}: ${r.path}`, kind: 'info' });
    } else if (r.cancelled) setStatus({ text: (s) => s.saveCancelled, kind: 'info' });
    else if (r.workshop === true) setStatus({ text: (s) => s.saveWorkshop, kind: 'error' });
    else setStatus({ text: (s) => `${s.saveFailed}: ${r.error ?? ''}`, kind: 'error' });
  };
  const copyForEditing = async (): Promise<void> => {
    blurActive();
    const r = await project.copyForEditing();
    if (r.ok) setStatus({ text: (s) => `${s.copiedForEditing}: ${r.path}`, kind: 'info' });
    else if (!r.cancelled) setStatus({ text: (s) => `${s.copyFailed}: ${r.error ?? ''}`, kind: 'error' });
  };
  const restoreBackup = (bytes: Uint8Array, time: number): void => {
    setModal(undefined);
    restoreProject(project, bytes).then(
      (p) => {
        onReplace(p);
        p.bump();
        const when = formatTime(time, lang);
        setStatus({ text: (s) => s.backupRestored(when), kind: 'info' });
      },
      (e: unknown) => {
        const msg = errorText(e);
        setStatus({ text: () => msg, kind: 'error' });
      },
    );
  };
  const prov = project.provenance;

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent): void => {
    const sc = shortcut(e);
    if (sc === 'ctrl+s' || sc === 'ctrl+shift+s') {
      e.preventDefault();
      void save(e.shiftKey);
    } else if (sc === 'ctrl+f') {
      e.preventDefault();
      if (!searchRef.current) open('records');
      requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    } else if (sc === 'alt+arrowleft') back();
    else if (sc === 'alt+arrowright') forward();
    else if (!isTypingIn(e.target) && (sc === 'ctrl+shift+z' || sc === 'ctrl+y')) {
      e.preventDefault();
      redo();
    } else if (!isTypingIn(e.target) && sc === 'ctrl+z') {
      e.preventDefault();
      undo();
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      keyHandler.current(e);
    };
    window.addEventListener('keydown', h);
    return () => {
      window.removeEventListener('keydown', h);
    };
  }, []);

  const node = nodeId === MOD_CHANGES_ID ? undefined : findNode(project.tree, nodeId);
  const modCount = useMemo(() => ctx.modRecords().length, [ctx, version]);

  const applyDeps = (deps: string[]): void => {
    setModal(undefined);
    void reloadWithDependencies(project, deps).then(onReplace, (e: unknown) => {
      const msg = errorText(e);
      setStatus({ text: () => msg, kind: 'error' });
    });
  };

  return (
    <div className="editor" data-testid="editor">
      <div className="toolbar">
        <button onClick={onClose} title={t.close} data-testid="home">
          ⌂
        </button>
        <span className="sep" />
        <button data-testid="save" className={project.dirty ? 'primary' : ''} onClick={() => void save(false)} title="Ctrl+S">
          {t.save}
        </button>
        <button data-testid="save-as" onClick={() => void save(true)} title="Ctrl+Shift+S">
          {t.saveAs}
        </button>
        <span className="sep" />
        <UndoRedoButtons
          project={project}
          status={setStatus}
          onAll={() => {
            open('history');
          }}
        />
        <span className="sep" />
        <button disabled={!selection.canBack} onClick={back} title={`${t.back} (Alt+←)`}>
          ←
        </button>
        <button disabled={!selection.canForward} onClick={forward} title={`${t.forward} (Alt+→)`}>
          →
        </button>
        <span className="sep" />
        <button
          data-testid="deps"
          onClick={() => {
            setModal('deps');
          }}
        >
          {t.dependencies} ({ctx.info.dependencies.length})
        </button>
        <button
          data-testid="mod-info"
          title={extensionCount > 0 ? t.extBadgeTip : undefined}
          onClick={() => {
            setModal('info');
          }}
        >
          {t.modInfo}
          {extensionCount > 0 && (
            <span className="badge tiny" data-testid="ext-badge">
              {t.extBadge(extensionCount)}
            </span>
          )}
        </button>
        <button
          data-testid="validate"
          onClick={() => {
            open('diagnostics');
            window.dispatchEvent(new Event(RESCAN_EVENT));
          }}
        >
          {t.panel_diagnostics}
        </button>
        <button
          data-testid="backups-btn"
          title={t.backupsTip}
          onClick={() => {
            setModal('backups');
          }}
        >
          {t.backups}
        </button>
        <button
          data-testid="publish-btn"
          title={publishable(project) ? t.publishBtnTip : t.publishBtnOff}
          disabled={!publishable(project)}
          onClick={() => {
            setModal('publish');
          }}
        >
          {t.publishBtn}
        </button>
        <span className="sep" />
        <WindowMenu api={apiRef.current} preset={preset} onPreset={choosePreset} onOpen={open} />
        <LayoutSwitch api={apiRef.current} preset={preset} onPreset={choosePreset} />
        <span className="grow" />
        <button
          data-testid="live-status"
          className={`live-btn${liveStatus.clients.length > 0 ? ' connected' : ''}${aiOpen ? ' active' : ''}`}
          title={liveStatus.clients.length > 0 ? `${t.aiConnected}: ${liveStatus.clients.map((c) => c.name).join(', ')}` : t.aiChanges}
          onClick={toggleAi}
        >
          <span className="live-dot" />
          {t.aiButton}
          {aiPending > 0 && <span className="live-badge">{aiPending}</span>}
        </button>
        <span className="mod-title" title={project.path ?? project.bundle.suggestedPath}>
          {project.dirty && <span className="dirty-dot">● </span>}
          {project.title}
        </span>
        <button
          data-testid="settings-btn"
          title={t.settings}
          onClick={() => {
            setModal('settings');
          }}
        >
          ⚙
        </button>
        <LangSwitch lang={lang} onLang={onLang} />
      </div>
      {prov?.inWorkshop === true && (
        <div className="banner warn" data-testid="workshop-banner">
          <span>{t.workshopBanner(prov.workshopId)}</span>
          <button className="small primary" onClick={() => void copyForEditing()} data-testid="copy-for-editing" title={t.copyForEditingTip}>
            {t.copyForEditing}
          </button>
        </div>
      )}
      {prov?.copyOf && (
        <div className={`banner ${prov.copyOf.changed === true ? 'warn' : 'info'}`} data-testid="copy-banner" title={prov.copyOf.source}>
          <span>{t.copyBanner(prov.copyOf.workshopId, prov.copyOf.author, prov.copyOf.copiedAt.slice(0, 10))}</span>
          {prov.copyOf.changed === true && <span data-testid="copy-origin-changed">{t.copyOriginChanged}</span>}
          {prov.copyOf.gone === true && <span className="muted">{t.copyOriginGone}</span>}
        </div>
      )}
      {project.bundle.missingDependencies.length > 0 && (
        <div className="banner error">
          {t.missingDeps}: {project.bundle.missingDependencies.join(', ')}
        </div>
      )}
      {workspace !== null && (
        <Workbench
          wb={wb}
          initial={workspace}
          preset={preset}
          onApi={(api) => {
            apiRef.current = api;
            setLayoutTick((n) => n + 1);
          }}
          onChange={() => {
            setLayoutTick((n) => n + 1);
          }}
        />
      )}
      <div className="statusbar" data-testid="statusbar">
        <span>
          {t.modRecords}: {modCount}
        </span>
        {/* Monospace only for the path: in Consolas the label's space looks doubled. */}
        <span className={project.path !== undefined ? 'mono muted' : 'muted'}>{project.path ?? t.unsaved}</span>
        <GameIndicator />
        {status && (
          <span className={`status-msg ${status.kind}`} data-testid="status-msg">
            {status.text(t)}
          </span>
        )}
      </div>
      {modal === 'deps' && (
        <DependenciesModal
          project={project}
          onApply={applyDeps}
          onClose={() => {
            setModal(undefined);
          }}
        />
      )}
      {modal === 'info' && (
        <ModInfoModal
          project={project}
          onReport={report}
          onClose={() => {
            setModal(undefined);
          }}
        />
      )}
      {modal === 'publish' && (
        <PublishModal
          project={project}
          onSave={() => save(false)}
          onReport={(text) => {
            report(text);
          }}
          onClose={() => {
            setModal(undefined);
          }}
        />
      )}
      {modal === 'backups' && (
        <BackupsModal
          project={project}
          onRestore={(bytes, item) => {
            restoreBackup(bytes, item.time);
          }}
          onStatus={(text, kind) => {
            setStatus({ text: () => text, kind });
          }}
          onClose={() => {
            setModal(undefined);
          }}
        />
      )}
      {modal === 'settings' && (
        <SettingsModal
          game={project.bundle.game}
          settings={settings}
          onChange={onSettings}
          onClose={() => {
            setModal(undefined);
          }}
        />
      )}
      {modal === 'new' && (
        <NewRecordModal
          project={project}
          defaultType={node?.type}
          onCreate={(type, name) => {
            setModal(undefined);
            report(
              tryEdit(() => {
                go(ctx.createRecord(type, name));
              }),
            );
          }}
          onClose={() => {
            setModal(undefined);
          }}
        />
      )}
    </div>
  );
}
