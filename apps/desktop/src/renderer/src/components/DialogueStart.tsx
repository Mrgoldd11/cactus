/**
 * Start of the empty «Dialogues» graph: a big «New dialogue…» button that opens the event
 * dialogue wizard, and a search to open an existing dialogue or a character (whose main dialogue
 * the graph then shows), plus the dialogues of the mod itself.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { typeWords, uiText } from '@kenshi-editor/core';
import { useLang, useT } from '../i18n.ts';
import type { IndexEntry, Project } from '../project.ts';

/** Record types the graph opens, in the order the search lists them. */
const OPENS = ['CHARACTER', 'DIALOGUE', 'DIALOGUE_PACKAGE'] as const;
const LIMIT = 12;

interface Props {
  project: Project;
  onNew: () => void;
  onOpen: (sid: string) => void;
}

export function DialogueStart({ project, onNew, onOpen }: Props): ReactNode {
  const t = useT();
  const lang = useLang();
  const ctx = project.ctx;
  const [query, setQuery] = useState('');

  const found = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const out: IndexEntry[] = [];
    for (const type of OPENS) {
      for (const sid of project.idsByType().get(type) ?? []) {
        if (ctx.status(sid) === 'deleted') continue;
        const e = project.entry(sid);
        if (e && terms.every((x) => e.hay.includes(x))) out.push(e);
      }
    }
    return out;
  }, [project, ctx, query]);

  const mine = useMemo(
    () =>
      ctx
        .modRecords()
        .filter((r) => ctx.typeName(r.type) === 'DIALOGUE' && ctx.status(r.stringId) !== 'deleted')
        .map((r) => project.entry(r.stringId))
        .filter((e): e is IndexEntry => e !== undefined),
    [project, ctx],
  );

  const row = (e: IndexEntry): ReactNode => (
    <li key={e.sid}>
      <button className="ds-row" data-testid="ds-row" data-sid={e.sid} onClick={() => { onOpen(e.sid); }}>
        <span className="ds-name">{e.localized || e.name}</span>
        {e.localized && e.localized !== e.name && <span className="muted small"> {e.name}</span>}
        <span className="ds-kind muted small">{uiText(typeWords(e.type), lang)}</span>
      </button>
    </li>
  );

  return (
    <div className="panel-scroll ds-start" data-testid="dialogue-start">
      <h2 className="ds-title">{t.dsTitle}</h2>
      <p className="muted">{t.dsLead}</p>
      <button className="primary ds-new" data-testid="ds-new" title={t.dsNewTip} onClick={onNew}>
        + {t.dsNew}
      </button>
      <div className="ds-open">{t.dsOpen}</div>
      <input
        className="search ds-search"
        data-testid="ds-search"
        placeholder={t.dsSearch}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && found[0]) onOpen(found[0].sid);
        }}
      />
      {query.trim() !== '' && (
        <>
          {found.length === 0 && <div className="muted small">{t.dsNothing}</div>}
          <ul className="ds-list" data-testid="ds-found">
            {found.slice(0, LIMIT).map(row)}
          </ul>
          {found.length > LIMIT && <div className="muted small">{t.dsMore(found.length - LIMIT)}</div>}
          {found.some((e) => e.type === 'CHARACTER') && <div className="muted small">{t.dsCharHint}</div>}
        </>
      )}
      <div className="ds-open">{t.dsMine}</div>
      {mine.length === 0 ? (
        <div className="muted small">{t.dsMineNone}</div>
      ) : (
        <ul className="ds-list" data-testid="ds-mine">
          {mine.map(row)}
        </ul>
      )}
    </div>
  );
}
