/**
 * Model with clip playback for a wizard's right side: the same viewer, model builder and rig code as
 * the «Model» panel, without its record-specific tools (parts, icon, interior). The parent may ask for
 * a clip (`play`): it is chosen and played once per stamp.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { RecordModel } from '@kenshi-editor/core';
import type { GameInstallInfo } from '../../../shared/api.ts';
import { errorText, useLang } from '../i18n.ts';
import { ModelViewer } from '../three/viewer.ts';
import { buildModel, disposeModel } from '../three/build.ts';
import { applyPose, clipList, type Rig } from '../three/rig.ts';
import { MODEL_STRINGS } from '../workbench/panels/model.tsx';

interface Props {
  game: GameInstallInfo;
  model: RecordModel | undefined;
  /** Changes when the model must be rebuilt (files re-picked, records edited). */
  buildKey: string;
  play?: { clip: string; stamp: number } | undefined;
  /** Text when there is no model yet. */
  empty: string;
  testId: string;
}

type State = 'empty' | 'loading' | 'ready' | 'error';

export function ModelPreview({ game, model, buildKey, play, empty, testId }: Props): ReactNode {
  const s = MODEL_STRINGS[useLang()];
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<ModelViewer | undefined>(undefined);
  const rigs = useRef<Rig[]>([]);
  const [clips, setClips] = useState<{ name: string; length: number }[]>([]);
  const [clip, setClip] = useState('');
  const clipRef = useRef(clip);
  clipRef.current = clip;
  const [playing, setPlaying] = useState(false);
  const [bones, setBones] = useState(false);
  const [state, setState] = useState<State>('empty');
  const [error, setError] = useState<string | undefined>();
  const time = useRef(0);
  const usedPlay = useRef<number | undefined>(undefined);
  const slider = useRef<HTMLInputElement>(null);
  const clock = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const v = new ModelViewer(host.current);
    viewer.current = v;
    return () => {
      viewer.current = undefined;
      v.dispose();
    };
  }, []);

  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    if (!model || model.pieces.length === 0) {
      const old = v.scene.getObjectByName('__model');
      v.setModel(undefined);
      if (old) disposeModel(old);
      rigs.current = [];
      setClips([]);
      setState('empty');
      return;
    }
    let cancelled = false;
    setState('loading');
    setError(undefined);
    buildModel(game, model, { rig: true })
      .then((built) => {
        if (cancelled) {
          disposeModel(built.group);
          return;
        }
        const old = v.scene.getObjectByName('__model');
        built.group.name = '__model';
        rigs.current = built.rigs;
        const list = clipList(built.rigs);
        setClips(list);
        const keep = list.find((c) => c.name === clipRef.current);
        if (!keep) {
          setClip('');
          setPlaying(false);
          time.current = 0;
        }
        for (const r of built.rigs) applyPose(r, keep?.name, time.current);
        v.setModel(built.group);
        if (old) disposeModel(old);
        setState(built.triangles > 0 ? 'ready' : 'error');
        if (built.triangles === 0) setError(built.missing.join(', '));
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState('error');
          setError(errorText(e));
        }
      });
    return () => {
      cancelled = true;
    };
    // buildKey describes the model.
  }, [buildKey, game]);

  // A clip asked for by the wizard (a click on a clip row).
  useEffect(() => {
    if (!play || play.stamp === usedPlay.current || !clips.some((c) => c.name === play.clip)) return;
    usedPlay.current = play.stamp;
    time.current = 0;
    setClip(play.clip);
    setPlaying(true);
  }, [play, clips]);

  const length = clips.find((c) => c.name === clip)?.length ?? 0;
  const pose = useCallback((): void => {
    for (const r of rigs.current) applyPose(r, clipRef.current || undefined, time.current);
    if (slider.current) slider.current.value = String(time.current);
    if (clock.current) clock.current.textContent = time.current.toFixed(2);
  }, []);
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    pose();
    if (playing && clip && length > 0)
      v.setTicker((dt) => {
        time.current = (time.current + dt) % length;
        pose();
      });
    else v.requestRender();
    return () => {
      v.setTicker(undefined);
    };
  }, [playing, clip, length, state, pose]);
  useEffect(() => {
    viewer.current?.setBonesVisible(bones);
  }, [bones, state]);

  return (
    <div className="model-preview" data-testid={testId} data-state={state} data-clips={clips.length} data-clip={clip} data-playing={playing ? 'true' : 'false'}>
      <div className="model-preview-bar">
        <button className="small" onClick={() => viewer.current?.frame()} title={s.help}>
          {s.frame}
        </button>
        {state === 'ready' && rigs.current.length > 0 && (
          <label className="small">
            <input type="checkbox" checked={bones} onChange={(e) => { setBones(e.target.checked); }} /> {s.bones}
          </label>
        )}
        {clips.length > 0 && (
          <>
            <select
              className="small"
              value={clip}
              data-testid={`${testId}-clip`}
              onChange={(e) => {
                time.current = 0;
                setClip(e.target.value);
                setPlaying(e.target.value !== '');
              }}
            >
              <option value="">{s.bindPose}</option>
              {clips.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="small" disabled={!clip || length <= 0} onClick={() => { setPlaying(!playing); }} data-testid={`${testId}-play`}>
              {playing ? `⏸ ${s.pause}` : `▶ ${s.play}`}
            </button>
            <input
              ref={slider}
              type="range"
              min={0}
              max={length || 1}
              step={0.01}
              disabled={!clip}
              defaultValue={0}
              onInput={(e) => {
                time.current = Number(e.currentTarget.value);
                pose();
                viewer.current?.requestRender();
              }}
              style={{ flex: 1, minWidth: 60, maxWidth: 200 }}
            />
            <span className="muted mono small">
              <span ref={clock}>0.00</span> / {length.toFixed(2)} {s.sec}
            </span>
          </>
        )}
      </div>
      <div ref={host} className="model-preview-canvas" tabIndex={0}>
        {state !== 'ready' && (
          <div className="muted model-preview-note">
            {state === 'empty' && empty}
            {state === 'loading' && s.loading}
            {state === 'error' && `${s.failed}${error ? `: ${error}` : ''}`}
          </div>
        )}
      </div>
    </div>
  );
}
