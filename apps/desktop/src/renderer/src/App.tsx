/**
 * Корень окна: язык и настройки, поиск игры, стартовый экран или открытый проект.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { GameInstallInfo, Lang, ModRef, ProjectRequest, RecoveryInfo, Settings } from '../../shared/api.ts';
import { LangContext, STRINGS } from './i18n.ts';
import { openProject, openRecovered, prefetchVanilla, type Project } from './project.ts';
import { setLiveProject } from './live.ts';
import { StartScreen } from './components/StartScreen.tsx';
import { Editor } from './components/Editor.tsx';
import { RecoveryModal, SettingsModal, type RecoveryChoice } from './components/BackupModals.tsx';

export function App(): ReactNode {
  const [settings, setSettings] = useState<Settings>({ lang: 'ru', recent: [], autosaveMinutes: 5, backupCount: 5 });
  const [games, setGames] = useState<GameInstallInfo[] | undefined>();
  const [game, setGame] = useState<GameInstallInfo | undefined>();
  const [folderError, setFolderError] = useState<string | undefined>();
  const [project, setProject] = useState<Project | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [recovery, setRecovery] = useState<{ req: ProjectRequest; ref: ModRef; info: RecoveryInfo } | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  // Пока виден стартовый экран — готовить ваниль в фоне, чтобы «Ваниль» открылась сразу.
  useEffect(() => {
    if (!game || project || loading) return;
    const id = setTimeout(() => {
      void prefetchVanilla(game).catch(() => undefined);
    }, 50);
    return () => {
      clearTimeout(id);
    };
  }, [game, project, loading]);

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

  /** Открыть проект; `recovered` — байты автосохранения, из которых восстановить правки. */
  const load = (req: ProjectRequest, recovered?: Uint8Array): void => {
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const p = recovered ? await openRecovered(req, recovered) : await openProject(req);
        setProject(p);
        p.bump();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  };

  /** Перед открытием мода: нет ли автосохранения новее файла (после сбоя) — предложить восстановить. */
  const open = (req: ProjectRequest): void => {
    const ref: ModRef =
      req.modPath !== undefined
        ? { path: req.modPath, modName: req.modPath.split(/[\\/]/).pop() ?? req.modPath }
        : { modName: req.modName ?? 'untitled.mod' };
    setLoading(true);
    void window.kedit.findRecovery(ref).then(
      (info) => {
        if (info === null) load(req);
        else {
          setLoading(false);
          setRecovery({ req, ref, info });
        }
      },
      () => {
        load(req);
      },
    );
  };

  const chooseRecovery = (choice: RecoveryChoice): void => {
    const r = recovery;
    if (!r) return;
    setRecovery(undefined);
    void (async () => {
      try {
        if (choice === 'restore') {
          const bytes = await window.kedit.readAutosave(r.ref);
          if (bytes !== null) {
            load(r.req, bytes);
            return;
          }
        } else if (choice === 'as-is') await window.kedit.keepAutosave(r.ref);
        else await window.kedit.autosaveClear(r.ref);
      } catch {
        // Копия недоступна — открываем мод как есть.
      }
      load(r.req);
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
          if (project.dirty) {
            if (!window.confirm(lang.t.unsavedChanges)) return;
            // Отказ от правок: автосохранение уходит в резервные копии, а не пропадает.
            void window.kedit.keepAutosave(project.ref).catch(() => undefined);
          }
          window.kedit.setDirty(false, 'Cactus');
          setProject(undefined);
        }}
        lang={settings.lang}
        onLang={setLang}
        settings={settings}
        onSettings={updateSettings}
      />
    );
  } else {
    body = (
      <>
        <div className="start-lang">
          <button
            data-testid="settings-btn"
            title={lang.t.settings}
            onClick={() => {
              setSettingsOpen(true);
            }}
          >
            ⚙
          </button>
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
  return (
    <LangContext.Provider value={lang}>
      {body}
      {recovery && <RecoveryModal name={recovery.ref.modName} info={recovery.info} onChoose={chooseRecovery} />}
      {settingsOpen && !project && (
        <SettingsModal
          settings={settings}
          onChange={updateSettings}
          onClose={() => {
            setSettingsOpen(false);
          }}
        />
      )}
    </LangContext.Provider>
  );
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
