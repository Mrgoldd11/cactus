/**
 * «World» panel (stage 7b): the whole game world in 3D — terrain with LOD, buildings (far away — boxes, close up —
 * real models), town labels, camera flight, town search, click on an object — card.
 * Mod world editing: gizmo (move G / rotate R), grid and angle step, «snap to ground», deletion,
 * a new object from the record list; own undo history (Ctrl+Z / Ctrl+Y in the view), written to the
 * mod `leveldata` on save.
 * Rendering and loading — `three/world/*`; here only the UI.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { formatPosition, newBuildingStates, zoneOfPoint, type BuildingPlacement, type WorldEdits, type WorldIndex } from '@kenshi-editor/core';
import { errorText, langOf, useLang } from '../../i18n.ts';
import { isTypingIn, shortcut } from '../../keys.ts';
import { ShowInGame } from '../../components/GameLink.tsx';
import { useGameLink } from '../../game.ts';
import type { Lang } from '../../../../shared/api.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { InsideCard } from '../../components/InsideCard.tsx';
import { PlaceBox } from '../../components/PlaceBox.tsx';
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
  borders: 'Town borders',
  help: 'Mouse drag — look, middle — pan, wheel — forward/back, double-click — fly there, town name — fly to town, WASD — fly, Q/E — down/up, Shift — faster, F — fly to selected, Esc — deselect',
  fps: 'FPS',
  first: 'first picture',
  memory: 'memory',
  ms: 'ms',
  sec: 's',
  mb: 'MB',
  tiles: 'tiles',
  models: 'models',
  markers: 'boxes',
  foliage: 'plants',
  fromGame: 'as in game',
  gameBuildings: 'game-only buildings',
  noModel: 'no model',
  showGameBuildings: 'Buildings of other mods (from the game)',
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
  ground: 'Snap to ground',
  groundTip: 'While moving along the ground (red/blue arrows) the object keeps its height above the ground; the green arrow raises and lowers it',
  height: 'Above ground',
  heightTip: 'Height above the ground (the green gizmo arrow does the same)',
  undo: 'Undo',
  redo: 'Redo',
  nothing: 'nothing',
  place: 'Place…',
  placeTip: 'New object from the records list — at the ground point in the screen centre',
  placeSearch: 'Building name (English or translated) or id',
  noMatches: 'Nothing found',
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
  borders: 'Границы городов',
  help: 'Мышь с кнопкой — осмотреться, средняя — сдвиг, колесо — вперёд/назад, двойной клик — подлететь, название города — к городу, WASD — полёт, Q/E — вниз/вверх, Shift — быстрее, F — к выбранному, Esc — снять выбор',
  fps: 'FPS',
  first: 'первая картинка',
  memory: 'память',
  ms: 'мс',
  sec: 'с',
  mb: 'МБ',
  tiles: 'тайлов',
  models: 'моделей',
  markers: 'коробок',
  foliage: 'растений',
  fromGame: 'как в игре',
  gameBuildings: 'построек только из игры',
  noModel: 'без модели',
  showGameBuildings: 'Постройки других модов (из игры)',
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
  ground: 'К земле',
  groundTip: 'При сдвиге по земле (красная/синяя стрелки) объект держит высоту над землёй; зелёная стрелка поднимает и опускает',
  height: 'Над землёй',
  heightTip: 'Высота над землёй (то же делает зелёная стрелка гизмо)',
  undo: 'Отменить',
  redo: 'Повторить',
  nothing: 'нечего',
  place: 'Поставить…',
  placeTip: 'Новый объект из списка записей — в точку земли в центре экрана',
  placeSearch: 'Имя здания (английское или перевод) или id',
  noMatches: 'Ничего не найдено',
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
const zh: WorldStrings = {
  panel: '世界',
  hint: '整个游戏世界的 3D 视图：地形、建筑、城镇；用镜头飞行，点击对象',
  loading: '正在读取世界…',
  failed: '无法读取世界',
  noGame: '游戏文件夹中没有高度图（data/newland/land/fullmap.tif）。',
  search: '飞往城镇…',
  quality: '画质',
  low: '低',
  medium: '中',
  high: '高',
  distance: '绘制距离',
  borders: '城镇边界',
  help: '鼠标拖动——环顾，中键——平移，滚轮——前进/后退，双击——飞到该处，城镇名称——飞往城镇，WASD——飞行，Q/E——下降/上升，Shift——加速，F——飞到所选对象，Esc——取消选择',
  fps: '帧率',
  first: '首帧',
  memory: '内存',
  ms: '毫秒',
  sec: '秒',
  mb: 'MB',
  tiles: '地块',
  models: '模型',
  markers: '方框',
  foliage: '植被',
  fromGame: '与游戏一致',
  gameBuildings: '仅游戏中的建筑',
  noModel: '无模型',
  showGameBuildings: '其他模组的建筑(来自游戏)',
  colour: '地面颜色',
  object: '世界中的对象',
  record: '记录',
  where: '位置',
  town: '城镇',
  faction: '阵营',
  squad: '小队',
  residents: '居民',
  interior: '室内',
  name: '名称',
  file: '文件',
  empty: '空',
  focus: '飞到 (F)',
  objects: '个对象',
  move: '移动 (G)',
  rotate: '旋转 (R)',
  grid: '网格',
  angle: '角度',
  off: '关',
  ground: '贴地',
  groundTip: '沿地面移动（红/蓝箭头）时，对象会保持离地高度；绿色箭头用于升降',
  height: '离地高度',
  heightTip: '离地面的高度（绿色操纵箭头的作用相同）',
  undo: '撤销',
  redo: '重做',
  nothing: '无',
  place: '放置…',
  placeTip: '从记录列表中放置新对象——放在屏幕中心的地面点上',
  placeSearch: '建筑名称（英文或译名）或 ID',
  noMatches: '未找到',
  noGround: '请把镜头对准地面（屏幕中心下方的地面尚未加载）',
  remove: '移除 (Del)',
  stepMove: '移动',
  stepRotate: '旋转',
  stepPlace: '放置',
  stepRemove: '移除',
  edited: '已在 Mod 中修改——保存 Mod 时会写入 leveldata',
  noBridge: '在游戏中显示：请启动装有 Kenshi Bridge 插件的 Kenshi 并载入存档',
  inside: '进入内部…',
  insideTip: '打开这座建筑的室内：家具、箱子、床——移动、添加、移除',
  editHelp: 'G——移动，R——旋转，拖动箭头 / 圆环，Del——移除，Ctrl+Z / Ctrl+Y——撤销 / 重做世界修改',
};
const WORLD_STRINGS: Record<Lang, WorldStrings> = { en, ru, zh };

/** What can be placed in the world from the «Place…» list. */
const PLACE_TYPES = ['BUILDING'];
const SETTINGS_KEY = 'kedit.world.settings';
const EDIT_KEY = 'kedit.world.edit';
const GRID_STEPS = [0, 10, 50, 100, 250, 500];
const ANGLE_STEPS = [0, 5, 15, 45, 90];

function loadEdit(): EditSettings {
  try {
    const raw = localStorage.getItem(EDIT_KEY);
    if (raw) return { ...DEFAULT_EDIT, ...(JSON.parse(raw) as Partial<EditSettings>) };
  } catch {
    // corrupt — use defaults
  }
  return DEFAULT_EDIT;
}

/** Human-readable record name (Russian if present). */
function recordName(project: ReturnType<typeof useWorkbench>['project'], sid: string): string {
  return (project.ctx.localizedName(sid) ?? project.ctx.name(sid)) || sid;
}

function loadSettings(): WorldSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<WorldSettings>) };
  } catch {
    // corrupt — use defaults
  }
  return DEFAULT_SETTINGS;
}

function SidLink({ sid, go, empty }: { sid: string | undefined; go: (sid: string) => void; empty: string }): ReactNode {
  const { project } = useWorkbench();
  if (!sid) return <span className="muted">{empty}</span>;
  const name = project.ctx.localizedName(sid) ?? project.ctx.name(sid) ?? sid;
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
  // Only buildings you can walk into: the record has interior parts or the instance names a layout.
  const hasInside = b !== undefined && (b.interior !== undefined || (project.ctx.get(o.p.target)?.refs.get('interior') ?? []).length > 0);
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
        {b && hasInside && (
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
    `${s.fps} ${st.fps} (${st.frameMs} ${s.ms})`,
    st.firstFrameMs !== undefined ? `${s.first} ${(st.firstFrameMs / 1000).toFixed(1)} ${s.sec}` : `${s.first} …`,
    st.heapMb !== undefined ? `${s.memory} ${st.heapMb} ${s.mb}` : '',
    `${s.tiles} ${st.tilesDrawn}/${st.tiles}`,
    `${s.models} ${st.models}`,
    `${s.markers} ${st.markers}`,
    st.foliage > 0 ? `${s.foliage} ${st.foliageDrawn}/${st.foliage}${st.foliageFromGame > 0 ? ` (${s.fromGame} ${st.foliageFromGame})` : ''}` : '',
    st.dumpBuildings > 0 ? `${s.gameBuildings} ${st.dumpBuildingsDrawn}/${st.dumpBuildings}${st.dumpBuildingsNoModel > 0 ? ` (${s.noModel} ${st.dumpBuildingsNoModel})` : ''}` : '',
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
      data-foliage-game={st.foliageFromGame}
      data-dump-zones={st.dumpZones}
      data-dump-buildings={st.dumpBuildings}
      data-dump-buildings-drawn={st.dumpBuildingsDrawn}
      data-dump-buildings-no-model={st.dumpBuildingsNoModel}
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

  useEffect(() => {
    let cancelled = false;
    Promise.all([project.world(), project.worldEdits()]).then(
      ([w, ed]) => {
        if (cancelled) return;
        setWorld(w);
        setEdits(ed);
      },
      (e: unknown) => {
        if (!cancelled) setError(errorText(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project]);

  // The view is recreated when the project changes (settings — on the fly).
  useEffect(() => {
    if (!world || !host.current) return;
    const v = new WorldView(host.current, project.bundle.game, project.ctx, world, settings);
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

  // Mod world edits: the gizmo writes via core commands, everything (undo and AI edits too) goes back into the view.
  useEffect(() => {
    const v = view.current;
    if (!v || !edits) return;
    v.setEditable(true);
    v.setEdit(edit);
    v.onEditChange = (e) => { setEdit(e); };
    v.onCommit = (o, c) => {
      const label = `${v.edit.mode === 'rotate' ? s.stepRotate : s.stepMove}: ${recordName(project, o.p.target)}`;
      try {
        edits.move(o.p.file, o.p.holder, o.p.key, c.position, c.rotation, c.worldY !== undefined ? { worldY: c.worldY } : {}, label);
        setMessage(undefined);
        return true;
      } catch (e) {
        setMessage(errorText(e));
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
      edits.remove(o.p.file, o.p.holder, o.p.key, `${s.stepRemove}: ${recordName(project, o.p.target)}`);
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  /** Exact height above ground from the card: the same «Move» step as the gizmo. */
  const setHeight = (o: WorldObject, y: number): void => {
    if (!edits) return;
    const [x, y0, z] = o.p.position;
    const q = o.quat;
    try {
      edits.move(o.p.file, o.p.holder, o.p.key, [x, y, z], [q.w, q.x, q.y, q.z], o.b ? { worldY: o.pos.y + (y - y0) } : {}, `${s.stepMove}: ${recordName(project, o.p.target)}`);
      setMessage(undefined);
    } catch (e) {
      setMessage(errorText(e));
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
      // A building is placed finished: without a state the game turns it into a «for sale» construction site.
      const states = newBuildingStates(project.ctx.get(sid), at.y);
      const key = edits.place(path, holder, sid, [at.x, 0, at.z], [1, 0, 0, 0], states ? { states } : {}, `${s.stepPlace}: ${recordName(project, sid)}`);
      setMessage(undefined);
      const o = v.objects.find(path, holder, key);
      if (o) v.select(o);
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  const undoRedo = (redo: boolean): void => {
    if (!edits) return;
    if (redo) edits.redo();
    else edits.undo();
  };

  // Ctrl+Z / Ctrl+Y in the world view undo world edits (not records): caught before the shared handler.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!edits || isTypingIn(e.target)) return;
    const k = shortcut(e);
    if (k !== 'ctrl+z' && k !== 'ctrl+y' && k !== 'ctrl+shift+z') return;
    e.preventDefault();
    e.stopPropagation();
    undoRedo(k !== 'ctrl+z');
  };

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
    // Two numbers — world coordinates "x z" (as in the object card).
    const xz = /^(-?\d+(?:[.,]\d+)?)[\s;,]+(-?\d+(?:[.,]\d+)?)$/.exec(q);
    if (xz) {
      const x = Number(xz[1]!.replace(',', '.'));
      const z = Number(xz[2]!.replace(',', '.'));
      v.flyToXZ(x, z);
      return;
    }
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
            // Choosing from the suggestion list — fly there at once.
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
        <label title={s.borders}>
          <input data-testid="world-borders" type="checkbox" checked={settings.borders} onChange={(e) => { set({ borders: e.target.checked }); }} style={{ verticalAlign: 'middle' }} /> {s.borders}
        </label>
        {stats !== undefined && stats.dumpZones > 0 && (
          <label title={s.showGameBuildings}>
            <input data-testid="world-game-buildings" type="checkbox" checked={settings.gameBuildings} onChange={(e) => { set({ gameBuildings: e.target.checked }); }} style={{ verticalAlign: 'middle' }} /> {s.showGameBuildings}
          </label>
        )}
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
          <PlaceBox
            project={project}
            types={PLACE_TYPES}
            testId="world-place"
            placeholder={s.place}
            title={`${s.placeTip}. ${s.placeSearch}`}
            emptyText={s.noMatches}
            countText={(n, total) => `${n} / ${total}`}
            onPick={placeRecord}
          />
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
  id: 'world', group: 'scene',
  title: (t) => WORLD_STRINGS[langOf(t)].panel,
  hint: (t) => WORLD_STRINGS[langOf(t)].hint,
  icon: '▦',
  component: WorldPanel,
  area: 'center',
  order: 98,
});
