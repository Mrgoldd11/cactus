/**
 * Панель «Перевод» (как режим перевода в FCS): тексты оригинала — имена и текстовые поля мода,
 * который переводят, — и рядом перевод из редактируемого мода. Редактируемый мод — мод-перевод:
 * зависит от оригинала и задаёт поверх только тексты. Выгрузка в CSV/JSON/PO и загрузка
 * обратно (одна отмена); проверка, что мод-перевод не меняет ничего, кроме текстов.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  applyTranslationRows,
  ensureTranslationDependency,
  formatTranslationCsv,
  formatTranslationJson,
  formatTranslationPo,
  isVanillaLayer,
  parseTranslationFile,
  setTranslation,
  summarizeTranslation,
  translationExtras,
  translationRows,
  type ApplyTranslationReport,
  type TranslationFileRow,
  type TranslationRow,
} from '@kenshi-editor/core';
import type { TextFileKind } from '../../../../shared/api.ts';
import { errorText, useLang, useT } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { CommitInput } from '../../components/widgets.tsx';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';
import { useInstalledMods } from './mods.tsx';

/** Строк за раз (у поля перевода — своё поле ввода): дальше — «Показать ещё». */
const PAGE = 200;

type Filter = 'all' | 'todo' | 'done';

interface ImportState {
  report: ApplyTranslationReport;
  /** Строки файла с изменившимся оригиналом — для «Всё равно применить». */
  staleRows: TranslationFileRow[];
  otherSource?: string;
}

function stem(name: string): string {
  return name.replace(/\.mod$/i, '');
}

function TranslatePanel(): ReactNode {
  const t = useT();
  const { project, go, reload, report, status } = useWorkbench();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const { mods } = useInstalledMods(project.bundle.game);

  // Оригиналы — зависимости из заголовка мода (не ваниль), которые загружены.
  const sources = useMemo(() => {
    const loaded = new Set(ctx.layers.map((l) => l.name.toLowerCase()));
    return ctx.info.dependencies.filter((d) => !isVanillaLayer(d) && loaded.has(d.toLowerCase()));
  }, [ctx, version]);
  const [picked, setPicked] = useState<string>();
  const source = picked !== undefined && sources.some((s) => s.toLowerCase() === picked.toLowerCase()) ? picked : sources[0];
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<ImportState>();

  const all = useMemo(() => (source === undefined ? [] : translationRows(ctx, source)), [ctx, source, version]);
  const summary = useMemo(() => summarizeTranslation(all), [all]);
  const lang = useLang();
  const extras = useMemo(() => translationExtras(ctx, sources, lang), [ctx, sources, version, lang]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      if (filter === 'todo' && r.status !== 'todo') return false;
      if (filter === 'done' && r.status === 'todo') return false;
      return q === '' || `${r.id}\n${r.record}\n${r.field}\n${r.original}\n${r.translation ?? ''}`.toLowerCase().includes(q);
    });
  }, [all, filter, query]);

  const candidates = useMemo(() => {
    const loaded = new Set(ctx.layers.map((l) => l.name.toLowerCase()));
    return (mods ?? []).filter((m) => !loaded.has(m.fileName.toLowerCase()) && m.fileName.toLowerCase() !== ctx.modName.toLowerCase());
  }, [mods, ctx]);

  const addSource = (fileName: string): void => {
    setBusy(true);
    setPicked(fileName);
    void reload({ dependencies: [...ctx.info.dependencies, fileName] }).finally(() => {
      setBusy(false);
    });
  };

  const commit = (r: TranslationRow, text: string): void => {
    if (source === undefined) return;
    report(
      tryEdit(() => {
        ctx.transaction(`перевод ${r.id}: ${r.field}`, () => {
          setTranslation(ctx, r.id, r.field, text);
          ensureTranslationDependency(ctx, source);
        });
      }),
    );
  };

  const exportAs = (kind: TextFileKind): void => {
    if (source === undefined) return;
    const text = kind === 'csv' ? formatTranslationCsv(all) : kind === 'json' ? formatTranslationJson(source, all) : formatTranslationPo(source, all);
    void window.kedit.saveTextFile(`${stem(source)} - ${stem(ctx.modName)}.${kind}`, kind, text).then((r) => {
      if (r.ok) status({ kind: 'info', text: (tt) => tt.trExported(r.path) });
      else if (!r.cancelled) {
        const err = r.error;
        status({ kind: 'error', text: (tt) => (err === 'game-folder' ? tt.trExportGameFolder : tt.trExportError(err)) });
      }
    });
  };

  const importFile = (): void => {
    if (source === undefined) return;
    void window.kedit.openTextFile().then((f) => {
      if (f === null) return;
      if ('error' in f) {
        const err = f.error;
        status({ kind: 'error', text: (tt) => tt.trImportError(err) });
        return;
      }
      let parsed: ReturnType<typeof parseTranslationFile>;
      try {
        parsed = parseTranslationFile(f.text);
      } catch (e) {
        const err = errorText(e);
        status({ kind: 'error', text: (tt) => tt.trImportError(err) });
        return;
      }
      let rep: ApplyTranslationReport | undefined;
      report(
        tryEdit(() => {
          rep = applyTranslationRows(ctx, source, parsed.rows);
        }),
      );
      if (!rep) return;
      const stale = new Set(rep.stale.map((s) => `${s.id}\n${s.field}`));
      setImported({
        report: rep,
        staleRows: parsed.rows.filter((r) => stale.has(`${r.id}\n${r.field}`)),
        ...(parsed.source !== undefined && parsed.source.toLowerCase() !== source.toLowerCase() ? { otherSource: parsed.source } : {}),
      });
    });
  };

  const applyStale = (): void => {
    if (!imported || source === undefined) return;
    const rows = imported.staleRows;
    report(
      tryEdit(() => {
        applyTranslationRows(ctx, source, rows, { applyStale: true });
      }),
    );
    setImported({ ...imported, report: { ...imported.report, stale: [] }, staleRows: [] });
  };

  const sourcePicker = (
    <select
      value=""
      disabled={busy || candidates.length === 0}
      title={t.trAddSourceTip}
      onChange={(e) => {
        if (e.target.value !== '') addSource(e.target.value);
      }}
      data-testid="tr-add-source"
    >
      <option value="">{t.trAddSource}</option>
      {candidates.map((m) => (
        <option key={m.path} value={m.fileName}>
          {stem(m.fileName)}
        </option>
      ))}
    </select>
  );

  if (source === undefined) {
    return (
      <div className="mods-panel" data-testid="translate-panel">
        <div className="muted mods-panel-note">{t.trHint}</div>
        <Empty text={t.trNoSource} />
        <div className="mods-panel-bar">{sourcePicker}</div>
      </div>
    );
  }

  const ir = imported?.report;
  return (
    <div className="mods-panel" data-testid="translate-panel">
      <div className="mods-panel-bar">
        <label>
          {t.trSource}{' '}
          <select value={source} onChange={(e) => { setPicked(e.target.value); setLimit(PAGE); }} data-testid="tr-source">
            {sources.map((s) => (
              <option key={s} value={s}>
                {stem(s)}
              </option>
            ))}
          </select>
        </label>
        {sourcePicker}
        <span className="muted" data-testid="tr-summary">
          {t.trSummary(summary.done + summary.same, summary.total)}
        </span>
        <span className="tr-actions">
          <span title={t.trExportTip}>{t.trExport}:</span>
          {(['csv', 'po', 'json'] as const).map((k) => (
            <button key={k} className="chip" disabled={all.length === 0} onClick={() => { exportAs(k); }} data-testid={`tr-export-${k}`}>
              {k.toUpperCase()}
            </button>
          ))}
          <button className="chip" title={t.trImportTip} onClick={importFile} data-testid="tr-import">
            {t.trImport}
          </button>
        </span>
      </div>
      <div className="mods-panel-bar">
        <input type="search" placeholder={t.trSearch} value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} data-testid="tr-search" />
        {(['all', 'todo', 'done'] as const).map((f) => (
          <label key={f}>
            <input type="radio" name="tr-filter" checked={filter === f} onChange={() => { setFilter(f); setLimit(PAGE); }} data-testid={`tr-filter-${f}`} />{' '}
            {f === 'all' ? t.trFilterAll : f === 'todo' ? `${t.trFilterTodo} (${summary.todo})` : t.trFilterDone}
          </label>
        ))}
      </div>
      <div className="muted mods-panel-note">{t.trNote}</div>
      {ir && (
        <div className="tr-import-report" data-testid="tr-import-report">
          {imported.otherSource !== undefined && <div className="warn">{t.trImportOtherSource(imported.otherSource)}</div>}
          <div>{t.trImportReport(ir.applied, ir.unchanged, ir.empty)}</div>
          {ir.unknown.length > 0 && <div className="warn">{t.trImportUnknown(ir.unknown.length)}</div>}
          {ir.stale.length > 0 && (
            <details>
              <summary className="warn">{t.trImportStale(ir.stale.length)}</summary>
              <ul>
                {ir.stale.slice(0, 50).map((s) => (
                  <li key={`${s.id}\n${s.field}`}>
                    <span className="mono">{s.id} {s.field}</span>: {t.trStaleWas} «{s.was}», {t.trStaleNow} «{s.now}»
                  </li>
                ))}
              </ul>
              <button className="chip" onClick={applyStale} data-testid="tr-apply-stale">
                {t.trApplyStale(ir.stale.length)}
              </button>
            </details>
          )}
          <button className="link" onClick={() => { setImported(undefined); }}>
            ✕
          </button>
        </div>
      )}
      <details className="tr-checks" data-testid="tr-checks">
        <summary className={extras.nonText.length > 0 ? 'warn' : 'muted'}>
          {t.trChecks}: {extras.orphans.length === 0 && extras.nonText.length === 0 ? t.trChecksOk : `${t.trOrphans(extras.orphans.length)}; ${t.trNonText(extras.nonText.length)}`}
        </summary>
        {extras.nonText.length > 0 && (
          <div title={t.trNonTextTip}>
            <b>{t.trNonText(extras.nonText.length)}</b>
            <ul>
              {extras.nonText.slice(0, 50).map((x, i) => (
                <li key={i}>
                  <button className="link" onClick={() => { go(x.id); }}>{ctx.name(x.id) ?? x.id}</button> — {x.what}
                </li>
              ))}
            </ul>
          </div>
        )}
        {extras.orphans.length > 0 && (
          <div title={t.trOrphansTip}>
            <b>{t.trOrphans(extras.orphans.length)}</b>
            <ul>
              {extras.orphans.slice(0, 50).map((x) => (
                <li key={`${x.id}\n${x.field}`}>
                  <button className="link" onClick={() => { go(x.id); }}>{ctx.name(x.id) ?? x.id}</button> <span className="mono">{x.field}</span>: {x.text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </details>
      {all.length === 0 ? (
        <Empty text={t.trEmpty} />
      ) : rows.length === 0 ? (
        <Empty text={t.trNoneFound} />
      ) : (
        <div className="table-wrap">
          <table className="table tr-table" data-testid="tr-table">
            <colgroup>
              <col className="tr-col-record" />
              <col className="tr-col-field" />
              <col className="tr-col-original" />
              <col className="tr-col-translation" />
              <col className="tr-col-status" />
            </colgroup>
            <thead>
              <tr>
                <th>{t.colRecord}</th>
                <th>{t.colField}</th>
                <th>{t.trColOriginal}</th>
                <th>{t.trColTranslation}</th>
                <th>{t.trColStatus}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((r) => (
                <tr key={`${r.id}\n${r.field}`} data-sid={r.id} data-field={r.field} data-status={r.status}>
                  <td>
                    <button className="link" onClick={() => { go(r.id); }} title={`${r.id} (${r.type})`}>
                      {r.record}
                    </button>
                  </td>
                  <td className="mono">{r.field}</td>
                  <td className="tr-original">{r.original}</td>
                  <td className="tr-translation">
                    <CommitInput multiline value={r.translation ?? ''} placeholder={t.trPlaceholder} onCommit={(v) => { commit(r, v); }} testId="tr-input" />
                  </td>
                  <td className={`tr-status tr-${r.status}`}>{r.status === 'todo' ? t.trStatus_todo : r.status === 'same' ? t.trStatus_same : t.trStatus_done}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > limit && (
            <button className="link" onClick={() => { setLimit(limit + PAGE); }} data-testid="tr-more">
              {t.trMore(limit, rows.length)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

registerPanel({
  id: 'translate',
  title: (t) => t.panel_translate,
  icon: '🌐',
  component: TranslatePanel,
  area: 'center',
  order: 47,
  hint: (t) => t.trHint,
});
