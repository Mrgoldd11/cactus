/**
 * «Own creature» workshop: a new animal from the modder's own model. Steps on the left (sample and
 * name → model and skeleton → animations and ragdoll → where to get it → check), the model on the
 * right: the sample until a `.mesh` is chosen, then the chosen files (not yet copied), then the new
 * animal. The check and the records are the core's (`checkCreature`, `createCreature`); this panel
 * only reads files, shows the plan, copies the files into the mod folder and applies it.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  animalRagdolls,
  animalStarts,
  animalTraders,
  bestRagdoll,
  checkCreature,
  createCreature,
  creatureClipNeeds,
  creatureProblems,
  creatureSamples,
  creatureScale,
  creatureVerdict,
  gamePath,
  modelOfRecord,
  newCreatureNameProblem,
  parseOgreMesh,
  parseOgreSkeleton,
  phsBoneNames,
  raceMeshes,
  skeletonPathFor,
  uiText,
  type CreatureResult,
  type OgreMesh,
  type OgreSkeleton,
  type RecordModel,
} from '@kenshi-editor/core';
import type { ImportModAssetResult, PickedModAsset } from '../../../../shared/api.ts';
import { errorText, useLang, useT } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { forgetAsset, loadMesh, loadSkeleton, primeAssets } from '../../three/assets.ts';
import type { Project } from '../../project.ts';
import { ModelPreview } from '../../components/ModelPreview.tsx';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Picked files: the model and what goes with it. */
interface Files {
  /** Virtual folder of the preview cache (new on every pick). */
  dir: string;
  mesh: PickedModAsset;
  parsed?: OgreMesh;
  meshError?: string;
  skeleton?: PickedModAsset;
  skeletonParsed?: OgreSkeleton;
  skeletonError?: string;
  /** The skeleton came with the model (found next to it). */
  skeletonFound: boolean;
  texture?: PickedModAsset;
  normalMap?: PickedModAsset;
}

function label(project: Project, sid: string): string {
  const e = project.entry(sid);
  return e ? e.localized || e.name || sid : sid;
}

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

/** Folder inside the mod folder: `creatures/<model name>` (plain characters only). */
function subFor(meshName: string): string {
  const stem = meshName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9 _.-]+/g, '_').replace(/^[ .]+|[ .]+$/g, '');
  return `creatures/${stem || 'creature'}`;
}

let pickCount = 0;

function readMesh(mesh: PickedModAsset): Files {
  const files: Files = { dir: `__picked/${++pickCount}`, mesh, skeletonFound: false };
  try {
    files.parsed = parseOgreMesh(mesh.bytes);
  } catch (e) {
    files.meshError = errorText(e);
  }
  const l = mesh.linked;
  if (l?.skeleton) {
    files.skeletonFound = true;
    setSkeleton(files, l.skeleton);
  }
  if (l?.texture) files.texture = l.texture;
  if (l?.normalMap) files.normalMap = l.normalMap;
  return files;
}

function setSkeleton(files: Files, s: PickedModAsset): void {
  files.skeleton = s;
  delete files.skeletonParsed;
  delete files.skeletonError;
  try {
    files.skeletonParsed = parseOgreSkeleton(s.bytes);
  } catch (e) {
    files.skeletonError = errorText(e);
  }
}

/** Put the picked files into the preview cache, the skeleton under the name the model links. */
function prime(project: Project, f: Files): void {
  const list: { name: string; bytes: Uint8Array }[] = [{ name: f.mesh.name, bytes: f.mesh.bytes }];
  if (f.skeleton) list.push({ name: baseName(f.parsed?.skeleton ?? f.skeleton.name), bytes: f.skeleton.bytes });
  if (f.texture) list.push({ name: f.texture.name, bytes: f.texture.bytes });
  primeAssets(project.bundle.game, f.dir, list);
}

/** Ragdoll bone names of every animal ragdoll of the game (read once). */
function useRagdolls(project: Project): ReadonlyMap<string, string[]> | undefined {
  const [map, setMap] = useState<ReadonlyMap<string, string[]> | undefined>();
  useEffect(() => {
    const run = { live: true };
    const game = project.bundle.game;
    void Promise.all(
      animalRagdolls(project.ctx).map(async (r) => {
        const p = gamePath(r.path);
        const bytes = p ? await window.kedit.readGameAsset(game, p).catch(() => null) : null;
        return [r.path, bytes ? phsBoneNames(bytes) : undefined] as const;
      }),
    ).then((list) => {
      if (!run.live) return;
      const m = new Map<string, string[]>();
      for (const [path, names] of list) if (names && names.length > 0) m.set(path, names);
      setMap(m);
    });
    return () => {
      run.live = false;
    };
  }, [project]);
  return map;
}

/** The sample's body: its mesh (for the size) and skeleton clip names. */
function useSampleBody(project: Project, sample: string): { mesh?: OgreMesh; clips?: string[]; ragdoll?: string } {
  const [state, setState] = useState<{ key: string; mesh?: OgreMesh; clips?: string[]; ragdoll?: string }>({ key: '' });
  const race = project.ctx.get(sample)?.refs.get('race')?.[0]?.target ?? '';
  const meshPath = race ? raceMeshes(project.ctx, race).male : undefined;
  const ragdollValue = race ? project.ctx.get(race)?.files.get('male ragdoll') : undefined;
  const ragdoll = ragdollValue ? new TextDecoder().decode(ragdollValue) : undefined;
  const key = `${sample}|${meshPath ?? ''}`;
  useEffect(() => {
    if (!meshPath) return;
    const run = { live: true };
    const game = project.bundle.game;
    void (async () => {
      const mesh = await loadMesh(game, meshPath).catch(() => null);
      const skel = mesh?.skeleton ? await loadSkeleton(game, skeletonPathFor(meshPath, mesh.skeleton)).catch(() => null) : null;
      if (run.live)
        setState({ key, ...(mesh ? { mesh } : {}), ...(skel ? { clips: skel.animations.map((a) => a.name) } : {}), ...(ragdoll ? { ragdoll } : {}) });
    })();
    return () => {
      run.live = false;
    };
  }, [key]);
  return state.key === key ? state : ragdoll ? { ragdoll } : {};
}

function Step({ n, title, mark, children, testId }: { n: number; title: string; mark: 'ok' | 'todo' | 'bad'; children: ReactNode; testId: string }): ReactNode {
  return (
    <section className="cw-step" data-testid={testId} data-mark={mark}>
      <h3>
        <span className={`cw-mark cw-mark-${mark}`}>{mark === 'ok' ? '✓' : mark === 'bad' ? '⚠' : '○'}</span> {n}. {title}
      </h3>
      <div className="cw-step-body">{children}</div>
    </section>
  );
}

function CreaturePanel(): ReactNode {
  const t = useT();
  const lang = useLang();
  const { project, go, open, report, status } = useWorkbench();
  // A link of the result: select the record and show it in the inspector (it shares the dock).
  const show = (sid: string): void => {
    go(sid);
    open('inspector');
  };
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const game = project.bundle.game;

  const samples = useMemo(
    () => creatureSamples(ctx).sort((a, b) => label(project, a).localeCompare(label(project, b))),
    [project, version],
  );
  const [chosenSample, setSample] = useState('');
  const sample = samples.includes(chosenSample) ? chosenSample : (samples.find((s) => (ctx.name(s) ?? '').toLowerCase() === 'goat') ?? samples[0] ?? '');
  const [name, setName] = useState('');
  const [files, setFiles] = useState<Files | undefined>();
  const [scaleText, setScaleText] = useState<string | undefined>();
  const [ragdollChoice, setRagdoll] = useState<string | undefined>();
  const traders = useMemo(() => animalTraders(ctx), [ctx, version]);
  const [tradersOn, setTradersOn] = useState<ReadonlySet<string> | undefined>();
  const tradersTicked = tradersOn ?? new Set(traders.slice(0, 1).map((x) => x.sid));
  const [count, setCount] = useState({ min: 1, max: 2 });
  const starts = useMemo(() => animalStarts(ctx).sort((a, b) => label(project, a).localeCompare(label(project, b))), [ctx, version]);
  const [startOn, setStartOn] = useState(true);
  const [startFrom, setStartFrom] = useState('');
  const start = starts.includes(startFrom) ? startFrom : (starts[0] ?? '');
  const [startName, setStartName] = useState('');
  const [play, setPlay] = useState<{ clip: string; stamp: number } | undefined>();
  const [conflict, setConflict] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<(CreatureResult & { name: string; sold: number }) | undefined>();

  const body = useSampleBody(project, sample);
  const ragdolls = useRagdolls(project);
  const needs = useMemo(() => (sample ? creatureClipNeeds(ctx, sample) : []), [ctx, sample, version]);
  const skel = files?.skeletonParsed;
  const linkName = files?.parsed?.skeleton ? baseName(files.parsed.skeleton) : undefined;
  const best = useMemo(() => (skel && ragdolls ? bestRagdoll(skel, ragdolls, body.ragdoll) : undefined), [skel, ragdolls, body.ragdoll]);
  const ragdollOptions = useMemo(
    () =>
      skel && ragdolls
        ? [...ragdolls].map(([path, bones]) => ({ path, missing: bones.filter((b) => !skel.bones.some((x) => x.name === b)).length })).sort((a, b) => a.missing - b.missing || a.path.localeCompare(b.path))
        : [],
    [skel, ragdolls],
  );
  const suggested = best?.path;
  const ragdoll = ragdollChoice !== undefined && ragdollOptions.some((o) => o.path === ragdollChoice) ? ragdollChoice : suggested;
  const check = useMemo(
    () => (skel ? checkCreature(needs, skel, { ...(body.clips ? { sampleClips: body.clips } : {}), ...(ragdoll && ragdolls?.get(ragdoll) ? { ragdollBones: ragdolls.get(ragdoll)! } : {}) }) : undefined),
    [needs, skel, body.clips, ragdoll, ragdolls],
  );
  const coreProblems = check ? creatureProblems(check) : [];
  const suggestedScale = files?.parsed && body.mesh ? creatureScale(files.parsed, body.mesh) : undefined;
  const scale = Number((scaleText ?? (suggestedScale !== undefined ? String(suggestedScale) : '1')).replace(',', '.'));

  const nameProblem = newCreatureNameProblem(ctx, name);
  const fileProblems: string[] = [];
  if (!files) fileProblems.push(t.cwNoMesh);
  else if (files.meshError !== undefined) fileProblems.push(t.cwUnreadable(files.meshError));
  else if (!linkName) fileProblems.push(t.cwNoSkeletonLink);
  else if (!files.skeleton) fileProblems.push(t.cwSkeletonMissing(linkName));
  else if (files.skeletonError !== undefined) fileProblems.push(t.cwUnreadable(files.skeletonError));
  else if (baseName(files.skeleton.name).toLowerCase() !== linkName.toLowerCase()) fileProblems.push(t.cwSkeletonWrongName(linkName, files.skeleton.name));
  const scaleBad = !(scale > 0.05 && scale < 20);
  const readOnly = project.provenance?.inWorkshop === true;
  const verdict = creatureVerdict(coreProblems);
  const blocked = readOnly || nameProblem !== undefined || fileProblems.length > 0 || verdict === 'error' || scaleBad || !sample || busy;

  // Preview: the new animal once made, the picked files, else the sample.
  const model = useMemo((): RecordModel | undefined => {
    if (done && ctx.get(done.animal)) return modelOfRecord(ctx, done.animal);
    if (files?.parsed) {
      return {
        sid: '__picked',
        type: 'RACE',
        notes: [],
        pieces: [{ mesh: `${files.dir}/${files.mesh.name}`, ...(files.texture ? { texture: `${files.dir}/${files.texture.name}` } : {}), source: '__picked', field: 'male mesh' }],
      };
    }
    return sample ? modelOfRecord(ctx, sample) : undefined;
  }, [done, files, sample, ctx, version]);
  const buildKey = done ? `done|${done.animal}|${version}` : files ? `${files.dir}|${files.skeleton?.path ?? ''}|${files.texture?.path ?? ''}` : `sample|${sample}`;

  const pickMesh = async (): Promise<void> => {
    const got = await window.kedit.chooseModAsset('mesh');
    if (got === null) return;
    if ('error' in got) {
      report(got.error);
      return;
    }
    const f = readMesh(got);
    prime(project, f);
    setFiles(f);
    setScaleText(undefined);
    setRagdoll(undefined);
    setDone(undefined);
    setConflict(undefined);
    setProblem(undefined);
  };
  const pickExtra = async (kind: 'skeleton' | 'texture' | 'normal'): Promise<void> => {
    if (!files) return;
    const got = await window.kedit.chooseModAsset(kind === 'skeleton' ? 'skeleton' : 'texture');
    if (got === null) return;
    if ('error' in got) {
      report(got.error);
      return;
    }
    const f: Files = { ...files, dir: `__picked/${++pickCount}` };
    if (kind === 'skeleton') {
      f.skeletonFound = false;
      setSkeleton(f, got);
    } else if (kind === 'texture') f.texture = got;
    else f.normalMap = got;
    prime(project, f);
    setFiles(f);
  };

  const modPath = project.path ?? project.bundle.suggestedPath;
  const sub = files ? subFor(files.mesh.name) : '';
  const folder = baseName(modPath.replace(/[\\/][^\\/]*$/, ''));

  const create = async (replace: boolean): Promise<void> => {
    if (blocked || !files?.skeleton) return;
    setBusy(true);
    setConflict(undefined);
    setProblem(undefined);
    try {
      const copied: { mesh?: string; texture?: string; normalMap?: string } = {};
      const list: [keyof typeof copied | 'skeleton', PickedModAsset | undefined][] = [
        ['mesh', files.mesh],
        ['skeleton', files.skeleton],
        ['texture', files.texture],
        ['normalMap', files.normalMap],
      ];
      for (const [which, f] of list) {
        if (!f) continue;
        const r: ImportModAssetResult = await window.kedit.importModAsset({ game, modPath, sub, source: f.path, onConflict: replace ? 'replace' : 'ask' });
        if (!r.ok) {
          if (r.error === 'conflict') setConflict(r.existing ?? f.name);
          else if (r.error === 'not-in-mods') setProblem(t.cwNotInMods);
          else setProblem(t.cwCopyError(r.message ?? r.error));
          return;
        }
        forgetAsset(game, gamePath(r.recordPath) ?? r.recordPath);
        if (which !== 'skeleton') copied[which] = r.recordPath;
      }
      const traderList = traders.filter((x) => tradersTicked.has(x.sid)).map((x) => ({ sid: x.sid, min: count.min, max: Math.max(count.min, count.max) }));
      let res: CreatureResult | undefined;
      const err = tryEdit(() => {
        res = createCreature(ctx, {
          sample,
          name: name.trim(),
          mesh: copied.mesh!,
          ...(copied.texture ? { texture: copied.texture } : {}),
          ...(copied.normalMap ? { normalMap: copied.normalMap } : {}),
          ...(ragdoll ? { ragdoll } : {}),
          ...(Math.abs(scale - 1) > 0.005 ? { scale } : {}),
          traders: traderList,
          ...(startOn && start ? { startFrom: start, ...(startName.trim() ? { startName: startName.trim() } : {}) } : {}),
        });
      });
      report(err);
      if (!res) return;
      const made = res;
      setDone({ ...made, name: name.trim(), sold: traderList.length });
      status({ text: (s) => s.cwDoneStatus(name.trim()), kind: 'info' });
    } finally {
      setBusy(false);
    }
  };

  const again = (): void => {
    setDone(undefined);
    setFiles(undefined);
    setName('');
    setScaleText(undefined);
    setRagdoll(undefined);
    setStartName('');
  };

  if (samples.length === 0) return <Empty text={t.cwPreviewEmpty} />;
  const sampleName = sample ? label(project, sample) : '';
  const step1: 'ok' | 'todo' | 'bad' = nameProblem === undefined && sample ? 'ok' : name.trim() === '' ? 'todo' : 'bad';
  const step2: 'ok' | 'todo' | 'bad' = !files ? 'todo' : fileProblems.length > 0 ? 'bad' : 'ok';
  const step3: 'ok' | 'todo' | 'bad' = !check ? 'todo' : verdict === 'error' ? 'bad' : 'ok';
  const step4: 'ok' | 'todo' | 'bad' = tradersTicked.size > 0 || (startOn && start) ? 'ok' : 'todo';

  return (
    <div className="cw-host" data-testid="creature-panel">
    <div className="cw">
      <div className="cw-steps">
        <div className="muted cw-intro">
          {t.cwIntro}{' '}
          <details className="cw-how">
            <summary>{t.cwHow}</summary>
            {t.cwHowText}
          </details>
        </div>

        <Step n={1} title={t.cwStep1} mark={step1} testId="cw-step-1">
          <div className="form">
            <label>{t.cwSample}</label>
            <select value={sample} onChange={(e) => { setSample(e.target.value); setRagdoll(undefined); }} data-testid="cw-sample" disabled={done !== undefined}>
              {samples.map((s) => (
                <option key={s} value={s}>
                  {label(project, s)}
                  {project.status(s) === 'new' ? ' ★' : ''}
                </option>
              ))}
            </select>
            <label>{t.cwName}</label>
            <input value={name} placeholder={t.cwNamePlaceholder} onChange={(e) => { setName(e.target.value); }} data-testid="cw-name" disabled={done !== undefined} />
            {name.trim() !== '' && nameProblem && (
              <>
                <span />
                <span className="bulk-error" data-testid="cw-name-problem">
                  {uiText(nameProblem, lang)}
                </span>
              </>
            )}
          </div>
        </Step>

        <Step n={2} title={t.cwStep2} mark={step2} testId="cw-step-2">
          <div className="cw-row">
            <button onClick={() => void pickMesh()} data-testid="cw-pick-mesh" disabled={done !== undefined}>
              {t.cwPickMesh}
            </button>{' '}
            {files ? (
              <span>
                <span className="mono" data-testid="cw-mesh-name">{files.mesh.name}</span>
                {files.parsed && (
                  <span className="muted">
                    {' '}— {t.cwMeshInfo(files.parsed.submeshes.reduce((n, s) => n + Math.floor(s.indices.length / 3), 0), (files.parsed.bounds.max[1] - files.parsed.bounds.min[1]).toFixed(1))}
                  </span>
                )}
              </span>
            ) : (
              <span className="muted">{t.cwNoMesh}</span>
            )}
          </div>
          {files?.parsed && linkName && (
            <div className="cw-row" data-testid="cw-skeleton" data-clips={skel?.animations.length ?? ''}>
              <span>{t.cwSkeleton}:</span>{' '}
              {files.skeleton ? (
                <>
                  <span className="mono">{files.skeleton.name}</span>
                  {skel && <span className="muted"> — {t.cwSkeletonInfo(skel.bones.length, skel.animations.length)}{files.skeletonFound ? `, ${t.cwSkeletonFound}` : ''}</span>}
                </>
              ) : (
                <span className="mono">{linkName}</span>
              )}{' '}
              {!files.skeletonFound && !done && (
                <button className="small" onClick={() => void pickExtra('skeleton')} data-testid="cw-pick-skeleton">
                  {t.cwPickSkeleton}
                </button>
              )}
            </div>
          )}
          {files?.parsed && (
            <>
              <div className="cw-row" data-testid="cw-texture">
                <span>{t.cwTexture}:</span> {files.texture ? <span className="mono">{files.texture.name}</span> : <span className="warn">{t.cwNoTexture}</span>}{' '}
                {!done && (
                  <button className="small" onClick={() => void pickExtra('texture')}>
                    {t.cwPickTexture}
                  </button>
                )}
              </div>
              <div className="cw-row">
                <span>{t.cwNormal}:</span> {files.normalMap ? <span className="mono">{files.normalMap.name}</span> : <span className="muted">{t.cwNone}</span>}{' '}
                {!done && (
                  <button className="small" onClick={() => void pickExtra('normal')}>
                    {t.cwPickNormal}
                  </button>
                )}
              </div>
              <label className="cw-row" title={t.cwScaleTip}>
                {t.cwScale}:{' '}
                <input
                  className={scaleBad ? 'cw-num bad' : 'cw-num'}
                  value={scaleText ?? (suggestedScale !== undefined ? String(suggestedScale) : '1')}
                  onChange={(e) => { setScaleText(e.target.value); }}
                  data-testid="cw-scale"
                  disabled={done !== undefined}
                />
                <span className="muted"> × {sampleName}</span>
              </label>
            </>
          )}
          {fileProblems.length > 0 && files && (
            <div className="bulk-error" data-testid="cw-file-problem">
              {fileProblems[0]}
            </div>
          )}
        </Step>

        <Step n={3} title={t.cwStep3} mark={step3} testId="cw-step-3">
          {!check ? (
            <div className="muted">{t.cwNeedsModel}</div>
          ) : (
            <>
              <table className="table cw-clips" data-testid="cw-clips">
                <thead>
                  <tr>
                    <th>{t.cwClip}</th>
                    <th>{t.cwFor}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {check.clips.map((c) => (
                    <tr
                      key={c.clip}
                      data-testid="cw-clip"
                      data-clip={c.clip}
                      data-present={c.present ? 'true' : 'false'}
                      className={c.present ? 'cw-clip-ok' : 'cw-clip-bad'}
                      title={c.present ? t.cwPlayTip : undefined}
                      onClick={() => { if (c.present) setPlay({ clip: c.clip, stamp: Date.now() }); }}
                    >
                      <td className="mono cw-nowrap">{c.present ? `▶ ${c.clip}` : c.clip}</td>
                      <td className="muted">
                        {t[`cwKind_${c.kind}`]}
                        {c.sources.length > 0 && ` · ${c.sources.slice(0, 2).map((s) => label(project, s)).join(', ')}${c.sources.length > 2 ? '…' : ''}`}
                      </td>
                      <td className={c.present ? 'cw-ok cw-nowrap' : 'bulk-error cw-nowrap'}>{c.present ? `✓ ${t.cwHas}` : `✗ ${t.cwLacks}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <label className="cw-row" title={t.cwRagdollTip}>
                {t.cwRagdoll}:{' '}
                <select value={ragdoll ?? ''} onChange={(e) => { setRagdoll(e.target.value); }} data-testid="cw-ragdoll" disabled={done !== undefined}>
                  {ragdollOptions.map((o) => (
                    <option key={o.path} value={o.path}>
                      {baseName(o.path)} — {t.cwRagdollMissing(o.missing)}
                      {o.path === suggested ? ` (${t.cwRagdollBest})` : ''}
                      {body.ragdoll && o.path.toLowerCase() === body.ragdoll.toLowerCase() ? ` (${t.cwRagdollSample})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <ul className="cw-problems" data-testid="cw-problems">
                {coreProblems.map((p, i) => (
                  <li key={i} className={p.level === 'error' ? 'bulk-error' : 'warn'}>
                    {uiText(p.text, lang)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Step>

        <Step n={4} title={t.cwStep4} mark={step4} testId="cw-step-4">
          <div className="muted">{t.cwTradersNote}</div>
          <div className="cw-traders" data-testid="cw-traders">
            {traders.map((x) => (
              <label key={x.sid} className="small" title={x.towns.map((s) => label(project, s)).join(', ')}>
                <input
                  type="checkbox"
                  checked={tradersTicked.has(x.sid)}
                  disabled={done !== undefined}
                  data-testid="cw-trader"
                  data-sid={x.sid}
                  onChange={(e) => {
                    const next = new Set(tradersTicked);
                    if (e.target.checked) next.add(x.sid);
                    else next.delete(x.sid);
                    setTradersOn(next);
                  }}
                />{' '}
                {label(project, x.sid)} <span className="muted">— {x.towns.length > 0 ? t.cwTowns(x.towns.length) : t.cwNoTowns}</span>
              </label>
            ))}
          </div>
          <label className="cw-row">
            {t.cwCount}:{' '}
            <input className="cw-num" type="number" min={0} max={20} value={count.min} onChange={(e) => { setCount({ ...count, min: Math.max(0, Number(e.target.value) || 0) }); }} disabled={done !== undefined} />
            {' – '}
            <input className="cw-num" type="number" min={0} max={20} value={count.max} onChange={(e) => { setCount({ ...count, max: Math.max(0, Number(e.target.value) || 0) }); }} disabled={done !== undefined} />
          </label>
          {starts.length > 0 && (
            <>
              <label className="cw-row">
                <input type="checkbox" checked={startOn} onChange={(e) => { setStartOn(e.target.checked); }} data-testid="cw-start-on" disabled={done !== undefined} /> {t.cwStart}
              </label>
              {startOn && (
                <div className="form cw-start">
                  <label>{t.cwStartFrom}</label>
                  <select value={start} onChange={(e) => { setStartFrom(e.target.value); }} data-testid="cw-start-from" disabled={done !== undefined}>
                    {starts.map((s) => (
                      <option key={s} value={s}>
                        {label(project, s)}
                      </option>
                    ))}
                  </select>
                  <label>{t.cwStartName}</label>
                  <input
                    value={startName}
                    placeholder={`${ctx.name(start) ?? start} — ${name.trim() || '…'}`}
                    onChange={(e) => { setStartName(e.target.value); }}
                    data-testid="cw-start-name"
                    disabled={done !== undefined}
                  />
                </div>
              )}
            </>
          )}
        </Step>

        <Step n={5} title={t.cwStep5} mark={done ? 'ok' : blocked && !busy ? (files ? 'bad' : 'todo') : 'todo'} testId="cw-step-5">
          {readOnly && <div className="bulk-error">{t.cwWorkshopMod}</div>}
          {!done && (
            <>
              <div className={blocked ? 'muted' : 'cw-ok'} data-testid="cw-verdict" data-verdict={blocked ? 'blocked' : verdict}>
                {blocked ? t.cwBlocked : verdict === 'ok' ? t.cwReady : t.cwReadyWarn}
              </div>
              {files && <div className="muted small" data-testid="cw-copy-to">{t.cwCopyTo(`mods/${folder}/${sub}/`)}</div>}
              <div className="cw-row">
                <button className="primary" disabled={blocked} onClick={() => void create(false)} title={t.cwCreateTip} data-testid="cw-create">
                  {t.cwCreate}
                </button>
              </div>
            </>
          )}
          {conflict !== undefined && (
            <div className="rc-why" data-testid="cw-conflict">
              <div>{t.cwConflict(conflict)}</div>
              <button onClick={() => void create(true)} data-testid="cw-replace">
                {t.cwReplace}
              </button>{' '}
              <button onClick={() => { setConflict(undefined); }}>{t.cwCancel}</button>
            </div>
          )}
          {problem !== undefined && (
            <div className="bulk-error" data-testid="cw-problem">
              {problem}
            </div>
          )}
          {done && (
            <div className="cw-done" data-testid="cw-done" data-animal={done.animal} data-race={done.race} data-start={done.start ?? ''}>
              <div className="cw-ok">✓ {t.cwDone}:</div>
              <ul>
                <li>
                  {t.cwDoneAnimal}: <button className="link" onClick={() => { show(done.animal); }}>{label(project, done.animal)}</button>
                </li>
                <li>
                  {t.cwDoneRace}: <button className="link" onClick={() => { show(done.race); }}>{label(project, done.race)}</button>
                </li>
                {done.start !== undefined && (
                  <li>
                    {t.cwDoneStart}: <button className="link" onClick={() => { show(done.start!); }}>{label(project, done.start)}</button>
                  </li>
                )}
                {done.sold > 0 && <li>{t.cwDoneSold(done.sold)}</li>}
              </ul>
              <button onClick={again} data-testid="cw-again">
                {t.cwAgain}
              </button>
            </div>
          )}
        </Step>
      </div>
      <div className="cw-subject">
        <ModelPreview game={game} model={model} buildKey={buildKey} play={play} empty={t.cwPreviewEmpty} testId="cw-preview" />
        {!files && !done && sample && <div className="muted small cw-subject-note">{t.cwPreviewSample}</div>}
      </div>
    </div>
    </div>
  );
}

registerPanel({
  id: 'creature',
  group: 'data',
  title: (t) => t.panel_creature,
  icon: '🐾',
  component: CreaturePanel,
  area: 'center',
  order: 55,
  hint: (t) => t.creatureHint,
});
