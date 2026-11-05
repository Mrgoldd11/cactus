/**
 * Стартовый экран: папка игры (найденные Steam/GOG или выбранная вручную), открыть ваниль,
 * создать мод, открыть установленный мод из `mods/` или мастерской, открыть файл .mod.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { GameInstallInfo, ModEntry, ProjectRequest } from '../../../shared/api.ts';
import { useT } from '../i18n.ts';

interface Props {
  games: GameInstallInfo[] | undefined;
  game: GameInstallInfo | undefined;
  onGame: (g: GameInstallInfo) => void;
  onChooseFolder: () => void;
  folderError: string | undefined;
  onOpen: (req: ProjectRequest) => void;
  recent: readonly string[];
}

export function StartScreen({ games, game, onGame, onChooseFolder, folderError, onOpen, recent }: Props): ReactNode {
  const t = useT();
  const [mods, setMods] = useState<ModEntry[] | undefined>();
  const [filter, setFilter] = useState('');
  const [newName, setNewName] = useState('');

  useEffect(() => {
    setMods(undefined);
    if (!game) return;
    let live = true;
    void window.kedit.listMods(game).then((m) => {
      if (live) setMods(m);
    });
    return () => {
      live = false;
    };
  }, [game]);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    const list = (mods ?? []).filter((m) => !f || m.fileName.toLowerCase().includes(f) || (m.author ?? '').toLowerCase().includes(f));
    return list.sort((a, b) => (a.loadIndex ?? 1e9) - (b.loadIndex ?? 1e9) || a.fileName.localeCompare(b.fileName));
  }, [mods, filter]);

  const create = (): void => {
    if (!game) return;
    const name = newName.trim();
    if (!name) return;
    onOpen({ game, modName: name.toLowerCase().endsWith('.mod') ? name : `${name}.mod`, dependencies: [] });
  };

  return (
    <div className="start" data-testid="start-screen">
      <h1>{t.appTitle}</h1>
      <section className="start-section">
        <h2>{t.gameFolder}</h2>
        {games === undefined && <p className="muted">{t.detecting}</p>}
        {games?.length === 0 && <p>{t.noGameFound}</p>}
        <div className="game-list">
          {(games ?? []).map((g) => (
            <label key={g.kenshi} className={`game-item ${game?.kenshi === g.kenshi ? 'active' : ''}`}>
              <input
                type="radio"
                name="game"
                checked={game?.kenshi === g.kenshi}
                onChange={() => {
                  onGame(g);
                }}
              />
              <span className="mono">{g.kenshi}</span>
              <span className="badge">{t[`source_${g.source}`]}</span>
            </label>
          ))}
        </div>
        <button onClick={onChooseFolder}>{t.chooseFolder}</button>
        {folderError !== undefined && (
          <p className="error">
            {t.notAGameFolder} <span className="mono">{folderError}</span>
          </p>
        )}
      </section>

      {game && (
        <>
          <section className="start-section start-actions">
            <button
              className="primary"
              data-testid="open-vanilla"
              title={t.openVanillaHint}
              onClick={() => {
                onOpen({ game, modName: 'untitled.mod', dependencies: [] });
              }}
            >
              {t.openVanilla}
            </button>
            <span className="sep" />
            <input
              placeholder={t.newModName}
              value={newName}
              data-testid="new-mod-name"
              onChange={(e) => {
                setNewName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create();
              }}
            />
            <button data-testid="create-mod" disabled={!newName.trim()} onClick={create}>
              {t.newMod}
            </button>
            <span className="sep" />
            <button
              onClick={() => {
                void window.kedit.chooseModFile(game).then((p) => {
                  if (p !== null) onOpen({ game, modPath: p });
                });
              }}
            >
              {t.openModFile}
            </button>
          </section>

          {recent.length > 0 && (
            <section className="start-section">
              <h2>{t.recent}</h2>
              <ul className="recent">
                {recent.map((p) => (
                  <li key={p}>
                    <button
                      className="link mono"
                      onClick={() => {
                        onOpen({ game, modPath: p });
                      }}
                    >
                      {p}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="start-section mods-section">
            <div className="row">
              <h2>{t.installedMods}</h2>
              <input
                placeholder={t.modsSearch}
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                }}
              />
            </div>
            {mods === undefined ? (
              <p className="muted">{t.loading}</p>
            ) : (
              <div className="table-wrap">
                <table className="table" data-testid="mods-table">
                  <thead>
                    <tr>
                      <th>{t.colLoadOrder}</th>
                      <th>{t.colMod}</th>
                      <th>{t.colSource}</th>
                      <th>{t.colAuthor}</th>
                      <th>{t.colRecords}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((m) => (
                      <tr
                        key={m.path}
                        className="clickable"
                        title={m.error ?? m.path}
                        onDoubleClick={() => {
                          onOpen({ game, modPath: m.path });
                        }}
                      >
                        <td className="num">{m.loadIndex !== undefined ? m.loadIndex + 1 : ''}</td>
                        <td>
                          {m.fileName}
                          {m.error !== undefined && <span className="error"> ⚠</span>}
                        </td>
                        <td>{m.source}</td>
                        <td>{m.author}</td>
                        <td className="num">{m.recordCount}</td>
                        <td>
                          <button
                            className="small"
                            onClick={() => {
                              onOpen({ game, modPath: m.path });
                            }}
                          >
                            {t.open}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
