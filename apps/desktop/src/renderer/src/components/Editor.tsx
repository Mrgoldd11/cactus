/**
 * Окно открытого проекта: панель команд, дерево категорий, список записей, редактор записи,
 * строка состояния. Навигация по записям с историей (назад/вперёд), горячие клавиши.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { OTHER_TYPES_ID, type CategoryNode } from '@kenshi-editor/core';
import type { Lang } from '../../../shared/api.ts';
import { useT, type Strings } from '../i18n.ts';
import { useProjectVersion, tryEdit } from '../hooks.ts';
import { MOD_CHANGES_ID, reloadWithDependencies, type Project } from '../project.ts';
import { LangSwitch } from '../App.tsx';
import { CategoryTree } from './CategoryTree.tsx';
import { RecordList } from './RecordList.tsx';
import { RecordEditor } from './RecordEditor.tsx';
import { DependenciesModal, ModInfoModal, NewRecordModal, ValidationModal } from './Modals.tsx';
import { AiPanel } from './AiPanel.tsx';
import { useAiChangesets, useLiveStatus } from '../live.ts';

interface Props {
  project: Project;
  onReplace: (p: Project) => void;
  onClose: () => void;
  lang: Lang;
  onLang: (l: Lang) => void;
}

export interface StatusMessage {
  /** Текст собирается при показе — сообщение переводится при смене языка. */
  text: (t: Strings) => string;
  kind: 'info' | 'error';
}

type ModalKind = 'deps' | 'info' | 'validate' | 'new';

function findNode(nodes: readonly CategoryNode[], id: string): CategoryNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = findNode(n.children, id);
    if (c) return c;
  }
  return undefined;
}

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
  const everythingId = project.tree.find((n) => n.type === undefined && n.id !== OTHER_TYPES_ID)?.id ?? MOD_CHANGES_ID;
  const [nodeId, setNodeId] = useState<string>(() => (ctx.modRecords().length > 0 ? MOD_CHANGES_ID : everythingId));
  const [nav, setNav] = useState<{ stack: string[]; pos: number }>({ stack: [], pos: -1 });
  const [status, setStatus] = useState<StatusMessage | undefined>();
  const [modal, setModal] = useState<ModalKind | undefined>();
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = nav.stack[nav.pos];
  const aiChangesets = useAiChangesets();
  const liveStatus = useLiveStatus();
  const [aiOpen, setAiOpen] = useState(false);
  const aiPending = aiChangesets.filter((c) => c.status === 'pending').length;
  // Пришла новая правка ИИ — показать панель.
  const aiSeen = useRef(0);
  useEffect(() => {
    if (aiChangesets.length > aiSeen.current) setAiOpen(true);
    aiSeen.current = aiChangesets.length;
  }, [aiChangesets.length]);

  const select = useCallback((sid: string) => {
    setNav((n) => (n.stack[n.pos] === sid ? n : { stack: [...n.stack.slice(0, n.pos + 1), sid].slice(-200), pos: Math.min(n.pos + 1, 199) }));
  }, []);
  const back = (): void => {
    setNav((n) => (n.pos > 0 ? { ...n, pos: n.pos - 1 } : n));
  };
  const forward = (): void => {
    setNav((n) => (n.pos < n.stack.length - 1 ? { ...n, pos: n.pos + 1 } : n));
  };

  const report = useCallback((err: string | undefined) => {
    if (err !== undefined) setStatus({ text: (s) => `${s.editFailed}: ${err}`, kind: 'error' });
  }, []);

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
      searchRef.current?.focus();
      searchRef.current?.select();
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
  const ids = useMemo(() => project.idsForNode(node ?? MOD_CHANGES_ID), [project, node, version]);
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
        <button onClick={onClose} title={t.close}>
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
        <button disabled={nav.pos <= 0} onClick={back} title={`${t.back} (Alt+←)`}>
          ←
        </button>
        <button disabled={nav.pos >= nav.stack.length - 1} onClick={forward} title={`${t.forward} (Alt+→)`}>
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
        <span className="grow" />
        <button
          data-testid="live-status"
          className={`live-btn${liveStatus.clients.length > 0 ? ' connected' : ''}${aiOpen ? ' active' : ''}`}
          title={liveStatus.clients.length > 0 ? `${t.aiConnected}: ${liveStatus.clients.map((c) => c.name).join(', ')}` : t.aiChanges}
          onClick={() => {
            setAiOpen((o) => !o);
          }}
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
      <div className={`panes${aiOpen ? ' with-ai' : ''}`}>
        <CategoryTree project={project} version={version} selected={nodeId} onSelect={setNodeId} modCount={modCount} />
        <RecordList
          project={project}
          version={version}
          ids={ids}
          selected={selected}
          onSelect={select}
          searchRef={searchRef}
          onNew={() => {
            setModal('new');
          }}
          onDuplicate={(sid) => {
            report(
              tryEdit(() => {
                select(ctx.duplicateRecord(sid));
              }),
            );
          }}
          onReport={report}
        />
        {selected !== undefined ? (
          <RecordEditor key="editor" project={project} version={version} sid={selected} onGo={select} onReport={report} />
        ) : (
          <div className="record-editor empty muted">{t.noSelection}</div>
        )}
        {aiOpen && (
          <AiPanel
            project={project}
            changesets={aiChangesets}
            status={liveStatus}
            onGo={select}
            onReport={report}
            onClose={() => {
              setAiOpen(false);
            }}
          />
        )}
      </div>
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
            select(sid);
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
                select(ctx.createRecord(type, name));
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
