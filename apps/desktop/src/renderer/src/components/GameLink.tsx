/**
 * Game link in the window: status bar icon, «Show in game» / «Move here» buttons
 * for points from «Where in game» and the «How it went in game» block in the conversation player.
 */
import { useState, type ReactNode } from 'react';
import './game.css';
import { formatVec3, type TraceRecord, type Vec3 } from '@kenshi-editor/core';
import { useLang } from '../i18n.ts';
import { cameraTo, lastTraceFor, replyError, setGameTrace, teleportTo, useGameLink, useGameT, useGameTrace } from '../game.ts';

/** Game link icon (status bar). */
export function GameIndicator(): ReactNode {
  const g = useGameT();
  const s = useGameLink();
  const label = !s.connected ? g.off : s.inGame ? g.on : g.menu;
  return (
    <span
      className={`game-link${s.connected ? ' connected' : ''}${s.inGame ? ' in-game' : ''}`}
      data-testid="game-link"
      data-state={!s.connected ? 'off' : s.inGame ? 'game' : 'menu'}
      title={s.connected ? `Kenshi Bridge ${s.version ?? ''}` : g.offHint}
    >
      <span className="live-dot" /> {label}
    </span>
  );
}

const fmt = (p: Vec3): string => p.map((v) => String(Math.round(v))).join(', ');

/** Buttons for a world point: camera (at once) and teleport of the selected (with confirmation). */
/** "?" with an explanation of the coordinate copy/paste workflow. */
export function CoordsHelp(): ReactNode {
  const g = useGameT();
  return (
    <span className="game-help" data-testid="coords-help" title={g.coordsHelp}>
      ?
    </span>
  );
}

/** Copies a point as "x, y, z" (works without the game). */
export function CopyCoords({ pos }: { pos: Vec3 }): ReactNode {
  const g = useGameT();
  const [done, setDone] = useState(false);
  return (
    <span className="game-actions">
      <button
        className="small"
        data-testid="copy-coords"
        onClick={() => {
          void navigator.clipboard.writeText(formatVec3(pos)).then(() => {
            setDone(true);
            setTimeout(() => {
              setDone(false);
            }, 1500);
          });
        }}
      >
        ⧉ {done ? g.copied : g.copyCoords}
      </button>
      <CoordsHelp />
    </span>
  );
}

export function ShowInGame({ pos }: { pos: Vec3 }): ReactNode {
  const g = useGameT();
  const lang = useLang();
  const s = useGameLink();
  const [err, setErr] = useState<string | undefined>();
  const run = async (fn: () => ReturnType<typeof cameraTo>): Promise<void> => {
    const r = await fn();
    setErr(r.ok ? undefined : replyError(r, lang));
  };
  if (!s.inGame) return <CopyCoords pos={pos} />;
  return (
    <span className="game-actions">
      <button className="small" data-testid="show-in-game" title={g.showInGameTip} onClick={() => void run(() => cameraTo(pos))}>
        ⌖ {g.showInGame}
      </button>
      <button
        className="small"
        data-testid="teleport-here"
        title={g.teleportTip}
        onClick={() => {
          if (window.confirm(g.teleportAsk(fmt(pos)))) void run(() => teleportTo(pos));
        }}
      >
        ⇢
      </button>
      <CopyCoords pos={pos} />
      {err && <span className="error"> {err}</span>}
    </span>
  );
}

/** Candidates of one trace record: the chosen one, those filtered out by conditions, those never reached. */
export function TraceView({ rec, onGo, name }: { rec: TraceRecord; onGo?: (sid: string) => void; name?: (sid: string) => string }): ReactNode {
  const g = useGameT();
  return (
    <ul className="game-trace" data-testid="game-trace-record">
      {rec.candidates.map((c) => (
        <li key={c.id} className={c.chosen ? 'chosen' : c.conditions} data-cand={c.id} data-status={c.chosen ? 'chosen' : c.conditions}>
          {c.chosen ? '✓ ' : '· '}
          {onGo ? (
            <a href="#" onClick={(e) => { e.preventDefault(); onGo(c.id); }}>
              {name ? name(c.id) : c.name}
            </a>
          ) : (
            c.name
          )}{' '}
          <span className="muted">
            {c.id} · {g.weight} {c.score}
            {c.chanceTemporary < 100 || c.chancePermanent < 100 ? ` · ${c.chanceTemporary}%/${c.chancePermanent}%` : ''} — {c.chosen ? g.chosen : g[`st_${c.conditions}`]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** «How it went in game» next to the editor's result: the game's last pick for the character on the event. */
export function AsInGame({ sid, event, editorChoice, onGo, name }: { sid: string; event: number; editorChoice: string | undefined; onGo: (sid: string) => void; name: (sid: string) => string }): ReactNode {
  const g = useGameT();
  const s = useGameLink();
  if (!s.connected) return null;
  return <AsInGameBody sid={sid} event={event} editorChoice={editorChoice} onGo={onGo} name={name} g={g} />;
}

function AsInGameBody({ sid, event, editorChoice, onGo, name, g }: { sid: string; event: number; editorChoice: string | undefined; onGo: (sid: string) => void; name: (sid: string) => string; g: ReturnType<typeof useGameT> }): ReactNode {
  const trace = useGameTrace();
  const rec = lastTraceFor(trace.records, sid, event);
  const gameChoice = rec?.chosen?.dialogue;
  return (
    <details className="as-in-game" data-testid="as-in-game" open={rec !== undefined}>
      <summary>
        {g.asInGame}
        {rec && (
          <span className={gameChoice === editorChoice ? 'ok' : 'warn'} data-testid="as-in-game-verdict">
            {' — '}
            {gameChoice === editorChoice ? g.same : g.differs}
          </span>
        )}
      </summary>
      {!trace.on ? (
        <p className="muted">
          {g.asInGameOff}{' '}
          <button className="small" data-testid="trace-on" onClick={() => void setGameTrace(true)}>
            {g.traceOn}
          </button>
        </p>
      ) : rec ? (
        <TraceView rec={rec} onGo={onGo} name={name} />
      ) : (
        <p className="muted">{g.asInGameNone}</p>
      )}
    </details>
  );
}
