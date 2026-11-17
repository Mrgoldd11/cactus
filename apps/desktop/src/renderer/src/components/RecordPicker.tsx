/**
 * Record choice for a reference: search by name (English/Russian) and id, by default only records
 * of the type the schema requires. Records deleted by the mod are not offered.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useT } from '../i18n.ts';
import type { IndexEntry, Project } from '../project.ts';
import { VirtualList } from './VirtualList.tsx';
import { Modal } from './widgets.tsx';

interface Props {
  project: Project;
  title: string;
  targetType: string | undefined;
  exclude: ReadonlySet<string>;
  onPick: (sid: string) => void;
  onClose: () => void;
  /** Offer only these records (e.g. those of a category) instead of all records of the type. */
  ids?: readonly string[];
}

export function RecordPicker({ project, title, targetType, exclude, onPick, onClose, ids }: Props): ReactNode {
  const t = useT();
  const [query, setQuery] = useState('');
  const [anyType, setAnyType] = useState(targetType === undefined);
  const [cursor, setCursor] = useState(0);
  const ctx = project.ctx;

  const items = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const source = ids ?? (!anyType && targetType !== undefined ? (project.idsByType().get(targetType) ?? []) : project.allIds());
    const out: IndexEntry[] = [];
    for (const sid of source) {
      if (exclude.has(sid) || ctx.status(sid) === 'deleted') continue;
      const e = project.entry(sid);
      if (e && terms.every((term) => e.hay.includes(term))) out.push(e);
    }
    return out.sort((a, b) => (a.hay < b.hay ? -1 : a.hay > b.hay ? 1 : 0));
  }, [project, ctx, query, anyType, targetType, exclude, ids]);

  const cur = Math.min(cursor, items.length - 1);
  const pick = (e: IndexEntry | undefined): void => {
    if (e) onPick(e.sid);
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      testId="record-picker"
      footer={
        <>
          <span className="muted">
            {t.records}: {items.length}
          </span>
          <span className="grow" />
          <button onClick={onClose}>{t.cancel}</button>
          <button className="primary" disabled={cur < 0} onClick={() => {
            pick(items[cur]);
          }}>
            {t.ok}
          </button>
        </>
      }
    >
      <div className="row">
        <input
          autoFocus
          className="search"
          data-testid="picker-search"
          placeholder={t.search}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setCursor(Math.min(items.length - 1, cur + 1));
            else if (e.key === 'ArrowUp') setCursor(Math.max(0, cur - 1));
            else if (e.key === 'Enter') pick(items[cur]);
            else return;
            e.preventDefault();
          }}
        />
        {targetType !== undefined && ids === undefined && (
          <label className="muted nowrap">
            <input
              type="checkbox"
              checked={anyType}
              onChange={(e) => {
                setAnyType(e.target.checked);
                setCursor(0);
              }}
            />{' '}
            {t.anyType} ({t.pickType}: {targetType})
          </label>
        )}
      </div>
      <VirtualList
        items={items}
        rowHeight={24}
        scrollToIndex={cur}
        className="picker-list"
        testId="picker-list"
        renderRow={(e, i) => (
          <div
            className={`list-row picker-grid st-${ctx.status(e.sid) ?? 'base'} ${i === cur ? 'selected' : ''}`}
            data-sid={e.sid}
            onClick={() => {
              setCursor(i);
            }}
            onDoubleClick={() => {
              pick(e);
            }}
          >
            <span className="name">{e.name}</span>
            <span className="tr-name">{e.localized}</span>
            <span className="sid mono">{e.sid}</span>
            <span className="type">{e.type}</span>
          </div>
        )}
      />
    </Modal>
  );
}
