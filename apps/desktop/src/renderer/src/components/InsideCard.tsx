/**
 * Карточка «Что внутри» записи (по клику на часть модели или объект сцены): что это, откуда,
 * кто её меняет, на что она ссылается и кто ссылается на неё. Каждая ссылка — переход к записи.
 * Данные — `inspectRecord` из ядра; если связей нет, так и пишем: «пусто».
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
const INSIDE_STRINGS: Record<Lang, InsideStrings> = { en, ru };

function LinkItem({ l, lang, go, s }: { l: InsideLink; lang: Lang; go: (sid: string) => void; s: InsideStrings }): ReactNode {
  if (l.name === undefined)
    return (
      <li className="muted mono" data-sid={l.sid}>
        {l.sid} — {s.noRecord}
      </li>
    );
  const name = (lang === 'ru' ? l.nameRu : undefined) ?? (l.name || l.sid);
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

function Groups({ groups, lang, go, s }: { groups: InsideGroup[]; lang: Lang; go: (sid: string) => void; s: InsideStrings }): ReactNode {
  if (groups.length === 0) return <div className="muted">{s.empty}</div>;
  return groups.map((g) => (
    <div key={g.category} data-category={g.category}>
      <div className="muted">
        {g.category === 'instances' ? s.instances : g.category} ({g.links.length})
      </div>
      <ul style={{ margin: '0 0 4px', paddingLeft: 16 }}>
        {g.links.map((l, i) => (
          <LinkItem key={`${l.sid}#${i}`} l={l} lang={lang} go={go} s={s} />
        ))}
      </ul>
    </div>
  ));
}

export function InsideCard({ project, sid, go }: { project: Project; sid: string; go: (sid: string) => void }): ReactNode {
  const lang = useLang();
  const s = INSIDE_STRINGS[lang];
  const card = inspectRecord(project.ctx, sid);
  const name = (lang === 'ru' ? card.nameRu : undefined) ?? (card.name || sid);
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
          {lang === 'ru' && card.nameRu && card.name && <div className="muted">{card.name}</div>}
          <div className="muted mono">{sid}</div>
          <div className="muted">
            {s.from} {card.origin}
            {otherLayers.length > 0 && ` · ${s.changedBy}: ${otherLayers.join(', ')}`}
            {card.status && s.status[card.status] && ` · ${s.status[card.status]}`}
          </div>
          <div style={{ marginTop: 6, fontWeight: 600 }}>{s.links}</div>
          <Groups groups={card.links} lang={lang} go={go} s={s} />
          <div style={{ marginTop: 6, fontWeight: 600 }}>
            {s.usedBy}
            {card.usedByTotal > 0 && ` (${card.usedByTotal})`}
          </div>
          <Groups groups={card.usedBy} lang={lang} go={go} s={s} />
        </>
      )}
    </div>
  );
}
