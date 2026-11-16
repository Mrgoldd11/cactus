/**
 * Панель «Модель»: 3D-модель выбранной записи (оружие, броня, здание, часть здания, предмет)
 * из файлов игры. Мышь — как в Blender/Unity: левая кнопка вращает, средняя/правая сдвигает,
 * колесо приближает; F — показать целиком, цифры 1/3/7 (основные или на цифровом блоке) — вид
 * спереди/справа/сверху. Можно сохранить картинку модели как иконку (PNG с прозрачным фоном).
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { modelOfRecord, type RecordModel } from '@kenshi-editor/core';
import { errorText, langOf, useLang } from '../../i18n.ts';
import type { Lang } from '../../../../shared/api.ts';
import { shortcut } from '../../keys.ts';
import { registerPanel, type PanelProps } from '../registry.ts';
import { useFollowed, useWorkbench } from '../context.ts';
import { InsideCard } from '../../components/InsideCard.tsx';
import { ModelViewer, type ViewSide } from '../../three/viewer.ts';
import { buildModel, disposeModel } from '../../three/build.ts';

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
};
const MODEL_STRINGS: Record<Lang, ModelStrings> = { en, ru, zh };

/** Типы записей, у которых в игре бывает модель. */
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
  const s = MODEL_STRINGS[useLang()];
  const { project, go } = useWorkbench();
  const { sid, version } = useFollowed(def, params);
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<ModelViewer | undefined>(undefined);
  const [interior, setInterior] = useState(false);
  const [wire, setWire] = useState(false);
  const [state, setState] = useState<ViewState>('empty');
  const [info, setInfo] = useState<{ model: RecordModel; triangles: number; missing: string[] } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();
  /** Выбранная кликом часть модели (запись части или сама запись) и часть под мышью. */
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

  const model = sid === undefined ? undefined : modelOfRecord(project.ctx, sid, { interior });
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
      setInfo(model ? { model, triangles: 0, missing: [] } : undefined);
      setState(sid === undefined ? 'empty' : 'none');
      return;
    }
    let cancelled = false;
    setState('loading');
    setError(undefined);
    buildModel(project.bundle.game, model)
      .then((built) => {
        if (cancelled) {
          disposeModel(built.group);
          return;
        }
        const old = v.scene.getObjectByName('__model');
        built.group.name = '__model';
        v.setModel(built.group);
        if (old) disposeModel(old);
        setInfo({ model, triangles: built.triangles, missing: built.missing });
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
    // modelKey описывает модель целиком; version — правки записи.
  }, [modelKey, sid, version, project]);

  useEffect(() => {
    viewer.current?.highlight(picked, hover);
  }, [picked, hover, info]);

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
          // Клик без перетаскивания левой кнопкой — выбрать часть (мимо модели — снять выбор).
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
      {(info?.missing.length || info?.model.notes.length || saved) && (
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
            <div key={n}>{n}</div>
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
