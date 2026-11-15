/**
 * Панель «Игра»: запущенная Kenshi через плагин Kenshi Bridge — выбранный персонаж (его шаблон —
 * ссылка на запись), позиция, время, пауза и журнал трассировки диалога.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { GameState } from '@kenshi-editor/core';
import { langOf, useLang } from '../../i18n.ts';
import { GAME_STRINGS, gameRequest, gameState, replyError, setGameTrace, useGameLink, useGameT, useGameTrace } from '../../game.ts';
import { ShowInGame, TraceView } from '../../components/GameLink.tsx';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';

function GamePanel(): ReactNode {
  const g = useGameT();
  const lang = useLang();
  const link = useGameLink();
  const { project, go } = useWorkbench();
  const [state, setState] = useState<GameState | undefined>();
  const [err, setErr] = useState<string | undefined>();

  const refresh = useCallback(async (): Promise<void> => {
    const r = await gameState();
    if ('paused' in r) {
      setState(r);
      setErr(undefined);
    } else if (!r.ok) {
      setState(undefined);
      setErr(replyError(r, lang));
    }
  }, [lang]);

  useEffect(() => {
    if (!link.inGame) {
      setState(undefined);
      return;
    }
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    return () => {
      clearInterval(id);
    };
  }, [link.inGame, refresh]);

  if (!link.connected) {
    return (
      <div className="panel-scroll game-panel" data-testid="game-panel" data-state="off">
        <p>{g.off}</p>
        <p className="muted">{g.offHint}</p>
      </div>
    );
  }
  if (!link.inGame) {
    return (
      <div className="panel-scroll game-panel" data-testid="game-panel" data-state="menu">
        <p>{g.menu}</p>
      </div>
    );
  }
  const sel = state?.selected;
  const known = (sid: string | undefined): sid is string => sid !== undefined && project.ctx.get(sid) !== undefined;
  return (
    <div className="panel-scroll game-panel" data-testid="game-panel" data-state="game">
      {err && <p className="error">{err}</p>}
      {state && (
        <>
          <div className="game-row">
            {g.day} {Math.floor(state.time.days)}, {String(Math.floor(state.time.hours % 24)).padStart(2, '0')}:
            {String(Math.floor(((state.time.hours % 24) % 1) * 60)).padStart(2, '0')} · {state.paused ? g.paused : `${g.speed} ×${state.speed}`}{' '}
            <button
              className="small"
              data-testid="game-pause"
              onClick={() => void gameRequest('pause', { on: !state.paused }).then(refresh)}
            >
              {state.paused ? g.resume : g.pause}
            </button>
          </div>
          <div className="game-row" data-testid="game-selected">
            {g.selected}:{' '}
            {sel ? (
              <>
                <b>{sel.name}</b>
                {sel.template && (
                  <>
                    {' '}
                    {known(sel.template.stringId) ? (
                      <a href="#" onClick={(e) => { e.preventDefault(); go(sel.template!.stringId); }}>
                        [{sel.template.stringId}]
                      </a>
                    ) : (
                      <span className="muted">[{sel.template.stringId}]</span>
                    )}
                  </>
                )}
                {sel.faction && (
                  <span className="muted">
                    {' '}
                    · {g.faction}: {sel.faction.name}
                  </span>
                )}
              </>
            ) : (
              <span className="muted">{g.nobody}</span>
            )}
          </div>
          {sel && (
            <div className="game-row mono selectable">
              {g.position}: {sel.pos.map((v) => v.toFixed(1)).join(', ')} <ShowInGame pos={sel.pos} />
            </div>
          )}
        </>
      )}
      <TraceSection onGo={go} />
    </div>
  );
}

function TraceSection({ onGo }: { onGo: (sid: string) => void }): ReactNode {
  const g = useGameT();
  const trace = useGameTrace();
  const last = trace.records.slice(-15).reverse();
  return (
    <div className="game-trace-section">
      <div className="game-row">
        <button className="small" data-testid="game-trace-toggle" title={g.traceHint} onClick={() => void setGameTrace(!trace.on)}>
          {trace.on ? g.traceOff : g.traceOn}
        </button>
      </div>
      {trace.on && last.length === 0 && <p className="muted">{g.traceEmpty}</p>}
      {last.map((r) => (
        <div key={r.seq} className="game-trace-item">
          <div>
            #{r.seq} · {g.event} {r.event} · {g.speaker}: {r.speaker?.name ?? '—'} → {r.target?.name ?? '—'} ·{' '}
            {r.chosen ? `${g.chosen}: ${r.chosen.dialogueName || r.chosen.dialogue}` : g.nothing}
          </div>
          <TraceView rec={r} onGo={onGo} />
        </div>
      ))}
    </div>
  );
}

registerPanel({
  id: 'game',
  title: (t) => GAME_STRINGS[langOf(t)].panel,
  icon: '◉',
  component: GamePanel,
  area: 'right',
  order: 95,
  hint: (t) => GAME_STRINGS[langOf(t)].panelHint,
});
