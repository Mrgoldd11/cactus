/**
 * Окна: зависимости мода, сведения о моде, проверка мода, новая запись.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { itemTypeId, validateMod, formatIssue, type ValidationIssue } from '@kenshi-editor/core';
import type { ModEntry } from '../../../shared/api.ts';
import { useT } from '../i18n.ts';
import { tryEdit } from '../hooks.ts';
import type { Project } from '../project.ts';
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
        <span className="mono">{info.dependencies.join(', ')}</span>
      </div>
    </Modal>
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

/** Список проблем проверки мода (окно «Проверка» и панель «Диагностика»). */
export function IssueList({ project, issues, onGo }: { project: Project; issues: readonly ValidationIssue[]; onGo: (sid: string) => void }): ReactNode {
  if (issues.length === 0) return <p data-testid="validation-ok">✓</p>;
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
            {formatIssue(project.ctx, i)}
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
    return [...s].filter((x) => itemTypeId(x) !== undefined).sort();
  }, [project]);
  const [type, setType] = useState(defaultType ?? types[0] ?? 'ITEM');
  const [name, setName] = useState('');
  const create = (): void => {
    const id = itemTypeId(type);
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
