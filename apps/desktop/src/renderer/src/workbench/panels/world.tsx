/**
 * Панель «Мир» (этап 7b): весь мир игры в 3D — рельеф с LOD, здания (вдали — коробки, рядом —
 * настоящие модели), подписи городов, полёт камерой, поиск города, клик по объекту — карточка.
 * Правка мира мода: гизмо (сдвиг G / поворот R), сетка и шаг угла, «к земле», удаление,
 * новый объект из списка записей; своя история отмены (Ctrl+Z / Ctrl+Y в окне), запись — в
 * `leveldata` мода при сохранении.
 * Рендер и загрузка — `three/world/*`; здесь только интерфейс.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { formatPosition, newBuildingStates, searchRecords, zoneOfPoint, type BuildingPlacement, type WorldEdits, type WorldIndex } from '@kenshi-editor/core';
import { STRINGS, useLang } from '../../i18n.ts';
import { isTypingIn, shortcut } from '../../keys.ts';
import { ShowInGame } from '../../components/GameLink.tsx';
import { useGameLink } from '../../game.ts';
import type { Lang } from '../../../../shared/api.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { InsideCard } from '../../components/InsideCard.tsx';
import { interiorRequest, NumberField } from './interior.tsx';
import { DEFAULT_EDIT, DEFAULT_SETTINGS, WorldView, type EditSettings, type QualityLevel, type WorldSettings, type WorldStatsView } from '../../three/world/view.ts';
import type { WorldObject } from '../../three/world/objects.ts';

const en = {
  panel: 'World',
  hint: 'The whole game world in 3D: terrain, buildings, towns; fly with the camera, click an object',
  loading: 'Reading the world…',
  failed: 'Could not read the world',
  noGame: 'No heightmap in the game folder (data/newland/land/fullmap.tif).',
  search: 'Fly to a town…',
  quality: 'Quality',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  distance: 'Draw distance',
  help: 'Mouse drag — look, middle — pan, wheel — forward/back, double-click — fly there, town name — fly to town, WASD — fly, Q/E — down/up, Shift — faster, F — fly to selected, Esc — deselect',
  fps: 'FPS',
  first: 'first picture',
  memory: 'memory',
  tiles: 'tiles',
  models: 'models',
  markers: 'boxes',
  foliage: 'plants',
  colour: 'ground colour',
  object: 'Object in the world',
  record: 'Record',
  where: 'Where',
  town: 'Town',
  faction: 'Faction',
  squad: 'Squad',
  residents: 'Residents',
  interior: 'Interior',
  name: 'Name',
  file: 'File',
  empty: 'empty',
  focus: 'Fly to (F)',
  objects: 'objects',
  move: 'Move (G)',
  rotate: 'Rotate (R)',
  grid: 'Grid',
  angle: 'Angle',
  off: 'off',
  ground: 'to ground',
  groundTip: 'While moving along the ground (red/blue arrows) the object keeps its height above the ground; the green arrow raises and lowers it',
  height: 'Above ground',
  heightTip: 'Height above the ground (the green gizmo arrow does the same)',
  undo: 'Undo',
  redo: 'Redo',
  nothing: 'nothing',
  place: 'Place…',
  placeTip: 'New object from the records list — at the ground point in the screen centre',
  placeSearch: 'Building name (en/ru) or id',
  noGround: 'Point the camera at the ground (it is not loaded under the screen centre yet)',
  remove: 'Remove (Del)',
  stepMove: 'Move',
  stepRotate: 'Rotate',
  stepPlace: 'Place',
  stepRemove: 'Remove',
  edited: 'changed in the mod — saved to leveldata with the mod',
  noBridge: 'Show in game: start Kenshi with the Kenshi Bridge plugin and load a save',
  inside: 'Inside…',
  insideTip: 'Open the interior of this building: furniture, chests, beds — move, add, remove',
  editHelp: 'G — move, R — rotate, drag the arrows / ring, Del — remove, Ctrl+Z / Ctrl+Y — undo / redo of world edits',
};
type WorldStrings = typeof en;
const ru: WorldStrings = {
  panel: 'Мир',
  hint: 'Весь мир игры в 3D: рельеф, здания, города; полёт камерой, клик по объекту',
  loading: 'Читаю мир…',
  failed: 'Не удалось прочитать мир',
  noGame: 'В папке игры нет карты высот (data/newland/land/fullmap.tif).',
  search: 'Лететь к городу…',
  quality: 'Качество',
  low: 'Низкое',
  medium: 'Среднее',
  high: 'Высокое',
  distance: 'Дальность',
  help: 'Мышь с кнопкой — осмотреться, средняя — сдвиг, колесо — вперёд/назад, двойной клик — подлететь, название города — к городу, WASD — полёт, Q/E — вниз/вверх, Shift — быстрее, F — к выбранному, Esc — снять выбор',
  fps: 'FPS',
  first: 'первая картинка',
  memory: 'память',
  tiles: 'тайлов',
  models: 'моделей',
  markers: 'коробок',
  foliage: 'растений',
  colour: 'цвет земли',
  object: 'Объект в мире',
  record: 'Запись',
  where: 'Где',
  town: 'Город',
  faction: 'Фракция',
  squad: 'Отряд',
  residents: 'Жители',
  interior: 'Внутри',
  name: 'Имя',
  file: 'Файл',
  empty: 'пусто',
  focus: 'Лететь (F)',
  objects: 'объектов',
  move: 'Сдвиг (G)',
  rotate: 'Поворот (R)',
  grid: 'Сетка',
  angle: 'Угол',
  off: 'нет',
  ground: 'к земле',
  groundTip: 'При сдвиге по земле (красная/синяя стрелки) объект держит высоту над землёй; зелёная стрелка поднимает и опускает',
  height: 'Над землёй',
  heightTip: 'Высота над землёй (то же делает зелёная стрелка гизмо)',
  undo: 'Отменить',
  redo: 'Повторить',
  nothing: 'нечего',
  place: 'Поставить…',
  placeTip: 'Новый объект из списка записей — в точку земли в центре экрана',
  placeSearch: 'Имя здания (рус/англ) или id',
  noGround: 'Наведите камеру на землю (под центром экрана она ещё не загружена)',
  remove: 'Удалить (Del)',
  stepMove: 'Сдвиг',
  stepRotate: 'Поворот',
  stepPlace: 'Новый объект',
  stepRemove: 'Удаление',
  edited: 'изменено в моде — запишется в leveldata при сохранении мода',
  noBridge: 'Показать в игре: запустите Kenshi с плагином Kenshi Bridge и загрузите сохранение',
  inside: 'Внутри…',
  insideTip: 'Открыть интерьер этого здания: мебель, сундуки, кровати — сдвинуть, добавить, удалить',
  editHelp: 'G — сдвиг, R — поворот, тяните стрелки / кольцо, Del — удалить, Ctrl+Z / Ctrl+Y — отмена / повтор правок мира',
};
const WORLD_STRINGS: Record<Lang, WorldStrings> = { en, ru };

const SETTINGS_KEY = 'kedit.world.settings';
const EDIT_KEY = 'kedit.world.edit';
const GRID_STEPS = [0, 10, 50, 100, 250, 500];
const ANGLE_STEPS = [0, 5, 15, 45, 90];

function loadEdit(): EditSettings {
  try {
    const raw = localStorage.getItem(EDIT_KEY);
    if (raw) return { ...DEFAULT_EDIT, ...(JSON.parse(raw) as Partial<EditSettings>) };
  } catch {
    // испорчено — по умолчанию
  }
  return DEFAULT_EDIT;
}

/** Имя записи для людей (рус., если есть). */
function recordName(project: ReturnType<typeof useWorkbench>['project'], lang: Lang, sid: string): string {
  return ((lang === 'ru' ? project.ctx.localizedName(sid) : undefined) ?? project.ctx.name(sid)) || sid;
}

function loadSettings(): WorldSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<WorldSettings>) };
  } catch {
    // испорчено — по умолчанию
  }
  return DEFAULT_SETTINGS;
}

function SidLink({ sid, go, empty }: { sid: string | undefined; go: (sid: string) => void; empty: string }): ReactNode {
  const { project } = useWorkbench();
  const lang = useLang();
  if (!sid) return <span className="muted">{empty}</span>;
  const name = (lang === 'ru' ? project.ctx.localizedName(sid) : undefined) ?? project.ctx.name(sid) ?? sid;
  return (
    <a href="#" onClick={(e) => {
        e.preventDefault();
        go(sid);
      }} title={sid}>
      {name || sid}
    </a>
  );
}

function ObjectCard({ o, s, onFocus, onRemove, onHeight, edited }: { o: WorldObject; s: WorldStrings; onFocus: () => void; onRemove: (() => void) | undefined; onHeight: ((y: number) => void) | undefined; edited: boolean }): ReactNode {
  const { project, go, open } = useWorkbench();
  const link = useGameLink();
  const b: BuildingPlacement | undefined = o.b;
  const rows: [string, ReactNode][] = [
    [s.record, <SidLink sid={o.p.target} go={go} empty={s.empty} />],
    [s.name, b?.name ?? <span className="muted">{s.empty}</span>],
    [s.where, <span className="mono" data-testid="world-card-pos">{formatPosition([o.pos.x, o.pos.y, o.pos.z], o.p.zone)}</span>],
    ...(onHeight ? [[s.height, <span title={s.heightTip}><NumberField testId="world-height" value={Math.round(o.p.position[1] * 10) / 10} onCommit={onHeight} /></span>] as [string, ReactNode]] : []),
    [s.town, <SidLink sid={b?.town} go={go} empty={s.empty} />],
    [s.faction, <SidLink sid={b?.faction} go={go} empty={s.empty} />],
    [s.squad, <SidLink sid={b?.squadTemplate} go={go} empty={s.empty} />],
    [s.residents, <SidLink sid={b?.residentsTemplate} go={go} empty={s.empty} />],
    [s.interior, b?.interior ?? <span className="muted">{s.empty}</span>],
    [s.file, <span className="mono">{`${o.p.file} · ${o.p.layer}`}</span>],
  ];
  return (
    <div data-testid="world-card" data-target={o.p.target} data-holder={o.p.holder} data-key={o.p.key}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
        <b style={{ flex: 1 }}>{s.object}</b>
        <button onClick={onFocus}>{s.focus}</button>
        {b && (
          <button
            data-testid="world-inside"
            title={s.insideTip}
            onClick={() => {
              interiorRequest.set({ building: o.p.target, ...(b.interior ? { layout: b.interior } : {}) });
              go(o.p.target);
              open('interior');
            }}
          >
            ⌂ {s.inside}
          </button>
        )}
        {onRemove && (
          <button data-testid="world-remove" onClick={onRemove}>
            {s.remove}
          </button>
        )}
      </div>
      <div style={{ marginBottom: 4 }}>
        {link.inGame ? <ShowInGame pos={[o.pos.x, o.pos.y, o.pos.z]} /> : <span className="muted" style={{ fontSize: '0.85em' }}>{s.noBridge}</span>}
      </div>
      {edited && (
        <div className="muted" data-testid="world-card-edited" style={{ fontSize: '0.85em', marginBottom: 4 }}>
          ✎ {s.edited}
        </div>
      )}
      <table style={{ fontSize: '0.92em', borderSpacing: '6px 2px', marginBottom: 8 }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="muted" style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                {k}
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <InsideCard project={project} sid={o.p.target} go={go} />
    </div>
  );
}

function Stats({ st, s }: { st: WorldStatsView | undefined; s: WorldStrings }): ReactNode {
  if (!st) return null;
  const parts = [
    `${s.fps} ${st.fps} (${st.frameMs} мс)`,
    st.firstFrameMs !== undefined ? `${s.first} ${(st.firstFrameMs / 1000).toFixed(1)} с` : `${s.first} …`,
    st.heapMb !== undefined ? `${s.memory} ${st.heapMb} МБ` : '',
    `${s.tiles} ${st.tilesDrawn}/${st.tiles}`,
    `${s.models} ${st.models}`,
    `${s.markers} ${st.markers}`,
    st.foliage > 0 ? `${s.foliage} ${st.foliageDrawn}/${st.foliage}` : '',
    st.overview < 100 ? `${s.colour} ${st.overview}%` : '',
  ].filter(Boolean);
  return (
    <span
      className="muted"
      data-testid="world-stats"
      data-fps={st.fps}
      data-frame-ms={st.frameMs}
      data-first-ms={st.firstFrameMs ?? ''}
      data-heap-mb={st.heapMb ?? ''}
      data-models={st.models}
      data-markers={st.markers}
      data-protos={st.protos}
      data-failed={st.failed}
      data-loading={st.loading}
      data-camera={`${st.camera.x},${st.camera.y},${st.camera.z}`}
      data-tiles={st.tilesDrawn}
      data-detailed={st.detailed}
      data-foliage={st.foliage}
      data-foliage-drawn={st.foliageDrawn}
      data-triangles={st.triangles}
      data-calls={st.drawCalls}
      data-overview={st.overview}
      data-gizmo={st.gizmo}
      style={{ fontSize: '0.85em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
    >
      {parts.join(' · ')}
    </span>
  );
}

function WorldPanel(): ReactNode {
  const lang = useLang();
  const s = WORLD_STRINGS[lang];
  const { project } = useWorkbench();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<WorldView | undefined>(undefined);
  const [world, setWorld] = useState<WorldIndex | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [settings, setSettings] = useState<WorldSettings>(loadSettings);
  const [stats, setStats] = useState<WorldStatsView | undefined>();
  const [selected, setSelected] = useState<WorldObject | undefined>();
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [edits, setEdits] = useState<WorldEdits | undefined>();
  const [edit, setEdit] = useState<EditSettings>(loadEdit);
  const [message, setMessage] = useState<string | undefined>();
  const [, setTick] = useState(0);
  const [placing, setPlacing] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    Promise.all([project.world(), project.worldEdits()]).then(
      ([w, ed]) => {
        if (cancelled) return;
        setWorld(w);
        setEdits(ed);
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Окно создаётся заново при смене проекта (настройки — на лету).
  useEffect(() => {
    if (!world || !host.current) return;
    const v = new WorldView(host.current, project.bundle.game, project.ctx, world, settings, lang);
    view.current = v;
    v.onSelect = (o) => {
      setSelected(o);
      setMessage(undefined);
    };
    setCount(v.objects.list.length);
    const timer = setInterval(() => { setStats(v.stats()); }, 500);
    return () => {
      clearInterval(timer);
      view.current = undefined;
      setSelected(undefined);
      v.dispose();
    };
  }, [world, project]);

  // Правки мира мода: гизмо пишет командами ядра, всё (и отмена, и правки ИИ) — обратно в окно.
  useEffect(() => {
    const v = view.current;
    if (!v || !edits) return;
    v.setEditable(true);
    v.setEdit(edit);
    v.onEditChange = (e) => { setEdit(e); };
    v.onCommit = (o, c) => {
      const label = `${v.edit.mode === 'rotate' ? s.stepRotate : s.stepMove}: ${recordName(project, lang, o.p.target)}`;
      try {
        edits.move(o.p.file, o.p.holder, o.p.key, c.position, c.rotation, c.worldY !== undefined ? { worldY: c.worldY } : {}, label);
        setMessage(undefined);
        return true;
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
        return false;
      }
    };
    v.onRemove = (o) => { removeObject(o); };
    const off = edits.onChange((changes) => {
      v.sync(edits, changes);
      setCount(v.objects.list.filter((o) => !o.gone).length);
      setTick((t) => t + 1);
    });
    return () => {
      off();
      v.setEditable(false);
    };
  }, [edits, world, project, lang]);

  useEffect(() => {
    localStorage.setItem(EDIT_KEY, JSON.stringify(edit));
    view.current?.setEdit(edit);
  }, [edit]);

  const removeObject = (o: WorldObject): void => {
    if (!edits) return;
    try {
      edits.remove(o.p.file, o.p.holder, o.p.key, `${s.stepRemove}: ${recordName(project, lang, o.p.target)}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  /** Точная высота над землёй из карточки: тот же шаг «Сдвиг», что у гизмо. */
  const setHeight = (o: WorldObject, y: number): void => {
    if (!edits) return;
    const [x, y0, z] = o.p.position;
    const q = o.quat;
    try {
      edits.move(o.p.file, o.p.holder, o.p.key, [x, y, z], [q.w, q.x, q.y, q.z], o.b ? { worldY: o.pos.y + (y - y0) } : {}, `${s.stepMove}: ${recordName(project, lang, o.p.target)}`);
      setMessage(undefined);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const placeRecord = (sid: string): void => {
    const v = view.current;
    if (!v || !edits) return;
    const at = v.centreGround();
    if (!at) {
      setMessage(s.noGround);
      return;
    }
    const z = zoneOfPoint(at.x, at.z);
    const path = `zone.${z.x}.${z.y}.zone`;
    const holder = edits.holders(path).find((h) => h.endsWith('buildinglist')) ?? '0-buildinglist';
    try {
      // Здание ставим готовым: без состояния игра делает из него стройплощадку «на продажу».
      const states = newBuildingStates(project.ctx.get(sid), at.y);
      const key = edits.place(path, holder, sid, [at.x, 0, at.z], [1, 0, 0, 0], states ? { states } : {}, `${s.stepPlace}: ${recordName(project, lang, sid)}`);
      setPlacing(undefined);
      setMessage(undefined);
      const o = v.objects.find(path, holder, key);
      if (o) v.select(o);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const undoRedo = (redo: boolean): void => {
    if (!edits) return;
    if (redo) edits.redo();
    else edits.undo();
  };

  // Ctrl+Z / Ctrl+Y в окне мира — отмена правок мира (не записей): ловим до общего обработчика.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!edits || isTypingIn(e.target)) return;
    const k = shortcut(e);
    if (k !== 'ctrl+z' && k !== 'ctrl+y' && k !== 'ctrl+shift+z') return;
    e.preventDefault();
    e.stopPropagation();
    undoRedo(k !== 'ctrl+z');
  };

  const placeHits = useMemo(() => {
    const q = placing?.trim();
    if (!q) return [];
    return searchRecords(project.ctx, { text: q, type: 'BUILDING' }).slice(0, 14);
  }, [placing, project]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    view.current?.applySettings(settings);
  }, [settings]);

  const towns = useMemo(() => {
    const v = view.current;
    if (!v) return [];
    const seen = new Set<string>();
    return v.towns.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true))).sort((a, b) => a.name.localeCompare(b.name));
  }, [count]);

  const flyToTown = (name: string): void => {
    const v = view.current;
    const q = name.trim().toLowerCase();
    if (!v || !q) return;
    const t = v.towns.find((x) => x.name.toLowerCase() === q) ?? v.towns.find((x) => x.name.toLowerCase().includes(q));
    if (t) v.flyToPoint(t.pos);
  };

  const set = (patch: Partial<WorldSettings>): void => { setSettings((old) => ({ ...old, ...patch })); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-testid="world-panel" onKeyDownCapture={onKeyDown}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', flexWrap: 'wrap' }}>
        <input
          data-testid="world-search"
          list="world-towns"
          placeholder={s.search}
          value={query}
          style={{ width: 200 }}
          onChange={(e) => {
            setQuery(e.target.value);
            // Выбор из списка подсказок — сразу лететь.
            if (towns.some((t) => t.name === e.target.value)) flyToTown(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') flyToTown(query);
          }}
        />
        <datalist id="world-towns">
          {towns.map((t) => (
            <option key={`${t.sid}@${t.pos.x}`} value={t.name} />
          ))}
        </datalist>
        <label>
          {s.quality}{' '}
          <select data-testid="world-quality" value={settings.quality} onChange={(e) => { set({ quality: e.target.value as QualityLevel }); }}>
            <option value="low">{s.low}</option>
            <option value="medium">{s.medium}</option>
            <option value="high">{s.high}</option>
          </select>
        </label>
        <label title={`${settings.drawDistance}`}>
          {s.distance}{' '}
          <input
            data-testid="world-distance"
            type="range"
            min={5000}
            max={80000}
            step={2500}
            value={settings.drawDistance}
            onChange={(e) => { set({ drawDistance: Number(e.target.value) }); }}
            style={{ verticalAlign: 'middle' }}
          />
        </label>
        <span style={{ flex: 1 }} />
        {count > 0 && (
          <span className="muted" style={{ fontSize: '0.85em' }}>
            {count} {s.objects}
          </span>
        )}
        <Stats st={stats} s={s} />
      </div>
      {edits && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 6px', flexWrap: 'wrap', position: 'relative' }} data-testid="world-edit-bar">
          <span>
            <button data-testid="world-mode-move" className={edit.mode === 'move' ? 'small active' : 'small'} aria-pressed={edit.mode === 'move'} onClick={() => { setEdit({ ...edit, mode: 'move' }); }}>
              ✥ {s.move}
            </button>
            <button data-testid="world-mode-rotate" className={edit.mode === 'rotate' ? 'small active' : 'small'} aria-pressed={edit.mode === 'rotate'} onClick={() => { setEdit({ ...edit, mode: 'rotate' }); }}>
              ⟳ {s.rotate}
            </button>
          </span>
          <label>
            {s.grid}{' '}
            <select data-testid="world-grid" value={edit.grid} onChange={(e) => { setEdit({ ...edit, grid: Number(e.target.value) }); }}>
              {GRID_STEPS.map((g) => (
                <option key={g} value={g}>
                  {g === 0 ? s.off : g}
                </option>
              ))}
            </select>
          </label>
          <label>
            {s.angle}{' '}
            <select data-testid="world-angle" value={edit.angle} onChange={(e) => { setEdit({ ...edit, angle: Number(e.target.value) }); }}>
              {ANGLE_STEPS.map((a) => (
                <option key={a} value={a}>
                  {a === 0 ? s.off : `${a}°`}
                </option>
              ))}
            </select>
          </label>
          <label title={s.groundTip}>
            <input data-testid="world-ground" type="checkbox" checked={edit.ground} onChange={(e) => { setEdit({ ...edit, ground: e.target.checked }); }} /> {s.ground}
          </label>
          <button data-testid="world-undo" disabled={!edits.canUndo()} title={`${s.undo}: ${edits.undoLabel() ?? s.nothing} (Ctrl+Z)`} onClick={() => { undoRedo(false); }}>
            ↶
          </button>
          <button data-testid="world-redo" disabled={!edits.canRedo()} title={`${s.redo}: ${edits.redoLabel() ?? s.nothing} (Ctrl+Y)`} onClick={() => { undoRedo(true); }}>
            ↷
          </button>
          <span className="muted" data-testid="world-last-step" style={{ fontSize: '0.85em' }}>
            {edits.undoLabel() ?? ''}
          </span>
          <input
            data-testid="world-place"
            placeholder={s.place}
            title={s.placeTip}
            value={placing ?? ''}
            style={{ width: 200 }}
            onChange={(e) => { setPlacing(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPlacing(undefined);
              if (e.key === 'Enter' && placeHits[0]) placeRecord(placeHits[0].stringId);
            }}
          />
          {placeHits.length > 0 && (
            <div className="menu" data-testid="world-place-hits" style={{ left: 'auto', right: 6, maxHeight: 320, overflow: 'auto', minWidth: 280 }}>
              {placeHits.map((h) => (
                <div key={h.stringId} className="menu-item" data-sid={h.stringId} style={{ cursor: 'pointer' }} onClick={() => { placeRecord(h.stringId); }}>
                  {h.localizedName ?? h.name} <span className="muted">{h.stringId}</span>
                </div>
              ))}
            </div>
          )}
          {message && (
            <span className="error" data-testid="world-message" style={{ fontSize: '0.85em' }}>
              {message}
            </span>
          )}
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div ref={host} data-testid="world-view" data-ready={stats?.firstFrameMs !== undefined ? 'yes' : 'no'} style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
          {!world && (
            <div className="muted" data-testid="world-note" style={{ position: 'absolute', left: 0, right: 0, top: '40%', textAlign: 'center' }}>
              {error ? `${s.failed}: ${error}` : s.loading}
            </div>
          )}
          {view.current?.terrain.missing && (
            <div className="muted" style={{ position: 'absolute', left: 8, top: 8 }}>
              {s.noGame}
            </div>
          )}
        </div>
        {selected && (
          <div className="panel-scroll" style={{ width: 330, flexShrink: 0, padding: '6px 8px', borderLeft: '1px solid var(--border, #444)', overflow: 'auto' }}>
            <ObjectCard
              o={selected}
              s={s}
              onFocus={() => view.current?.focus(selected)}
              onRemove={edits ? () => { removeObject(selected); } : undefined}
              onHeight={edits ? (y) => { setHeight(selected, y); } : undefined}
              edited={edits?.modRecords(selected.p.file).some((r) => r.stringId === selected.p.holder && r.instances.has(selected.p.key)) ?? false}
            />
          </div>
        )}
      </div>
      <div className="muted" style={{ padding: '2px 6px', fontSize: '0.8em' }}>
        {s.help}
        {edits ? `. ${s.editHelp}` : ''}
      </div>
    </div>
  );
}

registerPanel({
  id: 'world',
  title: (t) => WORLD_STRINGS[t === STRINGS.en ? 'en' : 'ru'].panel,
  hint: (t) => WORLD_STRINGS[t === STRINGS.en ? 'en' : 'ru'].hint,
  icon: '🗺',
  component: WorldPanel,
  area: 'center',
  order: 98,
});
