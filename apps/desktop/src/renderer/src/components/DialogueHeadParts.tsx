/**
 * Blocks of the «Dialogue line» panel for a DIALOGUE (UI review G8): «One more like it…» / «Hang on another
 * event too…», the name, «When it may play» check boxes. The usual properties live here, so the inspector
 * tab is not needed for them.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { addDialogToPackage, decodeText, dialogueWhen, packageRefEvents, type GameRecord, type ModContext } from '@kenshi-editor/core';
import type { Strings } from '../i18n.ts';
import { recordName } from '../data-names.ts';
import type { EventDialoguePreset } from './EventDialogueModal.tsx';
import { CommitInput } from './widgets.tsx';
import { eventEnum, EventSelect } from './EventUi.tsx';
import { Section, useDescribe } from './LinePanelParts.tsx';

interface HeadPart {
  ctx: ModContext;
  sid: string;
  rec: GameRecord;
  t: Strings;
  edit: (fn: () => void) => void;
}

/** DialogRepetitionEnum value DR_ONCE_ONLY: «Only once» is this repetition limit (fcs.def has no `once only`). */
const DR_ONCE_ONLY = 5;

/** «One more like it…» and «Hang on another event too…» with its small form. */
export function DialogueActs({ ctx, sid, t, edit, version, onLike }: HeadPart & { version: number; onLike?: (preset: EventDialoguePreset) => void }): ReactNode {
  const sources = useMemo(() => dialogueWhen(ctx, sid), [ctx, sid, version]);
  const pkgs = sources.flatMap((s) => (s.pkg !== undefined ? [s.pkg] : []));
  const first = sources.find((s) => s.pkg !== undefined && s.events.length > 0);
  const [hang, setHang] = useState(false);
  const [pkg, setPkg] = useState<string | undefined>(undefined);
  const [event, setEvent] = useState(0);
  const def = eventEnum(ctx);
  const target = pkg !== undefined && pkgs.includes(pkg) ? pkg : pkgs[0];
  const ref = target !== undefined ? ctx.get(target)?.refs.get('dialogs')?.find((r) => r.target === sid) : undefined;
  const problem = ref && packageRefEvents(ref).includes(event) ? t.dhHangHas : ref && packageRefEvents(ref).length >= 3 ? t.dhHangFull : undefined;
  return (
    <>
      <div className="ln-actions" data-testid="dh-acts">
        {onLike && (
          <button
            className="small"
            data-testid="dh-like"
            title={t.dhLikeTip}
            onClick={() => {
              onLike({ like: sid, ...(first ? { event: first.events[0]!, who: first.pkg! } : {}) });
            }}
          >
            {t.dhLike}
          </button>
        )}
        {pkgs.length > 0 && def && (
          <button className={`small${hang ? ' active' : ''}`} data-testid="dh-hang" title={t.dhHangTip} onClick={() => { setHang(!hang); }}>
            {t.dhHang}
          </button>
        )}
      </div>
      {hang && def && target !== undefined && (
        <div className="dh-hang" data-testid="dh-hang-form">
          <label className="small">{t.dhHangEvent}</label>
          <EventSelect def={def} value={event} onChange={setEvent} testId="dh-hang-event" />
          <label className="small">{t.dhHangPkg}</label>
          <select value={target} data-testid="dh-hang-pkg" onChange={(e) => { setPkg(e.target.value); }}>
            {pkgs.map((p) => (
              <option key={p} value={p}>
                {recordName(ctx, p)}
              </option>
            ))}
          </select>
          {problem !== undefined && <div className="small warn">{problem}</div>}
          <div className="row">
            <button
              className="small"
              data-testid="dh-hang-do"
              disabled={event === 0 || problem !== undefined}
              onClick={() => {
                edit(() => { addDialogToPackage(ctx, target, sid, event); });
                setHang(false);
                setEvent(0);
              }}
            >
              {t.dhHangDo}
            </button>
            <button className="small" onClick={() => { setHang(false); }}>
              {t.cancel}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** Name of the dialogue (`name` of the record). */
export function DialogueName({ ctx, sid, rec, t, edit }: HeadPart): ReactNode {
  return (
    <Section title={t.dhName}>
      <CommitInput value={decodeText(rec.name)} testId="dh-name" onCommit={(v) => { edit(() => { ctx.renameRecord(sid, v); }); }} />
    </Section>
  );
}

type FlagKey = 'for enemies' | 'once only' | 'locked' | 'one at a time' | 'monologue';
const FLAGS: readonly FlagKey[] = ['for enemies', 'once only', 'locked', 'one at a time', 'monologue'];

const textOf = (t: Strings, key: string): string => {
  const v = (t as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : key;
};

/** «When it may play»: the DIALOGUE switches, each with its FCS name. */
export function WhenAllowed(p: HeadPart): ReactNode {
  return (
    <Section title={p.t.dhAllowed}>
      <div className="dh-flags" data-testid="dh-flags">
        {FLAGS.map((k) => (
          <Flag key={k} k={k} {...p} />
        ))}
      </div>
    </Section>
  );
}

function Flag({ k, ctx, sid, rec, t, edit }: HeadPart & { k: FlagKey }): ReactNode {
  const slug = k.replace(/ /g, '_');
  const oldOnce = k === 'once only' && rec.bools.get('once only') === true;
  const on = k === 'once only' ? (rec.ints.get('repetition limit') ?? 0) === DR_ONCE_ONLY : k === 'monologue' ? rec.bools.get(k) !== false : rec.bools.get(k) === true;
  const label = textOf(t, `dhFlag_${slug}`);
  const desc = textOf(t, `dhDesc_${slug}`) + (oldOnce ? ` ${t.dhDesc_once_only_old}` : '');
  const code = k === 'once only' ? 'repetition limit: DR_ONCE_ONLY' : k;
  const describe = useDescribe({ kind: t.lpDescField, title: label, code, text: desc });
  const set = (v: boolean): void => {
    edit(() => {
      if (k === 'once only') ctx.setField(sid, 'ints', 'repetition limit', v ? DR_ONCE_ONLY : 0);
      else ctx.setField(sid, 'bools', k, v);
    });
  };
  return (
    <label className="dh-flag" data-testid={`dh-flag-${slug}`} title={desc} {...describe}>
      <input type="checkbox" checked={on} onChange={(e) => { set(e.target.checked); }} />
      <span>{label}</span> <span className="mono muted small">{code}</span>
      {oldOnce && <span className="warn small"> ⚠ once only=true</span>}
    </label>
  );
}
