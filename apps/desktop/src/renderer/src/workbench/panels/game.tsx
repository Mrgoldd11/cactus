/**
 * «Game» panel: running Kenshi via the Kenshi Bridge plugin — the selected character (its template is
 * a link to the record), position, time, pause and the dialogue trace log.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { formatEnumValue, getEnum, parseVec3, type GameState } from '@kenshi-editor/core';
import { langOf, useLang } from '../../i18n.ts';
import { GAME_STRINGS, gameRequest, gameState, replyError, setGameTrace, spawnAt, teleportTo, useGameLink, useGameT, useGameTrace } from '../../game.ts';
import { CoordsHelp, ShowInGame, TraceView } from '../../components/GameLink.tsx';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { useSelectionVersion } from '../selection.ts';

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
      <GotoSection onDone={refresh} />
      <SpawnSection />
      <ShotSection />
      <TraceSection onGo={go} />
    </div>
  );
}

/** Field for pasted coordinates + Teleport (with confirmation). */
function GotoSection({ onDone }: { onDone: () => Promise<void> }): ReactNode {
  const g = useGameT();
  const lang = useLang();
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const go = async (): Promise<void> => {
    const pos = parseVec3(text);
    if (!pos) return setErr(g.badCoords);
    if (!window.confirm(g.teleportAsk(pos.map((v) => Math.round(v)).join(', ')))) return;
    const r = await teleportTo(pos);
    setErr(r.ok ? undefined : replyError(r, lang));
    await onDone();
  };
  return (
    <div className="game-row" data-testid="game-goto">
      {g.gotoLabel} <CoordsHelp />{' '}
      <input
        data-testid="game-goto-input"
        value={text}
        placeholder={g.gotoPlaceholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void go()}
      />{' '}
      <button className="small" data-testid="game-goto-button" onClick={() => void go()}>
        {g.gotoButton}
      </button>
      {err && <span className="error"> {err}</span>}
    </div>
  );
}

/** Picture of the game window. */
function ShotSection(): ReactNode {
  const g = useGameT();
  const lang = useLang();
  const [pic, setPic] = useState<string | undefined>();
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const take = async (): Promise<void> => {
    setBusy(true);
    const r = await gameRequest('screenshot');
    setBusy(false);
    if (r.ok) {
      setErr(undefined);
      setPic((r.result as { dataUrl?: string }).dataUrl);
    } else setErr(replyError(r, lang));
  };
  return (
    <div className="game-row" data-testid="game-shot">
      <button className="small" data-testid="game-shot-button" title={g.shotTip} disabled={busy} onClick={() => void take()}>
        {g.shotButton}
      </button>
      {err && <span className="error"> {err}</span>}
      {pic && <img className="game-shot" data-testid="game-shot-image" src={pic} alt="" />}
    </div>
  );
}

/** Creature from a record at the camera (with confirmation). */
function SpawnSection(): ReactNode {
  const g = useGameT();
  const lang = useLang();
  const { selection } = useWorkbench();
  const [id, setId] = useState('');
  const [err, setErr] = useState<string | undefined>();
  useSelectionVersion(selection);
  const picked = selection.latest((s) => s.kind === 'record');
  const place = async (): Promise<void> => {
    const sid = id.trim();
    if (!sid || !window.confirm(g.spawnAsk(sid))) return;
    const r = await spawnAt(sid);
    setErr(r.ok ? undefined : replyError(r, lang));
  };
  return (
    <div className="game-row" data-testid="game-spawn">
      {g.spawnLabel}{' '}
      <input data-testid="game-spawn-input" value={id} placeholder={g.spawnPlaceholder} onChange={(e) => setId(e.target.value)} />{' '}
      {picked && picked.kind === 'record' && (
        <button className="small" title={picked.sid} onClick={() => setId(picked.sid)}>
          ← {picked.sid}
        </button>
      )}{' '}
      <button className="small" data-testid="game-spawn-button" onClick={() => void place()}>
        {g.spawnButton}
      </button>
      {err && <span className="error"> {err}</span>}
    </div>
  );
}

function TraceSection({ onGo }: { onGo: (sid: string) => void }): ReactNode {
  const g = useGameT();
  const lang = useLang();
  const trace = useGameTrace();
  const last = trace.records.slice(-15).reverse();
  const evDef = getEnum(undefined, 'EventTriggerEnum');
  const evName = (e: number): string => (evDef ? formatEnumValue(evDef, e, lang) : String(e));
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
            #{r.seq} · {g.event} {evName(r.event)} · {g.speaker}: {r.speaker?.name ?? '—'} → {r.target?.name ?? '—'} ·{' '}
            {r.chosen ? `${g.chosen}: ${r.chosen.dialogueName || r.chosen.dialogue}` : g.nothing}
          </div>
          <TraceView rec={r} onGo={onGo} />
        </div>
      ))}
    </div>
  );
}

registerPanel({
  id: 'game', group: 'mod',
  title: (t) => GAME_STRINGS[langOf(t)].panel,
  icon: '◉',
  component: GamePanel,
  area: 'right',
  order: 95,
  hint: (t) => GAME_STRINGS[langOf(t)].panelHint,
});
