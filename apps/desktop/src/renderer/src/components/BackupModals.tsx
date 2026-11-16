/**
 * Autosave and backup windows: settings, «A newer copy was found», «Mod backups».
 */
import { useEffect, useState, type ReactNode } from 'react';
import { DATA_LOCALE_AUTO, DATA_LOCALE_NONE, dataLocaleFor, LOCALE, type BackupItem, type GameInstallInfo, type GameLocaleInfo, type Lang, type RecoveryInfo, type Settings } from '../../../shared/api.ts';
import { useLang, useT } from '../i18n.ts';
import type { Project } from '../project.ts';
import { Modal } from './widgets.tsx';

export function formatTime(ms: number, lang: Lang): string {
  return new Date(ms).toLocaleString(LOCALE[lang], { dateStyle: 'short', timeStyle: 'medium' });
}

/** Hours and minutes only — for the status bar. */
export function formatClock(ms: number, lang: Lang): string {
  return new Date(ms).toLocaleTimeString(LOCALE[lang], { hour: '2-digit', minute: '2-digit' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SettingsModal({
  settings,
  game,
  onChange,
  onClose,
}: {
  settings: Settings;
  /** Game install whose `locale` folders are offered as data languages. */
  game?: GameInstallInfo | undefined;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const lang = useLang();
  const [locales, setLocales] = useState<GameLocaleInfo[]>([]);
  useEffect(() => {
    if (!game) return;
    let alive = true;
    window.kedit.listGameLocales(game).then(
      (list) => {
        if (alive) setLocales(list);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [game]);
  const choice = settings.dataLocale ?? DATA_LOCALE_AUTO;
  const auto = dataLocaleFor(lang, DATA_LOCALE_AUTO);
  // A saved choice whose folder is gone (or no game yet) still shows as an option.
  const codes = locales.map((l) => l.code);
  if (choice !== DATA_LOCALE_AUTO && choice !== DATA_LOCALE_NONE && !codes.includes(choice)) codes.push(choice);
  const num = (raw: string, fallback: number): number => {
    const n = Number(raw.replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return (
    <Modal
      title={t.settings}
      onClose={onClose}
      testId="settings-modal"
      footer={
        <>
          <span className="grow" />
          <button className="primary" onClick={onClose} data-testid="settings-close">
            {t.close}
          </button>
        </>
      }
    >
      <label className="settings-row">
        <span>{t.settingsAutosave}</span>
        <input
          type="number"
          min={0}
          step={1}
          data-testid="autosave-minutes"
          defaultValue={settings.autosaveMinutes}
          onChange={(e) => {
            onChange({ autosaveMinutes: num(e.target.value, settings.autosaveMinutes) });
          }}
        />
      </label>
      <p className="muted settings-hint">{t.settingsAutosaveHint}</p>
      <label className="settings-row">
        <span>{t.settingsBackups}</span>
        <input
          type="number"
          min={0}
          max={50}
          step={1}
          data-testid="backup-count"
          defaultValue={settings.backupCount}
          onChange={(e) => {
            onChange({ backupCount: Math.floor(num(e.target.value, settings.backupCount)) });
          }}
        />
      </label>
      <p className="muted settings-hint">{t.settingsBackupsHint}</p>
      <label className="settings-row">
        <span>{t.settingsDataLocale}</span>
        <select
          data-testid="data-locale"
          value={choice}
          onChange={(e) => {
            onChange({ dataLocale: e.target.value });
          }}
        >
          <option value={DATA_LOCALE_AUTO}>{t.settingsDataLocaleAuto(auto ?? t.settingsDataLocaleNone)}</option>
          <option value={DATA_LOCALE_NONE}>{t.settingsDataLocaleNone}</option>
          {codes.map((c) => {
            const info = locales.find((l) => l.code === c);
            return (
              <option key={c} value={c}>
                {info && !info.names ? `${c} (${t.settingsDataLocaleTextsOnly})` : c}
              </option>
            );
          })}
        </select>
      </label>
      <p className="muted settings-hint">{t.settingsDataLocaleHint}</p>
    </Modal>
  );
}

export type RecoveryChoice = 'restore' | 'as-is' | 'delete';

export function RecoveryModal({ name, info, onChoose }: { name: string; info: RecoveryInfo; onChoose: (c: RecoveryChoice) => void }): ReactNode {
  const t = useT();
  const lang = useLang();
  return (
    <Modal
      title={t.recoveryTitle}
      onClose={() => {
        onChoose('as-is');
      }}
      testId="recovery-modal"
      footer={
        <>
          <button
            data-testid="recovery-delete"
            onClick={() => {
              onChoose('delete');
            }}
          >
            {t.recoveryDelete}
          </button>
          <span className="grow" />
          <button
            data-testid="recovery-as-is"
            title={t.recoveryOpenAsIsHint}
            onClick={() => {
              onChoose('as-is');
            }}
          >
            {t.recoveryOpenAsIs}
          </button>
          <button
            className="primary"
            data-testid="recovery-restore"
            onClick={() => {
              onChoose('restore');
            }}
          >
            {t.recoveryRestore}
          </button>
        </>
      }
    >
      <p>{t.recoveryText(name)}</p>
      <table className="recovery-table">
        <tbody>
          <tr data-testid="recovery-copy">
            <th>{t.recoveryCopy}</th>
            <td>{formatTime(info.savedAt, lang)}</td>
            <td>{formatSize(info.size)}</td>
          </tr>
          <tr data-testid="recovery-mod">
            <th>{t.recoveryMod}</th>
            {info.modExists && info.modTime !== undefined ? (
              <>
                <td>{formatTime(info.modTime, lang)}</td>
                <td>{formatSize(info.modSize ?? 0)}</td>
              </>
            ) : (
              <td colSpan={2} className="muted">
                {t.recoveryNoFile}
              </td>
            )}
          </tr>
        </tbody>
      </table>
    </Modal>
  );
}

export function BackupsModal({
  project,
  onRestore,
  onStatus,
  onClose,
}: {
  project: Project;
  onRestore: (bytes: Uint8Array, item: BackupItem) => void;
  onStatus: (text: string, kind: 'info' | 'error') => void;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const lang = useLang();
  const [items, setItems] = useState<BackupItem[] | undefined>();
  const [chosen, setChosen] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    void window.kedit.listBackups(project.ref).then((list) => {
      if (!live) return;
      setItems(list);
      setChosen((c) => c ?? list[0]?.id);
    });
    return () => {
      live = false;
    };
  }, [project]);

  const item = items?.find((i) => i.id === chosen);
  const kindName = (k: BackupItem['kind']): string => (k === 'autosave' ? t.backupKindAutosave : k === 'restore-point' ? t.backupKindRestore : t.backupKindBackup);

  const restore = (): void => {
    if (!item) return;
    void window.kedit.readBackup(project.ref, item.id).then((bytes) => {
      if (bytes === null) setError(t.backupExportFailed('no such backup'));
      else onRestore(bytes, item);
    });
  };
  const exportFile = (): void => {
    if (!item) return;
    void window.kedit.exportBackup(project.ref, item.id).then((r) => {
      if (r.ok) onStatus(t.backupExported(r.path), 'info');
      else if (!r.cancelled) setError(r.error === 'game-folder' ? t.backupGameFolder : t.backupExportFailed(r.error));
    });
  };

  return (
    <Modal
      title={t.backupsTitle}
      onClose={onClose}
      testId="backups-modal"
      // No backups yet: nothing to restore, so no footer with dead buttons.
      footer={
        items?.length ? (
        <>
          <span className="muted">{t.backupsNote}</span>
          <span className="grow" />
          <button disabled={!item} onClick={exportFile} data-testid="backup-export">
            {t.backupExport}
          </button>
          <button className="primary" disabled={!item} onClick={restore} data-testid="backup-restore">
            {t.backupRestore}
          </button>
        </>
        ) : undefined
      }
    >
      {items === undefined ? null : items.length === 0 ? (
        <p className="muted" data-testid="backups-empty">
          {t.backupsEmpty}
        </p>
      ) : (
        <ul className="backup-list" data-testid="backup-list">
          {items.map((i) => (
            <li key={i.id}>
              <label className={i.id === chosen ? 'active' : ''}>
                <input
                  type="radio"
                  name="backup"
                  checked={i.id === chosen}
                  onChange={() => {
                    setChosen(i.id);
                  }}
                />
                <span className="backup-time">{formatTime(i.time, lang)}</span>
                <span className="muted">{kindName(i.kind)}</span>
                <span className="muted backup-size">{formatSize(i.size)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error !== undefined && <p className="error">{error}</p>}
    </Modal>
  );
}
