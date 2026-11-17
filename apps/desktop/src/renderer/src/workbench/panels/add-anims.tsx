/**
 * «Add animations» wizard: a race + a `.skeleton` exported from Blender (Kenshi IO Tools). The wizard reads the
 * file, checks its bones against the race body skeleton, lists its clips with the records the game needs, and on
 * «Add» copies the file into the mod folder and makes the records as one undo step (`applyAddAnimations` in the
 * core). Then «Model» shows the race playing the first new clip.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  animationFilesFor,
  animSamples,
  applyAddAnimations,
  clipRows,
  fitVerdict,
  gamePath,
  modFolderName,
  parseOgreSkeleton,
  raceAnimalCharacters,
  raceMeshes,
  skeletonFit,
  skeletonFitText,
  skeletonPathFor,
  suggestAnimSample,
  uiText,
  decodeText,
  type AnimRecordType,
  type ClipRow,
  type OgreSkeleton,
  type SkeletonFit,
} from '@kenshi-editor/core';
import type { ImportModAssetResult, PickedModAsset } from '../../../../shared/api.ts';
import { errorText, useLang, useT } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { forgetAsset, loadMesh, loadSkeleton } from '../../three/assets.ts';
import type { Project } from '../../project.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { useStore } from '../store.ts';
import { addAnimsRace, modelClipRequest } from '../anim-requests.ts';
import { Empty } from './common.tsx';

/** Where the files go inside the mod folder. */
const SUB = 'animations';

interface PickedFile {
  picked: PickedModAsset;
  skeleton?: OgreSkeleton;
  error?: string;
}

/** Body skeleton of one gender of the race and the clip names the race already has. */
interface Body {
  skeletonName: string;
  skeleton: OgreSkeleton;
  clips: Set<string>;
}

type BodyState = { checking: true } | { checking: false; male?: Body; female?: Body };

function raceLabel(project: Project, sid: string): string {
  const e = project.entry(sid);
  return e ? e.localized || e.name || sid : sid;
}

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
}

/** Skeleton of the race body (male and female) and the clips of the animation files the race lists. */
function useBody(project: Project, race: string, version: number): BodyState {
  const [state, setState] = useState<{ key: string; value: BodyState }>({ key: '', value: { checking: true } });
  const meshes = race ? raceMeshes(project.ctx, race) : {};
  const files = race ? (project.ctx.get(race)?.refs.get('animation files') ?? []).map((r) => r.target) : [];
  const key = `${race}|${meshes.male ?? ''}|${meshes.female ?? ''}|${files.join(',')}|${files.length > 0 ? version : 0}`;
  useEffect(() => {
    if (!race) return;
    const run = { live: true };
    setState({ key, value: { checking: true } });
    const game = project.bundle.game;
    const one = async (gender: 'male' | 'female'): Promise<Body | undefined> => {
      const meshPath = meshes[gender];
      if (!meshPath) return undefined;
      const mesh = await loadMesh(game, meshPath).catch(() => null);
      if (!mesh?.skeleton) return undefined;
      const skeleton = await loadSkeleton(game, skeletonPathFor(meshPath, mesh.skeleton)).catch(() => null);
      if (!skeleton) return undefined;
      const clips = new Set(skeleton.animations.map((a) => a.name));
      for (const f of files) {
        const v = project.ctx.get(f)?.files.get(`${gender} animation`);
        const p = v ? gamePath(decodeText(v)) : undefined;
        const s = p ? await loadSkeleton(game, p).catch(() => null) : null;
        for (const a of s?.animations ?? []) clips.add(a.name);
      }
      return { skeletonName: baseName(mesh.skeleton), skeleton, clips };
    };
    void Promise.all([one('male'), one('female')]).then(([male, female]) => {
      if (run.live) setState({ key, value: { checking: false, ...(male ? { male } : {}), ...(female ? { female } : {}) } });
    });
    return () => {
      run.live = false;
    };
  }, [key]);
  return state.key === key ? state.value : { checking: true };
}

/** Male-body skeleton name of every race (parsed in the main process: names only). */
function useRaceSkeletons(project: Project, races: readonly string[]): ReadonlyMap<string, string> {
  const [map, setMap] = useState<ReadonlyMap<string, string>>(new Map());
  const paths = races.map((r) => raceMeshes(project.ctx, r).male ?? '');
  const key = paths.join('|');
  useEffect(() => {
    const run = { live: true };
    void window.kedit.meshSkeletonNames(project.bundle.game, paths).then((names) => {
      if (!run.live) return;
      const m = new Map<string, string>();
      names.forEach((n, i) => {
        if (n) m.set(races[i]!, baseName(n));
      });
      setMap(m);
    });
    return () => {
      run.live = false;
    };
  }, [key]);
  return map;
}

function readFile(picked: PickedModAsset): PickedFile {
  try {
    return { picked, skeleton: parseOgreSkeleton(picked.bytes) };
  } catch (e) {
    return { picked, error: errorText(e) };
  }
}

function stem(file: string): string {
  return file.replace(/\.[^.]+$/, '');
}

function seconds(n: number): string {
  return `${n.toFixed(2)} s`;
}

/** One file chooser row: button, name, clip count or error. */
function FileRow(props: { label: string; file: PickedFile | undefined; onPick: () => void; testId: string }): ReactNode {
  const t = useT();
  const f = props.file;
  return (
    <div className="aa-file" data-testid={props.testId} data-clips={f?.skeleton?.animations.length ?? ''}>
      <span>{props.label}</span>{' '}
      <button onClick={props.onPick} data-testid={`${props.testId}-pick`}>
        {t.aaChoose}
      </button>{' '}
      {f ? <span className="mono">{f.picked.name}</span> : <span className="muted">{t.aaNoFile}</span>}{' '}
      {f?.skeleton && <span className="muted">— {t.aaFileClips(f.skeleton.animations.length)}</span>}
      {f?.error !== undefined && (
        <div className="bulk-error" data-testid={`${props.testId}-error`}>
          {t.aaUnreadable} <span className="muted">({f.error})</span>
        </div>
      )}
      {f?.skeleton && f.skeleton.animations.length === 0 && <div className="bulk-error">{t.aaFileNoClips}</div>}
    </div>
  );
}

function FitNote({ fit, skeleton, lang, testId }: { fit: SkeletonFit; skeleton: string; lang: string; testId: string }): ReactNode {
  const t = useT();
  const verdict = fitVerdict(fit);
  const lines = skeletonFitText(fit);
  return (
    <div className={verdict === 'ok' ? 'muted' : 'bulk-error'} data-testid={testId} data-verdict={verdict}>
      {verdict !== 'error' && <div>{t.aaFitOk(fit.common, fit.fileBones, skeleton)}</div>}
      {lines.map((l, i) => (
        <div key={i}>{uiText(l, lang)}</div>
      ))}
    </div>
  );
}

interface ClipChoice {
  on: boolean;
  name: string;
  sample: string;
  fix: boolean;
}

function AddAnimsPanel(): ReactNode {
  const t = useT();
  const lang = useLang();
  const { project, go, report, status, open } = useWorkbench();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const game = project.bundle.game;
  const races = useMemo(() => {
    const list = (project.idsByType().get('RACE') ?? []).filter((s) => project.status(s) !== 'deleted');
    return [...list].sort((x, y) => raceLabel(project, x).localeCompare(raceLabel(project, y)));
  }, [project, version]);

  // The race handed over by the record list or «Model» wins (each hand-over once).
  const handed = useStore(addAnimsRace);
  const usedStamp = useRef<number | undefined>(undefined);
  const [chosen, setChosen] = useState(() => {
    if (handed && races.includes(handed.race)) {
      usedStamp.current = handed.stamp;
      return handed.race;
    }
    return '';
  });
  useEffect(() => {
    if (!handed || usedStamp.current === handed.stamp || !races.includes(handed.race)) return;
    usedStamp.current = handed.stamp;
    setChosen(handed.race);
  }, [handed?.stamp]);
  const race = races.includes(chosen) ? chosen : '';

  const [male, setMale] = useState<PickedFile | undefined>();
  const [female, setFemale] = useState<PickedFile | undefined>();
  const [sameFemale, setSameFemale] = useState(true);
  const [fileName, setFileName] = useState('');
  const [others, setOthers] = useState<ReadonlySet<string>>(new Set());
  const [choices, setChoices] = useState<ReadonlyMap<string, Partial<ClipChoice>>>(new Map());
  const [conflict, setConflict] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ race: string; clip?: string } | undefined>();
  useEffect(() => {
    setOthers(new Set());
    setDone(undefined);
  }, [race]);

  const body = useBody(project, race, version);
  const skeletons = useRaceSkeletons(project, races);
  const raceSkeleton = race ? skeletons.get(race) : undefined;
  const sameSkeleton = useMemo(
    () => (raceSkeleton ? races.filter((r) => r !== race && skeletons.get(r) === raceSkeleton) : []),
    [races, race, raceSkeleton, skeletons],
  );
  const animals = useMemo(() => (race ? raceAnimalCharacters(ctx, race) : []), [ctx, race, version]);
  const type: AnimRecordType = animals.length > 0 ? 'ANIMAL_ANIMATION' : 'ANIMATION';

  const femaleFile = sameFemale ? male : female;
  const fileSkel = male?.skeleton;
  const femaleSkel = femaleFile?.skeleton;
  const bodyReady = !body.checking ? body : undefined;
  const maleFit = fileSkel && bodyReady?.male ? skeletonFit(fileSkel, bodyReady.male.skeleton) : undefined;
  // The female body is checked when it has its own skeleton (or its own file).
  const femaleCheck =
    femaleSkel && bodyReady?.female && (!sameFemale || bodyReady.female.skeletonName !== bodyReady.male?.skeletonName)
      ? skeletonFit(femaleSkel, bodyReady.female.skeleton)
      : undefined;
  const blocked = [maleFit, femaleCheck].some((f) => f !== undefined && fitVerdict(f) === 'error');

  /** All clips of both files (male first), as one skeleton for `clipRows`. */
  const rows = useMemo((): ClipRow[] => {
    if (!fileSkel && !femaleSkel) return [];
    const anims = [...(fileSkel?.animations ?? [])];
    for (const a of femaleSkel?.animations ?? []) if (!anims.some((x) => x.name === a.name)) anims.push(a);
    const raceClips = new Set([...(bodyReady?.male?.clips ?? []), ...(bodyReady?.female?.clips ?? [])]);
    return clipRows(ctx, { ...(fileSkel ?? femaleSkel)!, animations: anims }, raceClips, type);
  }, [ctx, fileSkel, femaleSkel, bodyReady, type, version]);
  const samples = useMemo(() => animSamples(ctx, type), [ctx, type, version]);
  const suggested = useMemo(() => new Map(rows.map((r) => [r.clip, suggestAnimSample(ctx, r.clip, type) ?? ''])), [rows, ctx, type]);
  useEffect(() => {
    setChoices(new Map());
    setConflict(undefined);
    setProblem(undefined);
    setFileName(male ? stem(male.picked.name) : female ? stem(female.picked.name) : '');
  }, [male, female, type]);

  const choice = (r: ClipRow): ClipChoice => {
    const c = choices.get(r.clip) ?? {};
    return {
      on: c.on ?? r.records.length === 0,
      name: c.name ?? r.clip,
      sample: c.sample ?? suggested.get(r.clip) ?? '',
      // Records of the mod itself are ticked; vanilla or other mods' records only on request.
      fix: c.fix ?? r.nearMisses.every((m) => project.status(m.sid) === 'new'),
    };
  };
  const setChoice = (clip: string, patch: Partial<ClipChoice>): void => {
    setChoices((prev) => new Map(prev).set(clip, { ...prev.get(clip), ...patch }));
  };

  const pick = async (which: 'male' | 'female'): Promise<void> => {
    const got = await window.kedit.chooseModAsset('skeleton');
    if (got === null) return;
    if ('error' in got) {
      report(got.error);
      return;
    }
    (which === 'male' ? setMale : setFemale)(readFile(got));
  };

  const modPath = project.path ?? project.bundle.suggestedPath;
  const folder = modFolderName(modPath.replace(/\\/g, '/').split('/').slice(-2, -1)[0] ?? '');
  const files = [male, sameFemale ? undefined : female].filter((f): f is PickedFile => f?.skeleton !== undefined);
  const newClips = rows.filter((r) => choice(r).on);
  const racesToLink = race ? [race, ...sameSkeleton.filter((r) => others.has(r))] : [];
  const canApply = race !== '' && files.length > 0 && !blocked && !busy && fileSkel !== undefined && project.provenance?.inWorkshop !== true;

  const apply = async (onConflict: 'ask' | 'replace' | 'rename'): Promise<void> => {
    if (!canApply) return;
    setBusy(true);
    setConflict(undefined);
    setProblem(undefined);
    try {
      const copied: { male?: string; female?: string } = {};
      for (const [which, f] of [['male', male], ['female', sameFemale ? undefined : female]] as const) {
        if (!f?.skeleton) continue;
        const r: ImportModAssetResult = await window.kedit.importModAsset({ game, modPath, sub: SUB, source: f.picked.path, onConflict });
        if (!r.ok) {
          if (r.error === 'conflict') setConflict(r.existing ?? f.picked.name);
          else if (r.error === 'not-in-mods') setProblem(t.aaNotInMods);
          else setProblem(t.aaCopyError(r.message ?? r.error));
          return;
        }
        forgetAsset(game, gamePath(r.recordPath) ?? r.recordPath);
        copied[which] = r.recordPath;
      }
      if (sameFemale && copied.male) copied.female = copied.male;
      const reuse = copied.male ? animationFilesFor(ctx, copied.male)[0] : undefined;
      let result: ReturnType<typeof applyAddAnimations> | undefined;
      const err = tryEdit(() => {
        result = applyAddAnimations(ctx, {
          type,
          races: racesToLink,
          ...(copied.male ? { male: copied.male } : {}),
          ...(copied.female ? { female: copied.female } : {}),
          fileName: fileName.trim() || stem(male!.picked.name),
          ...(reuse ? { reuseFile: reuse } : {}),
          clips: newClips.map((r) => {
            const c = choice(r);
            return { clip: r.clip, name: c.name, ...(c.sample ? { sample: c.sample } : {}) };
          }),
          fixes: rows.flatMap((r) => (choice(r).fix ? r.nearMisses.map((m) => ({ sid: m.sid, clip: r.clip })) : [])),
          ...(type === 'ANIMAL_ANIMATION' ? { animalCharacters: animals } : {}),
        });
      });
      report(err);
      if (!result) return;
      status({ text: (s) => s.aaDone(newClips.length, result!.racesLinked.length), kind: 'info' });
      const first = newClips[0]?.clip ?? rows[0]?.clip;
      setDone({ race, ...(first ? { clip: first } : {}) });
      showInModel(race, first);
    } finally {
      setBusy(false);
    }
  };

  const showInModel = (sid: string, clip: string | undefined): void => {
    if (clip) modelClipRequest.set({ sid, clip, stamp: Date.now() });
    go(sid);
    open('model');
  };

  if (races.length === 0) return <Empty text={t.aaNoRaces} />;
  const fitFor = (fit: SkeletonFit | undefined, name: string | undefined, testId: string): ReactNode =>
    fit && name ? <FitNote fit={fit} skeleton={name} lang={lang} testId={testId} /> : null;

  return (
    <div className="mods-panel" data-testid="add-anims-panel" data-type={type}>
      <div className="mods-panel-bar">
        <label>
          {t.aaRace}{' '}
          <select value={race} onChange={(e) => { setChosen(e.target.value); }} data-testid="aa-race">
            <option value="">{t.aaPick}</option>
            {races.map((s) => (
              <option key={s} value={s}>
                {raceLabel(project, s)}
                {project.status(s) === 'new' ? ' ★' : ''}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={!canApply} onClick={() => void apply('ask')} title={t.aaApplyTip} data-testid="aa-apply">
          {t.aaApply(newClips.length, racesToLink.length)}
        </button>
        {done && (
          <button onClick={() => { showInModel(done.race, done.clip); }} title={t.aaShowTip} data-testid="aa-show">
            {t.aaShow}
          </button>
        )}
      </div>
      <div className="muted mods-panel-note">{t.aaIntro}</div>
      {race && (
        <div className="aa-body">
          <FileRow label={t.aaMale} file={male} onPick={() => void pick('male')} testId="aa-male" />
          <label className="small">
            <input type="checkbox" checked={sameFemale} onChange={(e) => { setSameFemale(e.target.checked); }} data-testid="aa-same-female" /> {t.aaSameForFemale}
          </label>
          {!sameFemale && <FileRow label={t.aaFemale} file={female} onPick={() => void pick('female')} testId="aa-female" />}
          {(fileSkel || femaleSkel) && body.checking && <div className="muted">{t.aaChecking}</div>}
          {fileSkel && bodyReady && !bodyReady.male && <div className="bulk-error">{t.aaNoBody}</div>}
          {fitFor(maleFit, bodyReady?.male?.skeletonName, 'aa-fit')}
          {fitFor(femaleCheck, bodyReady?.female?.skeletonName, 'aa-fit-female')}
          {type === 'ANIMAL_ANIMATION' && <div className="muted" data-testid="aa-animal">{t.aaAnimal(animals.length)}</div>}
          {sameSkeleton.length > 0 && files.length > 0 && (
            <details className="rc-group" data-testid="aa-others">
              <summary>
                {t.aaOthers(sameSkeleton.length, raceSkeleton ?? '')}{' '}
                <button className="small" onClick={(e) => { e.preventDefault(); setOthers(new Set(sameSkeleton)); }} data-testid="aa-others-all">
                  {t.aaAllOthers}
                </button>{' '}
                <button className="small" onClick={(e) => { e.preventDefault(); setOthers(new Set()); }}>
                  {t.aaNoOthers}
                </button>
              </summary>
              <div className="aa-others">
                {sameSkeleton.map((r) => (
                  <label key={r} className="small">
                    <input
                      type="checkbox"
                      checked={others.has(r)}
                      onChange={(e) => {
                        const next = new Set(others);
                        if (e.target.checked) next.add(r);
                        else next.delete(r);
                        setOthers(next);
                      }}
                    />{' '}
                    {raceLabel(project, r)}
                  </label>
                ))}
              </div>
            </details>
          )}
          {files.length > 0 && (
            <div className="aa-names">
              <label>
                {t.aaFileName}{' '}
                <input value={fileName} onChange={(e) => { setFileName(e.target.value); }} data-testid="aa-file-name" />
              </label>{' '}
              <span className="muted" data-testid="aa-copy-to">
                {t.aaCopyTo(files.map((f) => `mods/${folder}/${SUB}/${f.picked.name}`).join(', '))}
              </span>
            </div>
          )}
          {conflict !== undefined && (
            <div className="rc-why" data-testid="aa-conflict">
              <div>{t.aaConflict(conflict)}</div>
              <div>
                <button onClick={() => void apply('replace')} data-testid="aa-replace">
                  {t.aaReplace}
                </button>{' '}
                <button onClick={() => void apply('rename')} data-testid="aa-rename">
                  {t.aaRename}
                </button>{' '}
                <button onClick={() => { setConflict(undefined); }}>{t.aaCancel}</button>
              </div>
            </div>
          )}
          {problem !== undefined && (
            <div className="bulk-error" data-testid="aa-problem">
              {problem}
            </div>
          )}
          {rows.length > 0 && (
            <div className="table-wrap">
              <table className="table bulk-table" data-testid="aa-clips">
                <thead>
                  <tr>
                    <th className="bulk-check" />
                    <th>{t.aaClip}</th>
                    <th>{t.aaLength}</th>
                    <th>{t.aaRecord}</th>
                    <th>{t.aaRecordName}</th>
                    <th>{t.aaSettings}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const c = choice(r);
                    return (
                      <tr key={r.clip} className={c.on ? undefined : 'bulk-off'} data-testid="aa-clip" data-clip={r.clip}>
                        <td className="bulk-check">
                          <input type="checkbox" checked={c.on} onChange={() => { setChoice(r.clip, { on: !c.on }); }} aria-label={r.clip} data-testid="aa-clip-on" />
                        </td>
                        <td className="aa-clip-cell">
                          <span className="mono">{r.clip}</span>
                          {r.replaces && <div className="muted">{t.aaReplaces}</div>}
                          {r.tracks === 0 && <div className="bulk-error">{t.aaNoTracks}</div>}
                        </td>
                        <td className="muted">{seconds(r.length)}</td>
                        <td>
                          {r.records.length > 0 ? (
                            <button className="link" onClick={() => { go(r.records[0]!); }} data-testid="aa-clip-has">
                              {t.aaHas(r.records.length)}
                            </button>
                          ) : (
                            <span className="muted">{t.aaNew}</span>
                          )}
                          {r.nearMisses.map((m) => (
                            <div key={m.sid} className="bulk-error" data-testid="aa-near-miss">
                              {t.aaNearMiss(project.entry(m.sid)?.name ?? m.sid, m.animName)}{' '}
                              <label className="small">
                                <input type="checkbox" checked={c.fix} onChange={() => { setChoice(r.clip, { fix: !c.fix }); }} data-testid="aa-fix" /> {t.aaFix}
                              </label>
                            </div>
                          ))}
                        </td>
                        <td>
                          <input value={c.name} disabled={!c.on} onChange={(e) => { setChoice(r.clip, { name: e.target.value }); }} data-testid="aa-clip-name" />
                        </td>
                        <td>
                          <select value={c.sample} disabled={!c.on} onChange={(e) => { setChoice(r.clip, { sample: e.target.value }); }} data-testid="aa-clip-sample">
                            <option value="">{t.aaEmpty}</option>
                            {samples.map((s) => (
                              <option key={s} value={s}>
                                {ctx.name(s) ?? s}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

registerPanel({
  id: 'add-anims',
  group: 'data',
  title: (t) => t.panel_addAnims,
  icon: '♫',
  component: AddAnimsPanel,
  area: 'center',
  order: 54,
  hint: (t) => t.addAnimsHint,
});
