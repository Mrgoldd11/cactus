/**
 * Окно открытого проекта: панель команд, рабочее пространство из панелей (dockview), строка
 * состояния. Навигация по записям — через общий выбор (назад/вперёд), горячие клавиши.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DockviewApi } from 'dockview-react';
import type { Lang, WorkspaceSettings } from '../../../shared/api.ts';
import { useT } from '../i18n.ts';
import { useProjectVersion, tryEdit } from '../hooks.ts';
import { MOD_CHANGES_ID, reloadWithDependencies, type Project } from '../project.ts';
import { LangSwitch } from '../App.tsx';
import { DependenciesModal, ModInfoModal, NewRecordModal, ValidationModal } from './Modals.tsx';
import { useAiChangesets, useLiveStatus } from '../live.ts';
import { SelectionService, useSelectionVersion } from '../workbench/selection.ts';
import { ValueStore, useStore } from '../workbench/store.ts';
import { findNode, initialCategory } from '../workbench/category.ts';
import type { StatusMessage, Workbench as WorkbenchValue } from '../workbench/context.ts';
import { Workbench } from '../workbench/Workbench.tsx';
import { WindowMenu } from '../workbench/WindowMenu.tsx';
import { applyPreset, isPreset, openPanel, type PresetId } from '../workbench/layouts.ts';
import type { PanelParams } from '../workbench/registry.ts';

export type { StatusMessage } from '../workbench/context.ts';

interface Props {
  project: Project;
  onReplace: (p: Project) => void;
  onClose: () => void;
  lang: Lang;
  onLang: (l: Lang) => void;
}

type ModalKind = 'deps' | 'info' | 'validate' | 'new';

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
}

function blurActive(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

export function Editor({ project, onReplace, onClose, lang, onLang }: Props): ReactNode {
  const t = useT();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const selection = useMemo(() => new SelectionService(), [project]);
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
  // Сохранённая раскладка читается до первого показа рабочего пространства.
  const [workspace, setWorkspace] = useState<WorkspaceSettings | undefined | null>(null);
  const [preset, setPreset] = useState<PresetId>('data');
  useEffect(() => {
    void window.kedit.getSettings().then((s) => {
      const p = s.workspace?.preset;
      if (isPreset(p)) setPreset(p);
      setWorkspace(s.workspace);
    });
  }, []);

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
    }),
    [project, selection, go, report, open, category],
  );

  // Записи, которых больше нет (отменили создание), убрать из выбора.
  useEffect(() => {
    selection.prune((sid) => project.record(sid) !== undefined);
  }, [selection, project, version]);

  // Пришла новая правка ИИ — показать панель.
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
    if (cs) setStatus({ text: (s) => `${s.undo}: ${cs.label}`, kind: 'info' });
  };
  const redo = (): void => {
    const cs = ctx.redo();
    if (cs) setStatus({ text: (s) => `${s.redo}: ${cs.label}`, kind: 'info' });
  };
  const save = async (saveAs: boolean): Promise<void> => {
    blurActive();
    const r = await project.save(saveAs);
    if (r.ok) setStatus({ text: (s) => `${s.saved}: ${r.path}`, kind: 'info' });
    else if (r.cancelled) setStatus({ text: (s) => s.saveCancelled, kind: 'info' });
    else setStatus({ text: (s) => `${s.saveFailed}: ${r.error ?? ''}`, kind: 'error' });
  };

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') {
      e.preventDefault();
      void save(e.shiftKey);
    } else if (mod && key === 'f') {
      e.preventDefault();
      if (!searchRef.current) open('records');
      requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    } else if (e.altKey && e.key === 'ArrowLeft') back();
    else if (e.altKey && e.key === 'ArrowRight') forward();
    else if (mod && !isTyping(e.target) && ((key === 'z' && e.shiftKey) || key === 'y')) {
      e.preventDefault();
      redo();
    } else if (mod && !isTyping(e.target) && key === 'z') {
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
      const msg = e instanceof Error ? e.message : String(e);
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
        <button data-testid="undo" disabled={!ctx.canUndo} onClick={undo} title="Ctrl+Z">
          ↶ {t.undo}
        </button>
        <button data-testid="redo" disabled={!ctx.canRedo} onClick={redo} title="Ctrl+Y">
          ↷ {t.redo}
        </button>
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
          onClick={() => {
            setModal('info');
          }}
        >
          {t.modInfo}
        </button>
        <button
          data-testid="validate"
          onClick={() => {
            setModal('validate');
          }}
        >
          {t.validation}
        </button>
        <span className="sep" />
        <WindowMenu api={apiRef.current} preset={preset} onPreset={choosePreset} onOpen={open} />
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
        <LangSwitch lang={lang} onLang={onLang} />
      </div>
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
        <span className="mono muted">{project.path ?? t.unsaved}</span>
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
      {modal === 'validate' && (
        <ValidationModal
          project={project}
          onGo={(sid) => {
            setModal(undefined);
            go(sid);
          }}
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
