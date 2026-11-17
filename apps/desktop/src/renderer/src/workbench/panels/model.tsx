/**
 * «Model» panel: 3D model of the selected record (weapon, armour, building, building part, item)
 * from the game files. Mouse as in Blender/Unity: left button rotates, middle/right pans,
 * wheel zooms; F — show all, digits 1/3/7 (main row or numpad) — front/right/top
 * view. The model image can be saved as an icon (PNG with a transparent background).
 *
 * Animated models (characters, animals, races) are skinned to their `.skeleton`: its clips (and those of
 * a race's animation files) can be played, and the bones drawn over the model.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { modelOfRecord, uiText, type RecordModel } from '@kenshi-editor/core';
import { errorText, langOf, useLang } from '../../i18n.ts';
import type { Lang } from '../../../../shared/api.ts';
import { shortcut } from '../../keys.ts';
import { registerPanel, type PanelProps } from '../registry.ts';
import { useFollowed, useWorkbench } from '../context.ts';
import { InsideCard } from '../../components/InsideCard.tsx';
import { ModelViewer, type ViewSide } from '../../three/viewer.ts';
import { buildModel, disposeModel, type RigNote } from '../../three/build.ts';
import { applyPose, clipList, type Rig } from '../../three/rig.ts';

const en = {
  panel: 'Model',
  hint: '3D model of the selected record from the game files',
  none: 'Select a weapon, armour, building or item.',
  noModel: 'This record has no 3D model.',
  loading: 'Loading model…',
  failed: 'Could not read the model',
  missing: 'Not found in the game folder',
  triangles: 'triangles',
  parts: 'parts',
  frame: 'Fit (F)',
  front: 'Front (1)',
  right: 'Right (3)',
  top: 'Top (7)',
  wire: 'Wireframe (W)',
  interior: 'Interior',
  icon: 'Save icon…',
  iconSaved: 'Icon saved',
  help: 'Left mouse — rotate, middle/right — pan, wheel — zoom',
  clip: 'Animation',
  bindPose: 'Bind pose',
  play: 'Play',
  pause: 'Pause',
  bones: 'Bones',
  female: 'Female body',
  sec: 's',
  unreadable: (path: string): string => `Not a readable skeleton: ${path}`,
  misfit: (path: string, n: number): string => `The model is weighted to ${n} bones that ${path} lacks: those vertices stay still`,
  partial: (path: string, clips: number, bones: string): string =>
    `${clips} clips of ${path} move bones the model's skeleton lacks (${bones}): those bones stay still`,
};
type ModelStrings = typeof en;
const ru: ModelStrings = {
  panel: 'Модель',
  hint: '3D-модель выбранной записи из файлов игры',
  none: 'Выберите оружие, броню, здание или предмет.',
  noModel: 'У этой записи нет 3D-модели.',
  loading: 'Загружаю модель…',
  failed: 'Не удалось прочитать модель',
  missing: 'Нет в папке игры',
  triangles: 'треуг.',
  parts: 'частей',
  frame: 'Целиком (F)',
  front: 'Спереди (1)',
  right: 'Справа (3)',
  top: 'Сверху (7)',
  wire: 'Сетка (W)',
  interior: 'Внутри',
  icon: 'Сохранить иконку…',
  iconSaved: 'Иконка сохранена',
  help: 'Левая кнопка — вращать, средняя/правая — сдвигать, колесо — ближе/дальше',
  clip: 'Анимация',
  bindPose: 'Исходная поза',
  play: 'Играть',
  pause: 'Пауза',
  bones: 'Кости',
  female: 'Женское тело',
  sec: 'с',
  unreadable: (path: string): string => `Не читается как скелет: ${path}`,
  misfit: (path: string, n: number): string => `Модель привязана к костям, которых нет в ${path} (${n}): эти вершины стоят на месте`,
  partial: (path: string, clips: number, bones: string): string =>
    `Клипы из ${path} (${clips}) двигают кости, которых нет в скелете модели (${bones}): эти кости стоят на месте`,
};
const zh: ModelStrings = {
  panel: '模型',
  hint: '来自游戏文件的所选记录的 3D 模型',
  none: '请选择武器、护甲、建筑或物品。',
  noModel: '这条记录没有 3D 模型。',
  loading: '正在加载模型…',
  failed: '无法读取该模型',
  missing: '游戏文件夹中没有',
  triangles: '个三角面',
  parts: '个部件',
  frame: '适应视图 (F)',
  front: '前视 (1)',
  right: '右视 (3)',
  top: '俯视 (7)',
  wire: '线框 (W)',
  interior: '室内',
  icon: '保存图标…',
  iconSaved: '图标已保存',
  help: '鼠标左键——旋转，中键/右键——平移，滚轮——缩放',
  clip: '动画',
  bindPose: '绑定姿势',
  play: '播放',
  pause: '暂停',
  bones: '骨骼',
  female: '女性身体',
  sec: '秒',
  unreadable: (path: string): string => `无法读取的骨骼文件：${path}`,
  misfit: (path: string, n: number): string => `模型绑定了 ${path} 中没有的 ${n} 根骨骼：这些顶点保持不动`,
  partial: (path: string, clips: number, bones: string): string =>
    `${path} 中有 ${clips} 个动画会移动模型骨骼中没有的骨骼（${bones}）：这些骨骼保持不动`,
};
const MODEL_STRINGS: Record<Lang, ModelStrings> = { en, ru, zh };

/** Record types that can have a model in the game. */
const MODEL_TYPES = [
  'WEAPON',
  'CROSSBOW',
  'GUN_DATA',
  'ARMOUR',
  'ITEM',
  'ATTACHMENT',
  'LIMB_REPLACEMENT',
  'BUILDING',
  'BUILDING_PART',
  'FARM_PART',
  'CONTAINER',
  'NEST_ITEM',
  'MAP_ITEM',
  'MAP_FEATURES',
  'FOLIAGE_MESH',
  'RACE',
  'WILDLIFE_BIRDS',
] as const;

type ViewState = 'empty' | 'none' | 'loading' | 'ready' | 'error';

function ModelPanel({ def, params }: PanelProps): ReactNode {
  const lang = useLang();
  const s = MODEL_STRINGS[lang];
  const { project, go } = useWorkbench();
  const { sid, version } = useFollowed(def, params);
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<ModelViewer | undefined>(undefined);
  const [interior, setInterior] = useState(false);
  const [female, setFemale] = useState(false);
  const [showBones, setShowBones] = useState(false);
  /** Skeletons of the shown model, the clips they offer, the chosen clip ('' — bind pose) and playback. */
  const rigs = useRef<Rig[]>([]);
  const [clips, setClips] = useState<{ name: string; length: number }[]>([]);
  const [clip, setClip] = useState('');
  const clipRef = useRef(clip);
  clipRef.current = clip;
  const [playing, setPlaying] = useState(false);
  const time = useRef(0);
  const slider = useRef<HTMLInputElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const [wire, setWire] = useState(false);
  const [state, setState] = useState<ViewState>('empty');
  const [info, setInfo] = useState<{ model: RecordModel; triangles: number; missing: string[]; rigNotes: RigNote[] } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();
  /** Model part selected by click (the part record or the record itself) and the part under the mouse. */
  const [picked, setPicked] = useState<string | undefined>();
  const [hover, setHover] = useState<string | undefined>();
  const down = useRef<{ x: number; y: number } | undefined>(undefined);

  useEffect(() => {
    if (!host.current) return;
    const v = new ModelViewer(host.current);
    viewer.current = v;
    return () => {
      viewer.current = undefined;
      v.dispose();
    };
  }, []);

  const male = sid === undefined ? undefined : modelOfRecord(project.ctx, sid, { interior });
  // A race with both bodies: the female one is offered by a checkbox.
  const fem = sid !== undefined && male?.pieces[0]?.field === 'male mesh' ? modelOfRecord(project.ctx, sid, { female: true }) : undefined;
  const hasFemale = fem?.pieces[0]?.field === 'female mesh';
  const model = female && hasFemale ? fem : male;
  const modelKey = model ? JSON.stringify(model.pieces) : '';
  const hasInterior = sid !== undefined && (project.ctx.get(sid)?.refs.get('interior')?.length ?? 0) > 0;

  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    setSaved(undefined);
    setPicked(undefined);
    setHover(undefined);
    if (!model || model.pieces.length === 0) {
      const old = v.scene.getObjectByName('__model');
      v.setModel(undefined);
      if (old) disposeModel(old);
      rigs.current = [];
      setClips([]);
      setInfo(model ? { model, triangles: 0, missing: [], rigNotes: [] } : undefined);
      setState(sid === undefined ? 'empty' : 'none');
      return;
    }
    let cancelled = false;
    setState('loading');
    setError(undefined);
    buildModel(project.bundle.game, model, { rig: true })
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
        // Keep the chosen clip when the next model has it too (flipping between races or bodies).
        const keep = list.find((c) => c.name === clipRef.current);
        if (!keep) {
          setClip('');
          setPlaying(false);
        }
        time.current = keep ? Math.min(time.current, keep.length) : 0;
        for (const r of built.rigs) applyPose(r, keep?.name, time.current);
        v.setModel(built.group);
        if (old) disposeModel(old);
        setInfo({ model, triangles: built.triangles, missing: built.missing, rigNotes: built.rigNotes });
        setState(built.triangles > 0 ? 'ready' : 'error');
        if (built.triangles === 0) setError(built.missing.join(', '));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState('error');
        setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
    // modelKey describes the whole model; version — record edits.
  }, [modelKey, sid, version, project]);

  useEffect(() => {
    viewer.current?.highlight(picked, hover);
  }, [picked, hover, info]);

  const length = clips.find((c) => c.name === clip)?.length ?? 0;
  /** Pose every rig at the current time and show the time (outside React: this runs every frame). */
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
  }, [playing, clip, length, info, pose]);

  useEffect(() => {
    viewer.current?.setBonesVisible(showBones);
  }, [showBones, info]);

  const view = (side?: ViewSide): void => viewer.current?.frame(side);
  const toggleWire = (): void => {
    const on = !wire;
    setWire(on);
    viewer.current?.setWireframe(on);
  };
  const saveIcon = async (): Promise<void> => {
    const v = viewer.current;
    if (!v || sid === undefined) return;
    v.highlight(undefined, undefined);
    const png = v.renderIcon(256);
    v.highlight(picked, hover);
    const name = `${(project.ctx.name(sid) ?? sid).replace(/[\\/:*?"<>|]+/g, '_')}.png`;
    const r = await window.kedit.savePngFile(name, png);
    if (r.ok) setSaved(r.path);
    else if (!r.cancelled) setError(r.error);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const k = shortcut(e);
    const side: Record<string, ViewSide> = { Numpad1: 'front', Digit1: 'front', Numpad3: 'right', Digit3: 'right', Numpad7: 'top', Digit7: 'top' };
    if (k === 'f') view();
    else if (k === 'w') toggleWire();
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && side[e.code]) view(side[e.code]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const bar: CSSProperties = { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', padding: '4px 6px' };
  return (
    <div
      data-testid="model-view"
      data-state={state}
      data-sid={sid ?? ''}
      data-triangles={info?.triangles ?? 0}
      data-clips={clips.length}
      data-clip={clip}
      data-playing={playing ? 'true' : 'false'}
      data-bones={rigs.current.reduce((n, r) => n + r.skeleton.bones.length, 0)}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={bar}>
        <button className="small" data-testid="model-frame" onClick={() => { view(); }} title={s.help}>
          {s.frame}
        </button>
        <button className="small" onClick={() => { view('front'); }}>
          {s.front}
        </button>
        <button className="small" onClick={() => { view('right'); }}>
          {s.right}
        </button>
        <button className="small" onClick={() => { view('top'); }}>
          {s.top}
        </button>
        <label className="small">
          <input type="checkbox" checked={wire} onChange={toggleWire} /> {s.wire}
        </label>
        {hasInterior && (
          <label className="small">
            <input type="checkbox" data-testid="model-interior" checked={interior} onChange={(e) => { setInterior(e.target.checked); }} /> {s.interior}
          </label>
        )}
        {hasFemale && (
          <label className="small">
            <input type="checkbox" data-testid="model-female" checked={female} onChange={(e) => { setFemale(e.target.checked); }} /> {s.female}
          </label>
        )}
        {rigs.current.length > 0 && (
          <label className="small">
            <input type="checkbox" data-testid="model-bones" checked={showBones} onChange={(e) => { setShowBones(e.target.checked); }} /> {s.bones}
          </label>
        )}
        <button className="small" data-testid="model-icon" disabled={state !== 'ready'} onClick={() => void saveIcon()}>
          {s.icon}
        </button>
        {state === 'ready' && info && (
          <span className="muted" data-testid="model-stats">
            {info.model.pieces.length > 1 ? `${info.model.pieces.length} ${s.parts} · ` : ''}
            {info.triangles.toLocaleString()} {s.triangles}
          </span>
        )}
      </div>
      {clips.length > 0 && (
        <div style={bar} data-testid="model-anim">
          <label className="small">
            {s.clip}{' '}
            <select
              data-testid="model-clip"
              value={clip}
              onChange={(e) => {
                time.current = 0;
                setClip(e.target.value);
                if (!e.target.value) setPlaying(false);
              }}
            >
              <option value="">{s.bindPose}</option>
              {clips.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button className="small" data-testid="model-play" disabled={!clip || length <= 0} onClick={() => { setPlaying(!playing); }}>
            {playing ? `⏸ ${s.pause}` : `▶ ${s.play}`}
          </button>
          <input
            ref={slider}
            type="range"
            data-testid="model-time"
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
            style={{ flex: 1, minWidth: 80, maxWidth: 320 }}
          />
          <span className="muted mono" style={{ fontSize: '0.85em' }}>
            <span ref={clock}>0.00</span> / {length.toFixed(2)} {s.sec}
          </span>
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div
        ref={host}
        tabIndex={0}
        data-testid="model-canvas"
        data-picked={picked ?? ''}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          e.currentTarget.focus();
          down.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const d = down.current;
          down.current = undefined;
          // A left-button click without dragging — select a part (outside the model — clear the selection).
          if (e.button !== 0 || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
          setPicked(viewer.current?.pick(e.clientX, e.clientY));
        }}
        onPointerMove={(e) => {
          if (e.buttons !== 0) return;
          const h = viewer.current?.pick(e.clientX, e.clientY);
          if (h !== hover) setHover(h);
        }}
        onPointerLeave={() => {
          setHover(undefined);
        }}
        style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', outline: 'none', cursor: hover ? 'pointer' : 'default' }}
      >
        {state !== 'ready' && (
          <div
            className="muted"
            data-testid="model-note"
            style={{ position: 'absolute', left: 0, right: 0, top: '40%', textAlign: 'center', pointerEvents: 'none' }}
          >
            {state === 'empty' && s.none}
            {state === 'none' && s.noModel}
            {state === 'loading' && s.loading}
            {state === 'error' && `${s.failed}${error ? `: ${error}` : ''}`}
          </div>
        )}
      </div>
      {picked !== undefined && (
        <div className="panel-scroll" style={{ width: 300, flexShrink: 0, padding: '6px 8px', borderLeft: '1px solid var(--border, #444)', overflow: 'auto' }}>
          <InsideCard project={project} sid={picked} go={go} />
        </div>
      )}
      </div>
      {(info?.missing.length || info?.model.notes.length || info?.rigNotes.length || saved) && (
        <div className="muted" style={{ padding: '2px 6px', fontSize: '0.85em' }}>
          {saved && (
            <div data-testid="model-icon-saved">
              {s.iconSaved}: {saved}
            </div>
          )}
          {info?.missing.map((m) => (
            <div key={m} className="mono">
              {s.missing}: {m}
            </div>
          ))}
          {info?.model.notes.map((n) => (
            <div key={n.en}>{uiText(n, lang)}</div>
          ))}
          {info?.rigNotes.map((n) => (
            <div key={`${n.kind}|${n.path}`} data-testid="model-rig-note">
              {n.kind === 'unreadable' && s.unreadable(n.path)}
              {n.kind === 'misfit' && s.misfit(n.path, n.bones)}
              {n.kind === 'partial' && s.partial(n.path, n.clips, n.bones.slice(0, 5).join(', ') + (n.bones.length > 5 ? '…' : ''))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

registerPanel({
  id: 'model', group: 'scene',
  title: (t) => MODEL_STRINGS[langOf(t)].panel,
  hint: (t) => MODEL_STRINGS[langOf(t)].hint,
  icon: '◈',
  component: ModelPanel,
  area: 'center',
  shows: { kinds: ['record'], types: MODEL_TYPES },
  order: 95,
});
