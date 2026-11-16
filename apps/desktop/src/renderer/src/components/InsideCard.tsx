/**
 * «What is inside» card of a record (on a click on a model part or scene object): what it is, where it comes from,
 * who changes it, what it references and who references it. Each reference leads to the record.
 * Data — `inspectRecord` from the core; if there are no links we say so: «empty».
 */
import type { ReactNode } from 'react';
import { inspectRecord, type InsideGroup, type InsideLink } from '@kenshi-editor/core';
import { useLang } from '../i18n.ts';
import type { Lang } from '../../../shared/api.ts';
import type { Project } from '../project.ts';

const en = {
  title: 'What is inside',
  missing: 'record is not in the data',
  from: 'from',
  changedBy: 'changed by',
  status: { base: '', new: 'new in your mod', changed: 'changed in your mod', deleted: 'deleted in your mod' },
  links: 'Contains / links to',
  usedBy: 'Used by',
  instances: 'placed objects',
  empty: 'empty',
  more: 'more',
  noRecord: 'no record',
};
type InsideStrings = typeof en;
const ru: InsideStrings = {
  title: 'Что внутри',
  missing: 'записи нет в данных',
  from: 'из',
  changedBy: 'меняют',
  status: { base: '', new: 'новая в вашем моде', changed: 'изменена вашим модом', deleted: 'удалена вашим модом' },
  links: 'Внутри / ссылки',
  usedBy: 'Кто ссылается',
  instances: 'размещённые объекты',
  empty: 'пусто',
  more: 'ещё',
  noRecord: 'нет записи',
};
const zh: InsideStrings = {
  title: '内部内容',
  missing: '数据中没有这条记录',
  from: '来自',
  changedBy: '修改者',
  status: { base: '', new: '你的 Mod 中新增', changed: '被你的 Mod 修改', deleted: '被你的 Mod 删除' },
  links: '包含 / 链接到',
  usedBy: '被谁使用',
  instances: '已放置的对象',
  empty: '空',
  more: '更多',
  noRecord: '无记录',
};
const INSIDE_STRINGS: Record<Lang, InsideStrings> = { en, ru, zh };

function LinkItem({ l, go, s }: { l: InsideLink; go: (sid: string) => void; s: InsideStrings }): ReactNode {
  if (l.name === undefined)
    return (
      <li className="muted mono" data-sid={l.sid}>
        {l.sid} — {s.noRecord}
      </li>
    );
  const name = l.localizedName ?? (l.name || l.sid);
  return (
    <li data-sid={l.sid}>
      <a
        href="#"
        data-testid="inside-link"
        onClick={(e) => {
          e.preventDefault();
          go(l.sid);
        }}
      >
        {name}
      </a>{' '}
      <span className="muted">{l.type}</span>
    </li>
  );
}

function Groups({ groups, go, s }: { groups: InsideGroup[]; go: (sid: string) => void; s: InsideStrings }): ReactNode {
  if (groups.length === 0) return <div className="muted">{s.empty}</div>;
  return groups.map((g) => (
    <div key={g.category} data-category={g.category}>
      <div className="muted">
        {g.category === 'instances' ? s.instances : g.category} ({g.links.length})
      </div>
      <ul style={{ margin: '0 0 4px', paddingLeft: 16 }}>
        {g.links.map((l, i) => (
          <LinkItem key={`${l.sid}#${i}`} l={l} go={go} s={s} />
        ))}
      </ul>
    </div>
  ));
}

export function InsideCard({ project, sid, go }: { project: Project; sid: string; go: (sid: string) => void }): ReactNode {
  const lang = useLang();
  const s = INSIDE_STRINGS[lang];
  const card = inspectRecord(project.ctx, sid);
  const name = card.localizedName ?? (card.name || sid);
  const otherLayers = card.layers.slice(1);
  return (
    <div data-testid="inside-card" data-sid={sid}>
      <div style={{ fontWeight: 600 }}>{s.title}</div>
      {!card.exists ? (
        <div className="muted">
          {sid} — {s.missing}
        </div>
      ) : (
        <>
          <div>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                go(sid);
              }}
            >
              <b>{name}</b>
            </a>{' '}
            <span className="badge">{card.type}</span>
          </div>
          {card.localizedName && card.name && <div className="muted">{card.name}</div>}
          <div className="muted mono">{sid}</div>
          <div className="muted">
            {s.from} {card.origin}
            {otherLayers.length > 0 && ` · ${s.changedBy}: ${otherLayers.join(', ')}`}
            {card.status && s.status[card.status] && ` · ${s.status[card.status]}`}
          </div>
          <div style={{ marginTop: 6, fontWeight: 600 }}>{s.links}</div>
          <Groups groups={card.links} go={go} s={s} />
          <div style={{ marginTop: 6, fontWeight: 600 }}>
            {s.usedBy}
            {card.usedByTotal > 0 && ` (${card.usedByTotal})`}
          </div>
          <Groups groups={card.usedBy} go={go} s={s} />
        </>
      )}
    </div>
  );
}
