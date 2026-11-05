/**
 * Корень окна: язык и настройки, поиск игры, стартовый экран или открытый проект.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { GameInstallInfo, Lang, ProjectRequest, Settings } from '../../shared/api.ts';
import { LangContext, STRINGS } from './i18n.ts';
import { Project } from './project.ts';
import { setLiveProject } from './live.ts';
import { StartScreen } from './components/StartScreen.tsx';
import { Editor } from './components/Editor.tsx';

export function App(): ReactNode {
  const [settings, setSettings] = useState<Settings>({ lang: 'ru', recent: [] });
  const [games, setGames] = useState<GameInstallInfo[] | undefined>();
  const [game, setGame] = useState<GameInstallInfo | undefined>();
  const [folderError, setFolderError] = useState<string | undefined>();
  const [project, setProject] = useState<Project | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void (async () => {
      const s = await window.kedit.getSettings();
      setSettings(s);
      const found = await window.kedit.detectGames();
      setGames(found);
      setGame(found.find((g) => g.kenshi === s.gameDir) ?? found[0]);
    })();
  }, []);

  useEffect(() => {
    setLiveProject(project);
  }, [project]);

  const lang = useMemo(() => ({ lang: settings.lang, t: STRINGS[settings.lang] }), [settings.lang]);

  const updateSettings = (patch: Partial<Settings>): void => {
    void window.kedit.setSettings(patch).then(setSettings);
  };

  const chooseGame = (g: GameInstallInfo): void => {
    setGame(g);
    setFolderError(undefined);
    updateSettings({ gameDir: g.kenshi });
  };

  const chooseFolder = (): void => {
    void window.kedit.chooseGameDir().then((r) => {
      if (r === null) return;
      if ('error' in r) {
        setFolderError(r.error);
        return;
      }
      setGames((prev) => [...(prev ?? []).filter((g) => g.kenshi !== r.kenshi), r]);
      chooseGame(r);
    });
  };

  const open = (req: ProjectRequest): void => {
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const bundle = await window.kedit.openProject(req);
        // Дать окну нарисовать «Загрузка…» до тяжёлого разбора.
        await new Promise((r) => setTimeout(r, 20));
        const p = new Project(bundle);
        setProject(p);
        p.bump();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  };

  const setLang = (l: Lang): void => {
    updateSettings({ lang: l });
  };

  let body: ReactNode;
  if (loading) body = <div className="loading" data-testid="loading">{lang.t.loadingData}</div>;
  else if (project) {
    body = (
      <Editor
        project={project}
        onReplace={setProject}
        onClose={() => {
          if (project.dirty && !window.confirm(lang.t.unsavedChanges)) return;
          window.kedit.setDirty(false, 'Kenshi Mod Editor');
          setProject(undefined);
        }}
        lang={settings.lang}
        onLang={setLang}
      />
    );
  } else {
    body = (
      <>
        <div className="start-lang">
          <LangSwitch lang={settings.lang} onLang={setLang} />
        </div>
        <StartScreen
          games={games}
          game={game}
          onGame={chooseGame}
          onChooseFolder={chooseFolder}
          folderError={folderError}
          onOpen={open}
          recent={settings.recent}
        />
        {error !== undefined && <p className="error start-error">{error}</p>}
      </>
    );
  }
  return <LangContext.Provider value={lang}>{body}</LangContext.Provider>;
}

export function LangSwitch({ lang, onLang }: { lang: Lang; onLang: (l: Lang) => void }): ReactNode {
  return (
    <span className="lang-switch" data-testid="lang-switch">
      {(['en', 'ru'] as const).map((l) => (
        <button
          key={l}
          className={l === lang ? 'active' : ''}
          data-testid={`lang-${l}`}
          onClick={() => {
            onLang(l);
          }}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </span>
  );
}
