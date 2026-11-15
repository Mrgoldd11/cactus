/**
 * Вкладка «Где в игре»: цепочка обратных ссылок от записи до места в мире (предмет ← список
 * торговца ← отряд ← город) с координатами из файлов уровня. Каждый шаг пути — ссылка на
 * запись с категорией. Мир читается при первом открытии вкладки; до этого — цепочка без координат.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  displayName,
  formatPosition,
  whereInGame,
  type WhereFact,
  type WherePlace,
  type WhereRecordInfo,
  type WhereResult,
  type WhereStep,
  type WorldIndex,
} from '@kenshi-editor/core';
import { inLang, useLang, useT } from '../i18n.ts';
import type { Project } from '../project.ts';
import { ShowInGame } from './GameLink.tsx';

interface Props {
  project: Project;
  sid: string;
  version: number;
  onGo: (sid: string) => void;
}

const PAGE = 25;

export function WhereTab({ project, sid, version, onGo }: Props): ReactNode {
  const t = useT();
  const [world, setWorld] = useState<WorldIndex | undefined>();
  const [worldError, setWorldError] = useState<string | undefined>();
  const [shown, setShown] = useState(PAGE);
  const [icon, setIcon] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    project.world().then(
      (w) => {
        if (alive) setWorld(w);
      },
      (e: unknown) => {
        if (alive) setWorldError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [project]);

  useEffect(() => {
    setShown(PAGE);
  }, [sid]);

  const res = useMemo((): WhereResult | string => {
    try {
      return whereInGame(project.ctx, sid, world ? { world } : {});
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [project, sid, version, world]);

  const iconPath = typeof res === 'string' ? undefined : res.root.icon;
  useEffect(() => {
    setIcon(null);
    if (iconPath === undefined) return;
    let alive = true;
    void project.icon(iconPath).then((url) => {
      if (alive) setIcon(url);
    });
    return () => {
      alive = false;
    };
  }, [project, iconPath]);

  if (typeof res === 'string') return <p className="muted">{res}</p>;
  const stats = world?.stats();
  return (
    <div className="where" data-testid="where" data-sid={sid}>
      <div className="where-head">
        {icon && <img className="where-icon" src={icon} alt="" data-testid="where-icon" />}
        <div>
          <div className="muted small">
            {worldError !== undefined
              ? `${t.whereWorldFailed}: ${worldError}`
              : stats
                ? `${t.whereWorld}: ${t.whereTowns} ${stats.towns}, ${t.whereBuildings} ${stats.buildings}, ${t.whereZoneFiles} ${stats.files}`
                : t.whereLoadingWorld}
          </div>
          <div className="muted small">{t.whereHint}</div>
        </div>
      </div>
      {res.facts.length === 0 && <p className="muted">{t.whereNothing}</p>}
      {res.facts.slice(0, shown).map((f, i) => (
        <FactView key={`${f.role}:${f.holder?.id ?? i}`} fact={f} onGo={onGo} />
      ))}
      {res.facts.length > shown && (
        <button
          className="small"
          onClick={() => {
            setShown((n) => n + PAGE);
          }}
        >
          {t.whereMore} ({res.facts.length - shown})
        </button>
      )}
    </div>
  );
}

function RecLink({ r, onGo }: { r: WhereRecordInfo; onGo: (sid: string) => void }): ReactNode {
  return (
    <button
      className="link"
      title={`${r.type} ${r.name} [${r.id}]`}
      onClick={() => {
        onGo(r.id);
      }}
    >
      {displayName(r)}
    </button>
  );
}

function PathView({ path, onGo }: { path: readonly WhereStep[]; onGo: (sid: string) => void }): ReactNode {
  const lang = useLang();
  return (
    <span className="where-path">
      {path.map((s, i) => (
        <span key={`${s.id}:${i}`} className="where-step">
          {'← '}
          <span className="badge tiny">{s.type}</span> <RecLink r={s} onGo={onGo} />{' '}
          <span className="muted mono" title={inLang(s, lang)}>
            ({s.category})
          </span>
        </span>
      ))}
    </span>
  );
}

function placeLabel(p: WherePlace): string {
  return `${displayName(p)}${p.variant ? '*' : ''}`;
}

function FactView({ fact: f, onGo }: { fact: WhereFact; onGo: (sid: string) => void }): ReactNode {
  const t = useT();
  const towns = f.places.filter((p) => p.kind === 'town');
  const others = f.places.filter((p) => p.kind !== 'town' && p.kind !== 'building');
  const located = f.places.filter((p) => p.positions.length > 0);
  const leader = f.holder?.squad?.leader[0];
  const sq = f.holder?.squad;
  return (
    <div className="where-fact" data-testid="where-fact" data-role={f.role} data-holder={f.holder?.id ?? ''}>
      <div className="where-summary">
        <span className={`badge role-${f.role}`}>{t[`whereRole_${f.role}`]}</span>{' '}
        {f.holder && (
          <>
            {leader ? (
              <>
                <RecLink r={leader} onGo={onGo} /> <span className="muted">({t.whereSquad} </span>
                <RecLink r={f.holder} onGo={onGo} />
                <span className="muted">)</span>
              </>
            ) : (
              <RecLink r={f.holder} onGo={onGo} />
            )}
          </>
        )}
        {towns.length > 0 && ': '}
        {towns.map((p, i) => (
          <Fragment key={p.id}>
            {i > 0 && ', '}
            <button
              className="link strong"
              title={p.variant ? `${t.whereVariantOnly}: ${p.variant.name}` : `${p.name} [${p.id}]`}
              onClick={() => {
                onGo(p.id);
              }}
            >
              {placeLabel(p)}
            </button>
          </Fragment>
        ))}
        {others.length > 0 && (
          <span className="muted">
            {towns.length > 0 ? '; ' : ': '}
            {others.map((p) => `${t[`whereKind_${p.kind}`]} ${displayName(p)}`).join(', ')}
          </span>
        )}
        {f.places.length === 0 && <span className="muted"> — {t.whereNoPlace}</span>}
      </div>
      {f.path.length > 0 && (
        <div className="where-line">
          <span className="muted">{t.wherePath}:</span> <PathView path={f.path} onGo={onGo} />
        </div>
      )}
      {sq && (sq.trader || sq.members.length > 0 || sq.faction.length > 0 || sq.interior) && (
        <div className="where-line muted small">
          {[
            sq.trader ? t.whereTrader : '',
            sq.members.length ? `${t.whereWith} ${sq.members.map(displayName).join(', ')}` : '',
            sq.faction.length ? `${t.whereFaction} ${sq.faction.map(displayName).join(', ')}` : '',
            sq.interior ? `${t.whereInterior} «${sq.interior}»` : '',
          ]
            .filter(Boolean)
            .join('; ')}
        </div>
      )}
      {located.length > 0 && (
        <details className="where-places" open={located.length <= 4}>
          <summary className="muted">
            {t.whereCoords} ({located.reduce((n, p) => n + p.positions.length, 0)})
          </summary>
          <table className="table where-table">
            <tbody>
              {located.flatMap((p) =>
                p.positions.slice(0, 8).map((pos, i) => (
                  <tr key={`${p.id}:${i}`} data-testid="where-place" data-place={p.id}>
                    <td className="muted">{t[`whereKind_${p.kind}`]}</td>
                    <td>
                      {p.kind === 'building' ? (
                        <>
                          <RecLink r={{ ...p, name: pos.label ?? p.name }} onGo={onGo} />
                          {pos.town && (
                            <>
                              , <RecLink r={pos.town} onGo={onGo} />
                            </>
                          )}
                        </>
                      ) : (
                        <RecLink r={p} onGo={onGo} />
                      )}
                    </td>
                    <td className="mono selectable">
                      {formatPosition(pos.position)}
                      {pos.zone && <span className="muted">{` (${t.whereZone} ${pos.zone.x}.${pos.zone.y})`}</span>}
                      <ShowInGame pos={pos.position} />
                    </td>
                    <td>{p.path.length > 0 && <PathView path={p.path} onGo={onGo} />}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
