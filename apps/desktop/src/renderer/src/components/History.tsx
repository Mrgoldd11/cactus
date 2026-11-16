/**
 * История правок поверх истории ядра (наборы изменений): кружочки ↶ ↷ в панели команд со
 * списком последних шагов и панель «История». Второй истории нет — всё читается из
 * `ctx.history()`, переход к шагу — `ctx.undoTo / redoTo / goToStep`.
 */
import type { Lang } from '../../../shared/api.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { describeChangeset, type Changeset, type TranslationIndex } from '@kenshi-editor/core';
import { inLang, useLang, useT, type Strings } from '../i18n.ts';
import { tryEdit, useProjectVersion } from '../hooks.ts';
import { useGameTexts } from '../data-names.ts';
import type { Project } from '../project.ts';
import type { StatusMessage } from '../workbench/context.ts';

const translations = new WeakMap<Project, TranslationIndex | undefined>();

/** Game texts of the data language for step titles (until loaded — untranslated). */
export function useStepTranslation(project: Project): TranslationIndex | undefined {
  const tr = useGameTexts(project) ?? undefined;
  // Idempotent cache write: stepOf() outside React reads the latest texts.
  translations.set(project, tr);
  return tr;
}

export interface Step {
  cs: Changeset;
  text: string;
  ai: boolean;
  rollback: boolean;
}

/** Шаг истории с названием на языке интерфейса. */
export function stepOf(project: Project, cs: Changeset, lang: Lang): Step {
  const tr = translations.get(project);
  const d = describeChangeset(project.ctx, cs, tr ? { translation: tr } : {});
  return { cs, text: inLang(d.text, lang), ai: d.ai, rollback: d.rollback };
}

function StepMarks({ step, t }: { step: Step; t: Strings }): ReactNode {
  return (
    <>
      {step.ai && (
        <span className="hist-ai" title={t.histAiTip}>
          ✦ {t.histAi}
        </span>
      )}
      {step.rollback && (
        <span className="hist-rb" title={t.histRollbackTip}>
          ↺
        </span>
      )}
    </>
  );
}

const MENU_MAX = 25;

interface ButtonsProps {
  project: Project;
  status: (m: StatusMessage) => void;
  onAll: () => void;
}

/** ↶ ▾ ↷ ▾: круглые кнопки отмены и повтора; ▾ или правый щелчок — список шагов. */
export function UndoRedoButtons({ project, status, onAll }: ButtonsProps): ReactNode {
  const t = useT();
  const lang = useLang();
  useProjectVersion(project);
  useStepTranslation(project);
  const ctx = project.ctx;
  const [menu, setMenu] = useState<'undo' | 'redo' | undefined>();
  const [hover, setHover] = useState(-1);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setMenu(undefined);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(undefined);
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [menu]);

  const h = ctx.history();
  const undoSteps = [...h.undo].reverse().map((cs) => stepOf(project, cs, lang));
  const redoSteps = h.redo.map((cs) => stepOf(project, cs, lang));

  const run = (dir: 'undo' | 'redo', id?: number): void => {
    setMenu(undefined);
    let done: Changeset[] = [];
    const err = tryEdit(() => {
      if (id === undefined) {
        const cs = dir === 'undo' ? ctx.undo() : ctx.redo();
        done = cs ? [cs] : [];
      } else done = dir === 'undo' ? ctx.undoTo(id) : ctx.redoTo(id);
    });
    if (err !== undefined) {
      status({ text: (s) => `${s.editFailed}: ${err}`, kind: 'error' });
      return;
    }
    const lastStep = done.at(-1);
    if (!lastStep) return;
    const title = stepOf(project, lastStep, lang).text;
    const n = done.length;
    status({ text: (s) => (n === 1 ? `${dir === 'undo' ? s.undo : s.redo}: ${title}` : `${dir === 'undo' ? s.histUndoN(n) : s.histRedoN(n)}: … ${title}`), kind: 'info' });
  };

  const openMenu = (dir: 'undo' | 'redo'): void => {
    setHover(-1);
    setMenu((m) => (m === dir ? undefined : dir));
  };

  const list = menu === 'undo' ? undoSteps : redoSteps;
  const nextUndo = undoSteps[0];
  const nextRedo = redoSteps[0];

  return (
    <span className="hist-buttons" ref={root}>
      <span className="hist-split">
        <button
          data-testid="undo"
          className="hist-round"
          disabled={!ctx.canUndo}
          onClick={() => {
            run('undo');
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (ctx.canUndo) openMenu('undo');
          }}
          title={`${t.histUndoTip}${nextUndo ? `: ${nextUndo.text}` : ''} (Ctrl+Z)`}
          aria-label={t.histUndoTip}
        >
          ↶
        </button>
        <button data-testid="undo-menu" className="hist-caret" disabled={!ctx.canUndo} onClick={() => { openMenu('undo'); }} title={t.histUndoMenu}>
          ▾
        </button>
      </span>
      <span className="hist-split">
        <button
          data-testid="redo"
          className="hist-round"
          disabled={!ctx.canRedo}
          onClick={() => {
            run('redo');
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (ctx.canRedo) openMenu('redo');
          }}
          title={`${t.histRedoTip}${nextRedo ? `: ${nextRedo.text}` : ''} (Ctrl+Y, Ctrl+Shift+Z)`}
          aria-label={t.histRedoTip}
        >
          ↷
        </button>
        <button data-testid="redo-menu" className="hist-caret" disabled={!ctx.canRedo} onClick={() => { openMenu('redo'); }} title={t.histRedoMenu}>
          ▾
        </button>
      </span>
      {menu && (
        <div className={`hist-menu ${menu}`} data-testid={`${menu}-list`} onMouseLeave={() => { setHover(-1); }}>
          <div className="hist-menu-head muted">{menu === 'undo' ? t.histUndoMenu : t.histRedoMenu}</div>
          {list.slice(0, MENU_MAX).map((s, i) => (
            <button
              key={s.cs.id}
              className={`hist-menu-item${i <= hover ? ' hot' : ''}`}
              data-testid={`${menu}-step`}
              data-id={s.cs.id}
              onMouseEnter={() => { setHover(i); }}
              onClick={() => {
                run(menu, s.cs.id);
              }}
            >
              <span className="hist-menu-text">{s.text}</span>
              <StepMarks step={s} t={t} />
            </button>
          ))}
          <div className="hist-menu-foot">
            <span className="muted">{hover >= 0 ? (menu === 'undo' ? t.histUndoN(hover + 1) : t.histRedoN(hover + 1)) : ' '}</span>
            <button
              className="small"
              data-testid="history-all"
              onClick={() => {
                setMenu(undefined);
                onAll();
              }}
            >
              {t.histAll}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

/** Полный список шагов: где вы сейчас, отменённые шаги серые, щелчок — перейти к шагу. */
export function HistoryList({ project, status }: { project: Project; status: (m: StatusMessage) => void }): ReactNode {
  const t = useT();
  const lang = useLang();
  useProjectVersion(project);
  useStepTranslation(project);
  const ctx = project.ctx;
  const h = ctx.history();
  const done = h.undo.map((cs) => stepOf(project, cs, lang));
  const future = h.redo.map((cs) => stepOf(project, cs, lang));
  const current = done.at(-1)?.cs.id ?? 0;
  const currentRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const go = (id: number, text: string): void => {
    const err = tryEdit(() => {
      ctx.goToStep(id);
    });
    if (err !== undefined) status({ text: (s) => `${s.editFailed}: ${err}`, kind: 'error' });
    else status({ text: (s) => `${s.histWent}: ${text}`, kind: 'info' });
  };

  const row = (s: Step | undefined, n: number, state: 'done' | 'current' | 'future'): ReactNode => {
    const id = s?.cs.id ?? 0;
    const text = s ? s.text : t.histStart;
    return (
      <button
        key={id}
        ref={state === 'current' ? currentRef : undefined}
        className={`hist-row ${state}${s?.ai ? ' ai' : ''}`}
        data-testid="history-step"
        data-id={id}
        data-state={state}
        title={text}
        onClick={() => {
          if (state !== 'current') go(id, text);
        }}
      >
        <span className="hist-pos">{state === 'current' ? '▶' : ''}</span>
        <span className="hist-num muted">{n === 0 ? '' : n}</span>
        <span className="hist-text">{text}</span>
        {s && <StepMarks step={s} t={t} />}
        {state === 'current' && <span className="hist-here">{t.histCurrent}</span>}
      </button>
    );
  };

  return (
    <div className="hist-panel" data-testid="history-panel">
      <div className="hist-hint muted">{done.length + future.length === 0 ? t.histEmpty : t.histHint}</div>
      <div className="hist-list">
        {row(undefined, 0, current === 0 ? 'current' : 'done')}
        {done.map((s, i) => row(s, i + 1, s.cs.id === current ? 'current' : 'done'))}
        {future.map((s, i) => row(s, done.length + i + 1, 'future'))}
      </div>
    </div>
  );
}
