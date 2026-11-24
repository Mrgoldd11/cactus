/**
 * Windows: mod dependencies, mod info, mod check, new record.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyLayoutFilters, cloneRecord, defaultSample, emptyRecord, uiText, type CategoryNode, type LayoutFilter } from '@kenshi-editor/core';
import type { ModEntry } from '../../../shared/api.ts';
import { useLang, useT, type Strings } from '../i18n.ts';
import { tryEdit } from '../hooks.ts';
import type { AppliedExtension, Project } from '../project.ts';
import { categoryName, newRecordTitle } from '../categoryNames.ts';
import { RecordPicker } from './RecordPicker.tsx';
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
  const lang = useLang();
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
                        {fileName(w.source)}:{w.line}: {uiText(w.texts, lang)}
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

/** What «+ New» creates: type, name, sample to copy (absent — empty record) and the category filters to put on it. */
export interface NewRecordChoice {
  type: number;
  name: string;
  sample?: string;
  filters: readonly LayoutFilter[];
}

const filterText = (f: LayoutFilter): string => `${f.field} ${f.op === '==' ? '=' : '≠'} ${f.value}`;

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * «+ New» window. In a category of the chosen type the record is created in that category
 * (its `fcs_layout.def` conditions are put on it) and copied from a sample: the record selected in
 * the list, otherwise the first one of the category. «empty record» drops the sample.
 */
export function NewRecordModal({
  project,
  node,
  selected,
  onCreate,
  onClose,
}: {
  project: Project;
  node: CategoryNode | undefined;
  selected: string | undefined;
  onCreate: (choice: NewRecordChoice) => void;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const lang = useLang();
  const ctx = project.ctx;
  const types = useMemo(() => {
    const s = new Set([...project.idsByType().keys(), ...(ctx.schema?.types.keys() ?? [])]);
    return [...s].filter((x) => ctx.typeId(x) !== undefined).sort();
  }, [project, ctx]);
  const [type, setType] = useState(node?.type ?? types[0] ?? 'ITEM');
  const [name, setName] = useState('');
  // The sample the user picked for a type; another type falls back to the default sample.
  const [choice, setChoice] = useState<{ type: string; sample: string | undefined } | undefined>();
  const [picking, setPicking] = useState(false);
  const catNode = node?.type !== undefined && node.type === type ? node : undefined;
  const filters = useMemo(() => catNode?.filters ?? [], [catNode]);
  // Sample candidates in list order: the category records, or all records of the type.
  const candidates = useMemo(() => {
    const ids = catNode ? project.idsForNode(catNode) : (project.idsByType().get(type) ?? []);
    const live = ids.filter((sid) => ctx.status(sid) !== 'deleted' && project.entry(sid) !== undefined);
    const hay = (sid: string): string => project.entry(sid)!.hay;
    return live.sort((a, b) => (hay(a) < hay(b) ? -1 : hay(a) > hay(b) ? 1 : 0));
  }, [project, ctx, catNode, type]);
  const autoSample = useMemo(() => (catNode ? defaultSample(ctx, candidates, selected) : undefined), [ctx, catNode, candidates, selected]);
  const sample = choice?.type === type ? choice.sample : autoSample;
  const sampleEntry = sample !== undefined ? project.entry(sample) : undefined;
  // Conditions the record would still miss after creation (a value not known to the editor).
  const unmet = useMemo(() => {
    const typeId = ctx.typeId(type);
    if (filters.length === 0 || typeId === undefined) return [];
    const src = sample !== undefined ? ctx.get(sample) : undefined;
    const draft = src ? cloneRecord(src) : emptyRecord(typeId, '', new Uint8Array());
    return applyLayoutFilters(ctx.schema, draft, filters);
  }, [ctx, type, sample, filters]);
  const catName = catNode ? categoryName(catNode.label, lang) : '';
  const title = catNode ? (newRecordTitle(catNode.label, lang) ?? t.nwInCategory(catName)) : t.nwPlain;
  const create = (): void => {
    const id = ctx.typeId(type);
    if (id !== undefined && name.trim()) onCreate({ type: id, name: name.trim(), ...(sample !== undefined ? { sample } : {}), filters });
  };
  const pickSample = (sid: string | undefined): void => {
    setChoice({ type, sample: sid });
  };
  const openPicker = (): void => {
    setPicking(true);
  };
  return (
    <>
      <Modal
        title={title}
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
          {(sampleEntry !== undefined || candidates.length > 0) && (
            <>
              <label>{t.nwSample}</label>
              {sampleEntry ? (
                <button className="new-record-sample" data-testid="new-record-sample" data-sid={sample} title={t.nwSampleTip} onClick={openPicker}>
                  <span className="grow">{sampleEntry.localized || sampleEntry.name || sampleEntry.sid}</span>
                  <span>▾</span>
                </button>
              ) : (
                <div>
                  <span className="muted">{t.nwEmptyChosen}</span>{' '}
                  <button className="link" data-testid="new-record-sample" onClick={openPicker}>
                    {t.nwUseSample}
                  </button>
                </div>
              )}
              {sampleEntry && (
                <>
                  <span />
                  <div className="small muted" data-testid="new-record-sample-hint">
                    {t.nwSampleHint}
                    <br />
                    {t.nwWithout}{' '}
                    <button
                      className="link"
                      data-testid="new-record-empty"
                      onClick={() => {
                        pickSample(undefined);
                      }}
                    >
                      {t.nwEmptyLink}
                    </button>{' '}
                    {t.nwEmptyTail}
                  </div>
                </>
              )}
            </>
          )}
          {catNode && (
            <>
              <label>{t.nwWill}</label>
              <div data-testid="new-record-will">
                <b>{t.nwWillCategory(catName)}</b>
                <span className="muted">
                  {' — '}
                  {[type, ...filters.map(filterText)].join(', ')}
                  {filters.length === 0 && ` (${t.nwNoCategory})`}
                </span>
              </div>
              {unmet.length > 0 && (
                <>
                  <span />
                  <div className="small warn" data-testid="new-record-unmet">
                    {t.nwUnmet(unmet.map(filterText).join(', '))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </Modal>
      {picking && (
        <RecordPicker
          project={project}
          title={t.nwPickSample}
          targetType={type}
          ids={candidates}
          exclude={NO_IDS}
          onPick={(sid) => {
            pickSample(sid);
            setPicking(false);
          }}
          onClose={() => {
            setPicking(false);
          }}
        />
      )}
    </>
  );
}
