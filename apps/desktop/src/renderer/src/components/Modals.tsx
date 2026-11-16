/**
 * Windows: mod dependencies, mod info, mod check, new record.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { validateMod, formatIssue, type ValidationIssue } from '@kenshi-editor/core';
import type { ModEntry } from '../../../shared/api.ts';
import { useLang, useT, type Strings } from '../i18n.ts';
import { tryEdit } from '../hooks.ts';
import type { AppliedExtension, Project } from '../project.ts';
import { Modal } from './widgets.tsx';

export function DependenciesModal({ project, onApply, onClose }: { project: Project; onApply: (deps: string[]) => void; onClose: () => void }): ReactNode {
  const t = useT();
  const ctx = project.ctx;
  const [mods, setMods] = useState<ModEntry[] | undefined>();
  const [chosen, setChosen] = useState<string[]>(() => [...ctx.info.dependencies]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let live = true;
    void window.kedit.listMods(project.bundle.game).then((m) => {
      if (live) setMods(m);
    });
    return () => {
      live = false;
    };
  }, [project]);

  const own = ctx.modName.toLowerCase();
  const list = useMemo(() => {
    const byName = new Map<string, ModEntry>();
    for (const m of mods ?? []) if (m.fileName.toLowerCase() !== own && !byName.has(m.fileName.toLowerCase())) byName.set(m.fileName.toLowerCase(), m);
    const rows = [...byName.values()];
    for (const d of chosen) if (!byName.has(d.toLowerCase())) rows.push({ fileName: d, path: '', source: 'other', error: t.missingDeps });
    const f = filter.toLowerCase();
    return rows
      .filter((m) => !f || m.fileName.toLowerCase().includes(f) || chosen.includes(m.fileName))
      .sort((a, b) => (a.loadIndex ?? 1e9) - (b.loadIndex ?? 1e9) || a.fileName.localeCompare(b.fileName));
  }, [mods, chosen, filter, own, t]);

  const toggle = (name: string, on: boolean): void => {
    setChosen((c) => (on ? [...c, name] : c.filter((x) => x !== name)));
  };
  const apply = (): void => {
    const order = new Map(list.map((m, i) => [m.fileName, m.loadIndex ?? 1e6 + i]));
    onApply([...chosen].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)));
  };

  return (
    <Modal
      title={t.dependencies}
      onClose={onClose}
      wide
      testId="deps-modal"
      footer={
        <>
          <span className="muted">{t.depsReloadNote}</span>
          <span className="grow" />
          <button onClick={onClose}>{t.cancel}</button>
          <button className="primary" onClick={apply} data-testid="deps-apply">
            {t.apply}
          </button>
        </>
      }
    >
      <p className="muted">{t.depsHint}</p>
      <input
        className="search"
        placeholder={t.modsSearch}
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
        }}
      />
      {mods === undefined ? (
        <p className="muted">{t.loading}</p>
      ) : (
        <div className="table-wrap tall">
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>{t.colLoadOrder}</th>
                <th>{t.colMod}</th>
                <th>{t.colSource}</th>
                <th>{t.colAuthor}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.fileName} className={m.error !== undefined ? 'error' : ''} title={m.error ?? m.path}>
                  <td>
                    <input
                      type="checkbox"
                      checked={chosen.includes(m.fileName)}
                      onChange={(e) => {
                        toggle(m.fileName, e.target.checked);
                      }}
                    />
                  </td>
                  <td className="num">{m.loadIndex !== undefined ? m.loadIndex + 1 : ''}</td>
                  <td>{m.fileName}</td>
                  <td>{m.source}</td>
                  <td>{m.author}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

export function ModInfoModal({ project, onReport, onClose }: { project: Project; onReport: (err: string | undefined) => void; onClose: () => void }): ReactNode {
  const t = useT();
  const info = project.ctx.info;
  const [author, setAuthor] = useState(info.author);
  const [description, setDescription] = useState(info.description);
  const [version, setVersion] = useState(String(info.version));
  const apply = (): void => {
    const v = Number(version);
    onReport(
      tryEdit(() => {
        if (!Number.isInteger(v)) throw new Error(`${t.version}: ${version}`);
        project.ctx.setModInfo({ author, description, version: v });
      }),
    );
    onClose();
  };
  return (
    <Modal
      title={t.modInfo}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button onClick={onClose}>{t.cancel}</button>
          <button className="primary" onClick={apply}>
            {t.apply}
          </button>
        </>
      }
    >
      <div className="form">
        <label>{t.fileName}</label>
        <span className="mono">{info.fileName}</span>
        <label>{t.author}</label>
        <input
          value={author}
          onChange={(e) => {
            setAuthor(e.target.value);
          }}
        />
        <label>{t.version}</label>
        <input
          value={version}
          onChange={(e) => {
            setVersion(e.target.value);
          }}
        />
        <label>{t.description}</label>
        <textarea
          rows={6}
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
        />
        <label>{t.dependencies}</label>
        {info.dependencies.length > 0 ? <span className="mono">{info.dependencies.join(', ')}</span> : <span className="muted">{t.noDependencies}</span>}
        <ExtensionNote project={project} />
      </div>
    </Modal>
  );
}

/** How many names of one kind the note lists before it says "+N more". */
const EXT_LIST_MAX = 6;

/** What one schema extension adds, in one line: `types VARIABLE=900; fields DIALOGUE.x, …`. */
function extensionLine(e: AppliedExtension, t: Strings): string {
  const s = e.summary;
  if (!s) return t.extNothing;
  const list = (label: string, items: readonly string[]): string[] => {
    if (items.length === 0) return [];
    const shown = items.slice(0, EXT_LIST_MAX).join(', ');
    return [`${label} ${items.length > EXT_LIST_MAX ? `${shown}, ${t.extMore(items.length - EXT_LIST_MAX)}` : shown}`];
  };
  const parts = [
    ...list(t.extTypes, s.types.map((x) => (x.id !== undefined ? `${x.name}=${String(x.id)}` : `${x.name} (${t.extNoNumber})`))),
    ...list(t.extFields, s.fields),
    ...list(t.extEnums, s.enums),
    ...list(t.extEnumValues, s.enumValues),
  ];
  return parts.length > 0 ? parts.join('; ') : t.extNothing;
}

/** File name of a path: warnings name the file of the extension, not the whole path. */
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/**
 * Rows of the "Mod info" form about the schema extensions (FCS Extended files) applied to the
 * mod: what each adds, how many warnings its files gave, its DLL plugins. Nothing when the mod
 * and its dependencies have no such files.
 */
function ExtensionNote({ project }: { project: Project }): ReactNode {
  const t = useT();
  const list = useMemo(() => project.extensions, [project]);
  if (list.length === 0) return null;
  return (
    <>
      <label>{t.extTitle}</label>
      <div data-testid="ext-note">
        {list.map((e, n) => {
          const warnings = e.summary?.warnings ?? [];
          return (
            <div key={n} data-testid="ext-item">
              <b>{e.name}</b>: {extensionLine(e, t)}
              {e.plugins.length > 0 && <div className="small muted">{t.extPlugins(e.plugins.join(', '))}</div>}
              {warnings.length > 0 && (
                <details className="small warn" data-testid="ext-warnings">
                  <summary>{t.extWarnings(warnings.length)}</summary>
                  <ul className="issues">
                    {warnings.map((w, i) => (
                      <li key={i}>
                        {fileName(w.source)}:{w.line}: {w.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
        <div className="small muted">{t.extNote}</div>
      </div>
    </>
  );
}

export function ValidationModal({ project, onGo, onClose }: { project: Project; onGo: (sid: string) => void; onClose: () => void }): ReactNode {
  const t = useT();
  const issues = useMemo(() => validateMod(project.ctx), [project]);
  const errors = issues.filter((i) => i.severity === 'error').length;
  return (
    <Modal
      title={`${t.validation}: ${errors} ${t.errors}, ${issues.length - errors} ${t.warnings}`}
      onClose={onClose}
      wide
      testId="validation-modal"
    >
      <IssueList project={project} issues={issues} onGo={onGo} />
    </Modal>
  );
}

/** List of mod check problems (the «Check» window and the «Diagnostics» panel). */
export function IssueList({ project, issues, onGo }: { project: Project; issues: readonly ValidationIssue[]; onGo: (sid: string) => void }): ReactNode {
  const lang = useLang();
  const t = useT();
  if (issues.length === 0) return <p className="panel-empty muted" data-testid="validation-ok">✓ {t.diagnosticsOk}</p>;
  return (
    <ul className="issues">
      {issues.map((i, n) => (
        <li key={n} className={i.severity}>
          <button
            className="link"
            onClick={() => {
              onGo(i.stringId);
            }}
          >
            {formatIssue(project.ctx, i, lang)}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function NewRecordModal({ project, defaultType, onCreate, onClose }: { project: Project; defaultType: string | undefined; onCreate: (type: number, name: string) => void; onClose: () => void }): ReactNode {
  const t = useT();
  const types = useMemo(() => {
    const s = new Set([...project.idsByType().keys(), ...(project.ctx.schema?.types.keys() ?? [])]);
    return [...s].filter((x) => project.ctx.typeId(x) !== undefined).sort();
  }, [project]);
  const [type, setType] = useState(defaultType ?? types[0] ?? 'ITEM');
  const [name, setName] = useState('');
  const create = (): void => {
    const id = project.ctx.typeId(type);
    if (id !== undefined && name.trim()) onCreate(id, name.trim());
  };
  return (
    <Modal
      title={t.newRecord}
      onClose={onClose}
      testId="new-record-modal"
      footer={
        <>
          <span className="grow" />
          <button onClick={onClose}>{t.cancel}</button>
          <button className="primary" disabled={!name.trim()} onClick={create} data-testid="new-record-create">
            {t.create}
          </button>
        </>
      }
    >
      <div className="form">
        <label>{t.type}</label>
        <select
          value={type}
          data-testid="new-record-type"
          onChange={(e) => {
            setType(e.target.value);
          }}
        >
          {types.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <label>{t.name}</label>
        <input
          autoFocus
          value={name}
          data-testid="new-record-name"
          onChange={(e) => {
            setName(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
        />
      </div>
    </Modal>
  );
}
