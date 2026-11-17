/**
 * «New race based on…» window: pick a sample race (translated names), give the new race a name
 * (required, not the name of the sample or of another race) and choose whether the «Race
 * compatibility» wizard opens right away. Creating the copy is done by the caller.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { newRaceNameProblem, uiText } from '@kenshi-editor/core';
import { useLang, useT } from '../i18n.ts';
import type { Project } from '../project.ts';
import { Modal } from './widgets.tsx';

const SAMPLE_NAMES = ['greenlander', 'зеленоземец'];

/** «Зеленоземец (Greenlander)» when the race has a translated name, otherwise just the name. */
export function raceOptionLabel(project: Project, sid: string): string {
  const e = project.entry(sid);
  if (!e) return sid;
  const name = e.name || sid;
  return e.localized && e.localized !== name ? `${e.localized} (${name})` : name;
}

interface Props {
  project: Project;
  /** Preselected sample race (e.g. the race selected in the record list). */
  defaultSample: string | undefined;
  onCreate: (sample: string, name: string, compat: boolean) => void;
  onClose: () => void;
}

export function NewRaceModal({ project, defaultSample, onCreate, onClose }: Props): ReactNode {
  const t = useT();
  const lang = useLang();
  const races = useMemo(() => {
    const list = (project.idsByType().get('RACE') ?? []).filter((s) => project.status(s) !== 'deleted');
    return list.sort((x, y) => raceOptionLabel(project, x).localeCompare(raceOptionLabel(project, y)));
  }, [project]);
  const [sample, setSample] = useState(() => {
    if (defaultSample !== undefined && races.includes(defaultSample)) return defaultSample;
    return races.find((s) => SAMPLE_NAMES.includes((project.entry(s)?.name ?? '').toLowerCase())) ?? races[0] ?? '';
  });
  const [name, setName] = useState('');
  const [compat, setCompat] = useState(true);
  // Translated names count too: «Зеленоземец» must not become a second «Greenlander».
  const problem = useMemo((): string | undefined => {
    if (!sample) return t.nrNoSample;
    const core = newRaceNameProblem(project.ctx, sample, name);
    if (core) return uiText(core, lang);
    const want = name.trim().toLowerCase();
    const clash = races.find((s) => (project.entry(s)?.localized ?? '').trim().toLowerCase() === want);
    if (clash !== undefined) return clash === sample ? t.nrSameAsSample : t.nrTaken(raceOptionLabel(project, clash));
    return undefined;
  }, [project, sample, name, races, lang, t]);
  const create = (): void => {
    if (problem === undefined) onCreate(sample, name.trim(), compat);
  };
  return (
    <Modal
      title={t.nrTitle}
      onClose={onClose}
      testId="new-race-modal"
      footer={
        <>
          <span className="grow" />
          <button onClick={onClose}>{t.cancel}</button>
          <button className="primary" disabled={problem !== undefined} onClick={create} title={problem} data-testid="new-race-create">
            {t.create}
          </button>
        </>
      }
    >
      <div className="form">
        <label>{t.nrSample}</label>
        <select
          value={sample}
          data-testid="new-race-sample"
          onChange={(e) => {
            setSample(e.target.value);
          }}
        >
          {races.map((s) => (
            <option key={s} value={s}>
              {raceOptionLabel(project, s)}
              {project.status(s) === 'new' ? ' ★' : ''}
            </option>
          ))}
        </select>
        <label>{t.nrName}</label>
        <input
          autoFocus
          value={name}
          placeholder={t.nrNamePlaceholder}
          data-testid="new-race-name"
          onChange={(e) => {
            setName(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
        />
        <span />
        <span className={name.trim() === '' ? 'muted' : 'bulk-error'} data-testid="new-race-problem">
          {problem ?? ' '}
        </span>
        <span />
        <label title={t.nrCompatTip}>
          <input
            type="checkbox"
            checked={compat}
            data-testid="new-race-compat"
            onChange={(e) => {
              setCompat(e.target.checked);
            }}
          />{' '}
          {t.nrCompat}
        </label>
      </div>
      <div className="muted" style={{ marginTop: 8 }}>
        {t.nrIntro}
      </div>
    </Modal>
  );
}
