/**
 * Панель «Внутри»: интерьер здания — раскладка (INSTANCE_COLLECTION в `interiors.level`) с
 * мебелью, сундуками, верстаками, кроватями и точками предметов. Выбор, сдвиг и поворот гизмо,
 * точные координаты, удаление, новый объект из списка записей. Правки — командами ядра в общую
 * историю правок мира (Ctrl+Z / Ctrl+Y в окне), запись — в `interiors.level` мода при сохранении.
 * Открывается из карточки здания в «Мире» или следует за выбранной записью здания.
 * Рендер — `three/interior.ts`; здесь только интерфейс.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  INTERIORS,
  interiorLayouts,
  layoutObjects,
  layoutUsage,
  moveInterior,
  placeInterior,
  removeInterior,
  type InteriorLayout,
  type InteriorObject,
  type WorldEdits,
  type WorldIndex,
} from '@kenshi-editor/core';
import { langOf, useLang } from '../../i18n.ts';
import { isTypingIn, shortcut } from '../../keys.ts';
import { PlaceBox } from '../../components/PlaceBox.tsx';
import type { Lang } from '../../../../shared/api.ts';
import { registerPanel, type PanelProps } from '../registry.ts';
import { useFollowed, useWorkbench } from '../context.ts';
import { useStore, ValueStore } from '../store.ts';
import { DEFAULT_INTERIOR_EDIT, InteriorView, type InteriorEditSettings, type InteriorItem } from '../../three/interior.ts';

const en = {
  panel: 'Inside',
  hint: 'Interior of a building: furniture, chests, workbenches, beds, item spots — move, rotate, add, remove',
  none: 'Select a building (record or object in the World window).',
  loading: 'Reading interiors…',
  failed: 'Could not read interiors',
  noLayouts: 'This building has no interior layouts in the game files.',
  layout: 'Layout',
  exterior: 'outside',
  shop: 'shop',
  bar: 'bar',
  recruitment: 'recruitment',
  flophouse: 'flophouse',
  objects: 'objects',
  move: 'Move (G)',
  rotate: 'Rotate (R)',
  grid: 'Grid',
  angle: 'Angle',
  off: 'off',
  undo: 'Undo',
  redo: 'Redo',
  nothing: 'nothing',
  place: 'Place…',
  placeTip: 'New furniture or item spot from the records list — at the point in the screen centre',
  placeSearch: 'Name (en/ru) or id',
  noMatches: 'Nothing found',
  remove: 'Remove (Del)',
  focus: 'Show (F)',
  stepMove: 'Move inside',
  stepRotate: 'Rotate inside',
  stepPlace: 'Inside',
  stepRemove: 'Removed from inside',
  object: 'Object',
  record: 'Record',
  kind: 'Kind',
  furniture: 'furniture',
  items: 'item spot',
  other: 'other',
  where: 'Position',
  turn: 'Turn',
  floor: 'Floor',
  lock: 'Lock',
  locked: 'locked',
  level: 'level',
  contents: 'Spawns',
  state: 'State',
  key: 'Key',
  edited: 'changed in the mod — saved to leveldata/interiors.level with the mod',
  usage: (named: number, unnamed: number, total: number): string =>
    `In the world: ${named} buildings use this layout by name; ${unnamed} of ${total} buildings of this type have no layout name — the game picks one itself.`,
  shared: 'A layout is shared: an edit changes this interior in every building that uses it.',
  notIn: 'Residents (NPCs) and shop goods are not part of a layout — the game takes them from the town, faction and squads.',
  fresh: 'No sample of this object in any layout: its state was built from scratch (not checked in game).',
  copied: 'State copied from',
  help: 'Left mouse — rotate view, middle/right — pan, wheel — zoom, click — select, G/R — move/rotate, Del — remove, F — show, Esc — deselect, Ctrl+Z / Ctrl+Y — undo / redo of world edits',
  loadingModels: 'models…',
};
type InteriorStrings = typeof en;
const ru: InteriorStrings = {
  panel: 'Внутри',
  hint: 'Интерьер здания: мебель, сундуки, верстаки, кровати, точки предметов — сдвиг, поворот, добавить, удалить',
  none: 'Выберите здание (запись или объект в окне «Мир»).',
  loading: 'Читаю интерьеры…',
  failed: 'Не удалось прочитать интерьеры',
  noLayouts: 'У этого здания нет раскладок интерьера в файлах игры.',
  layout: 'Раскладка',
  exterior: 'снаружи',
  shop: 'магазин',
  bar: 'бар',
  recruitment: 'наём',
  flophouse: 'ночлежка',
  objects: 'объектов',
  move: 'Сдвиг (G)',
  rotate: 'Поворот (R)',
  grid: 'Сетка',
  angle: 'Угол',
  off: 'нет',
  undo: 'Отменить',
  redo: 'Повторить',
  nothing: 'нечего',
  place: 'Поставить…',
  placeTip: 'Новая мебель или точка предметов из списка записей — в точку в центре экрана',
  placeSearch: 'Имя (рус/англ) или id',
  noMatches: 'Ничего не найдено',
  remove: 'Удалить (Del)',
  focus: 'Показать (F)',
  stepMove: 'Сдвиг в интерьере',
  stepRotate: 'Поворот в интерьере',
  stepPlace: 'В интерьер',
  stepRemove: 'Из интерьера',
  object: 'Объект',
  record: 'Запись',
  kind: 'Вид',
  furniture: 'мебель',
  items: 'точка предметов',
  other: 'другое',
  where: 'Место',
  turn: 'Поворот',
  floor: 'Этаж',
  lock: 'Замок',
  locked: 'заперт',
  level: 'уровень',
  contents: 'Что появляется',
  state: 'Состояние',
  key: 'Ключ',
  edited: 'изменено в моде — запишется в leveldata/interiors.level при сохранении мода',
  usage: (named: number, unnamed: number, total: number): string =>
    `В мире: у ${named} зданий эта раскладка по имени; ещё у ${unnamed} из ${total} зданий этого типа имени нет — игра выбирает раскладку сама.`,
  shared: 'Раскладка общая: правка меняет этот интерьер во всех зданиях, где она стоит.',
  notIn: 'Жителей (NPC) и товары магазина раскладка не задаёт — игра берёт их от города, фракции и отрядов.',
  fresh: 'Такого объекта нет ни в одной раскладке: состояние собрано заново (в игре не проверено).',
  copied: 'Состояние скопировано с',
  help: 'Левая кнопка — вращать вид, средняя/правая — сдвигать, колесо — ближе/дальше, клик — выбрать, G/R — сдвиг/поворот, Del — удалить, F — показать, Esc — снять выбор, Ctrl+Z / Ctrl+Y — отмена / повтор правок мира',
  loadingModels: 'модели…',
};
const zh: InteriorStrings = {
  panel: '室内',
  hint: '建筑内部：家具、箱子、工作台、床、物品点——移动、旋转、添加、移除',
  none: '请选择一座建筑（“世界”窗口中的记录或对象）。',
  loading: '正在读取室内布局…',
  failed: '无法读取室内布局',
  noLayouts: '游戏文件中没有这座建筑的室内布局。',
  layout: '布局',
  exterior: '室外',
  shop: '商店',
  bar: '酒吧',
  recruitment: '招募',
  flophouse: '廉价旅馆',
  objects: '个对象',
  move: '移动 (G)',
  rotate: '旋转 (R)',
  grid: '网格',
  angle: '角度',
  off: '关',
  undo: '撤销',
  redo: '重做',
  nothing: '无',
  place: '放置…',
  placeTip: '从记录列表中放置新的家具或物品点——放在屏幕中心的位置',
  placeSearch: '名称（英/俄）或 ID',
  noMatches: '未找到',
  remove: '移除 (Del)',
  focus: '定位 (F)',
  stepMove: '室内移动',
  stepRotate: '室内旋转',
  stepPlace: '放入室内',
  stepRemove: '从室内移除',
  object: '对象',
  record: '记录',
  kind: '种类',
  furniture: '家具',
  items: '物品点',
  other: '其他',
  where: '位置',
  turn: '旋转',
  floor: '楼层',
  lock: '锁',
  locked: '已上锁',
  level: '等级',
  contents: '生成内容',
  state: '状态',
  key: '钥匙',
  edited: '已在 Mod 中修改——保存 Mod 时会写入 leveldata/interiors.level',
  usage: (named: number, unnamed: number, total: number): string =>
    `在世界中：有 ${named} 座建筑按名称使用此布局；此类建筑共 ${total} 座，其中 ${unnamed} 座没有布局名称——由游戏自行选择。`,
  shared: '此布局是共用的：修改它会改变所有使用它的建筑的这个室内。',
  notIn: '居民（NPC）和商店商品不属于布局——游戏从城镇、阵营和小队获取它们。',
  fresh: '任何布局中都没有这种对象的样本：其状态是从零构建的（未在游戏中验证）。',
  copied: '状态复制自',
  help: '鼠标左键——旋转视角，中键/右键——平移，滚轮——缩放，点击——选择，G/R——移动/旋转，Del——移除，F——定位，Esc——取消选择，Ctrl+Z / Ctrl+Y——撤销 / 重做世界修改',
  loadingModels: '模型…',
};
const INTERIOR_STRINGS: Record<Lang, InteriorStrings> = { en, ru, zh };

/** Что можно поставить в интерьер: мебель и точки предметов. */
const PLACE_TYPES = ['BUILDING', 'ITEM_PLACEMENT_GROUP'];

/** Просьба открыть интерьер (кнопка «Внутри» в карточке здания мира): здание и имя раскладки. */
export const interiorRequest = new ValueStore<{ building: string; layout?: string } | undefined>(undefined);

const EDIT_KEY = 'kedit.interior.edit';
const GRID_STEPS = [0, 1, 5, 10, 25, 50];
const ANGLE_STEPS = [0, 5, 15, 45, 90];

function loadEdit(): InteriorEditSettings {
  try {
    const raw = localStorage.getItem(EDIT_KEY);
    if (raw) return { ...DEFAULT_INTERIOR_EDIT, ...(JSON.parse(raw) as Partial<InteriorEditSettings>) };
  } catch {
    // испорчено — по умолчанию
  }
  return DEFAULT_INTERIOR_EDIT;
}

/** Угол поворота вокруг вертикали в градусах (из w, x, y, z). */
function yawDeg(r: readonly number[]): number {
  const [w = 1, , y = 0] = r;
  const d = (Math.atan2(2 * w * y, 1 - 2 * y * y) * 180) / Math.PI;
  return Math.round(((d % 360) + 360) % 360);
}

function yawQuat(deg: number): [number, number, number, number] {
  const h = (deg * Math.PI) / 360;
  return [Math.cos(h), 0, Math.sin(h), 0];
}

const round = (v: number): number => Math.round(v * 10) / 10;

function flags(l: InteriorLayout, s: InteriorStrings): string {
  return [l.exterior && s.exterior, l.shop && s.shop, l.bar && s.bar, l.recruitment && s.recruitment, l.flophouse && s.flophouse].filter(Boolean).join(', ');
}

/** Поле числа: правка по Enter или при уходе с поля. */
export function NumberField({ value, onCommit, testId, width = 64 }: { value: number; onCommit: (v: number) => void; testId: string; width?: number }): ReactNode {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = (): void => {
    const v = Number(text.replace(',', '.'));
    if (Number.isFinite(v) && v !== value) onCommit(v);
    else setText(String(value));
  };
  return (
    <input
      data-testid={testId}
      value={text}
      style={{ width }}
      onChange={(e) => { setText(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setText(String(value));
      }}
    />
  );
}

function InteriorPanel({ def, params }: PanelProps): ReactNode {
  const lang = useLang();
  const s = INTERIOR_STRINGS[lang];
  const { project, go } = useWorkbench();
  const { sid } = useFollowed(def, params);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<InteriorView | undefined>(undefined);
  const [edits, setEdits] = useState<WorldEdits | undefined>();
  const [world, setWorld] = useState<WorldIndex | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [layout, setLayout] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [edit, setEdit] = useState<InteriorEditSettings>(loadEdit);
  const [message, setMessage] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [tick, setTick] = useState(0);
  const [loadingModels, setLoadingModels] = useState(0);
  const request = useStore(interiorRequest);
  /** Новый объект: выбрать, когда окно получит его со списком. */
  const pendingSelect = useRef<string | undefined>(undefined);

  const name = (id: string): string => ((lang === 'ru' ? project.ctx.localizedName(id) : undefined) ?? project.ctx.name(id)) || id;

  useEffect(() => {
    let cancelled = false;
    setEdits(undefined);
    setError(undefined);
    project.interiorEdits().then(
      (ed) => { if (!cancelled) setEdits(ed); },
      (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); },
    );
    // Мир — только для строки «где стоит»; не мешает показу.
    project.world().then((w) => { if (!cancelled) setWorld(w); }, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Окно создаётся один раз на проект.
  useEffect(() => {
    if (!host.current) return;
    const v = new InteriorView(host.current, project.bundle.game, project.ctx);
    view.current = v;
    v.onSelect = (k) => {
      setSelected(k);
      setMessage(undefined);
    };
    v.onEditChange = (e) => { setEdit(e); };
    v.onLoaded = () => { setLoadingModels(0); };
    return () => {
      view.current = undefined;
      v.dispose();
    };
  }, [project]);

  useEffect(() => {
    if (!edits) return;
    return edits.onChange(() => { setTick((t) => t + 1); });
  }, [edits]);

  const layouts = useMemo(() => (edits && sid ? interiorLayouts(edits, sid) : []), [edits, sid, tick]);

  // Раскладка: по просьбе карточки мира (имя), иначе прежняя, иначе первая внутренняя.
  useEffect(() => {
    if (layouts.length === 0) {
      setLayout(undefined);
      return;
    }
    const req = request;
    if (req && req.building === sid) {
      interiorRequest.set(undefined);
      const byName = req.layout ? layouts.find((l) => !l.exterior && l.name.toLowerCase() === req.layout!.toLowerCase()) : undefined;
      if (byName) {
        setLayout(byName.sid);
        return;
      }
    }
    setLayout((old) => (old && layouts.some((l) => l.sid === old) ? old : (layouts.find((l) => !l.exterior) ?? layouts[0]!).sid));
  }, [layouts, sid, request]);

  const current = layouts.find((l) => l.sid === layout);
  const objects = useMemo<InteriorObject[]>(() => (edits && current ? layoutObjects(edits, project.ctx, current.sid) : []), [edits, current?.sid, tick, project]);
  const usage = useMemo(() => (world && current ? layoutUsage(world, current) : undefined), [world, current?.sid]);
  const editedKeys = useMemo(() => {
    const holder = edits && current ? edits.modRecords(INTERIORS).find((r) => r.stringId === current.sid) : undefined;
    return new Set(holder ? holder.instances.keys() : []);
  }, [edits, current?.sid, tick]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    void v.setBuilding(edits && sid && layouts.length > 0 ? sid : undefined);
  }, [sid, edits, layouts.length > 0]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const items: InteriorItem[] = objects.map((o) => ({ key: o.key, target: o.target, kind: o.kind, position: [...o.position], rotation: [...o.rotation] }));
    v.sync(items);
    if (pendingSelect.current !== undefined) {
      v.select(pendingSelect.current);
      pendingSelect.current = undefined;
    }
    setLoadingModels(v.loading);
    setSelected(v.selected);
  }, [objects]);

  useEffect(() => {
    setNote(undefined);
    view.current?.select(undefined);
  }, [layout]);

  // Правки: гизмо пишет командами ядра.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.setEditable(edits !== undefined && current !== undefined);
    v.onCommit = (key, position, rotation) => {
      const o = objects.find((x) => x.key === key);
      if (!edits || !current || !o) return false;
      return run(() => {
        moveInterior(edits, project.ctx, current.sid, key, position, rotation, `${v.edit.mode === 'rotate' ? s.stepRotate : s.stepMove}: ${name(o.target)}`);
      });
    };
    v.onRemove = (key) => { remove(key); };
  }, [edits, current, objects, lang]);

  useEffect(() => {
    localStorage.setItem(EDIT_KEY, JSON.stringify(edit));
    view.current?.setEdit(edit);
  }, [edit]);

  const run = (fn: () => void): boolean => {
    try {
      fn();
      setMessage(undefined);
      return true;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const remove = (key: string): void => {
    const o = objects.find((x) => x.key === key);
    if (!edits || !current || !o) return;
    run(() => { removeInterior(edits, current.sid, key, `${s.stepRemove}: ${name(o.target)}`); });
  };

  const moveTo = (o: InteriorObject, position: [number, number, number], rotation: [number, number, number, number], rotate: boolean): void => {
    if (!edits || !current) return;
    run(() => { moveInterior(edits, project.ctx, current.sid, o.key, position, rotation, `${rotate ? s.stepRotate : s.stepMove}: ${name(o.target)}`); });
  };

  const placeRecord = (target: string): void => {
    const v = view.current;
    if (!v || !edits || !current) return;
    const at = v.centrePoint();
    const ok = run(() => {
      const r = placeInterior(edits, project.ctx, current.sid, target, at, [1, 0, 0, 0], `${s.stepPlace} «${current.name}»: ${name(target)}`);
      setNote(r.template ? `${s.copied} ${r.template}` : s.fresh);
      pendingSelect.current = r.key;
    });
    if (!ok) setNote(undefined);
  };

  const undoRedo = (redo: boolean): void => {
    if (!edits) return;
    if (redo) edits.redo();
    else edits.undo();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!edits || isTypingIn(e.target)) return;
    const k = shortcut(e);
    if (k !== 'ctrl+z' && k !== 'ctrl+y' && k !== 'ctrl+shift+z') return;
    e.preventDefault();
    e.stopPropagation();
    undoRedo(k !== 'ctrl+z');
  };

  const sel = objects.find((o) => o.key === selected);
  const kindName = (o: InteriorObject): string => s[o.kind];
  const status = !sid ? s.none : error ? `${s.failed}: ${error}` : !edits ? s.loading : layouts.length === 0 ? s.noLayouts : undefined;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      data-testid="interior-panel"
      data-building={sid ?? ''}
      data-layout={current?.sid ?? ''}
      data-objects={objects.length}
      data-loading={loadingModels}
      onKeyDownCapture={onKeyDown}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', flexWrap: 'wrap', position: 'relative' }}>
        {sid && (
          <a href="#" onClick={(e) => {
              e.preventDefault();
              go(sid);
            }} title={sid}>
            <b>{name(sid)}</b>
          </a>
        )}
        {layouts.length > 0 && (
          <label>
            {s.layout}{' '}
            <select data-testid="interior-layout" value={layout ?? ''} onChange={(e) => { setLayout(e.target.value); }}>
              {layouts.map((l) => {
                const f = flags(l, s);
                return (
                  <option key={l.sid} value={l.sid}>
                    {`${l.name}${f ? ` (${f})` : ''} — ${l.objects}`}
                  </option>
                );
              })}
            </select>
          </label>
        )}
        {current && edits && (
          <>
            <span>
              <button data-testid="interior-mode-move" className={edit.mode === 'move' ? 'small active' : 'small'} aria-pressed={edit.mode === 'move'} onClick={() => { setEdit({ ...edit, mode: 'move' }); }}>
                ✥ {s.move}
              </button>
              <button data-testid="interior-mode-rotate" className={edit.mode === 'rotate' ? 'small active' : 'small'} aria-pressed={edit.mode === 'rotate'} onClick={() => { setEdit({ ...edit, mode: 'rotate' }); }}>
                ⟳ {s.rotate}
              </button>
            </span>
            <label>
              {s.grid}{' '}
              <select data-testid="interior-grid" value={edit.grid} onChange={(e) => { setEdit({ ...edit, grid: Number(e.target.value) }); }}>
                {GRID_STEPS.map((g) => (
                  <option key={g} value={g}>
                    {g === 0 ? s.off : g}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {s.angle}{' '}
              <select data-testid="interior-angle" value={edit.angle} onChange={(e) => { setEdit({ ...edit, angle: Number(e.target.value) }); }}>
                {ANGLE_STEPS.map((a) => (
                  <option key={a} value={a}>
                    {a === 0 ? s.off : `${a}°`}
                  </option>
                ))}
              </select>
            </label>
            <button data-testid="interior-undo" disabled={!edits.canUndo()} title={`${s.undo}: ${edits.undoLabel() ?? s.nothing} (Ctrl+Z)`} onClick={() => { undoRedo(false); }}>
              ↶
            </button>
            <button data-testid="interior-redo" disabled={!edits.canRedo()} title={`${s.redo}: ${edits.redoLabel() ?? s.nothing} (Ctrl+Y)`} onClick={() => { undoRedo(true); }}>
              ↷
            </button>
            <span className="muted" data-testid="interior-last-step" style={{ fontSize: '0.85em' }}>
              {edits.undoLabel() ?? ''}
            </span>
            <PlaceBox
              project={project}
              types={PLACE_TYPES}
              testId="interior-place"
              placeholder={s.place}
              title={`${s.placeTip}. ${s.placeSearch}`}
              emptyText={s.noMatches}
              countText={(n, total) => `${n} / ${total}`}
              detail={(e) => `${e.type === 'BUILDING' ? s.furniture : s.items} · ${e.sid}`}
              onPick={placeRecord}
            />
          </>
        )}
        <span style={{ flex: 1 }} />
        {loadingModels > 0 && <span className="muted" style={{ fontSize: '0.85em' }}>{s.loadingModels}</span>}
        {current && (
          <span className="muted" style={{ fontSize: '0.85em' }}>
            {objects.length} {s.objects}
          </span>
        )}
      </div>
      {message && (
        <div className="error" data-testid="interior-message" style={{ fontSize: '0.85em', padding: '0 6px' }}>
          {message}
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div ref={host} data-testid="interior-view" data-gizmo={view.current?.gizmoProbe() ?? ''} style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
          {status && (
            <div className="muted" data-testid="interior-note" style={{ position: 'absolute', left: 0, right: 0, top: '40%', textAlign: 'center', pointerEvents: 'none' }}>
              {status}
            </div>
          )}
        </div>
        {current && (
          <div className="panel-scroll" style={{ width: 330, flexShrink: 0, padding: '6px 8px', borderLeft: '1px solid var(--border, #444)', overflow: 'auto', fontSize: '0.92em' }}>
            <div className="muted" data-testid="interior-about" style={{ marginBottom: 6 }}>
              {usage && <div data-testid="interior-usage">{s.usage(usage.named.length, usage.unnamed.length, usage.total)}</div>}
              <div>{s.shared}</div>
              <div>{s.notIn}</div>
            </div>
            {note && (
              <div className="muted" data-testid="interior-place-note" style={{ marginBottom: 6 }}>
                ✎ {note}
              </div>
            )}
            {sel && (
              <div data-testid="interior-card" data-key={sel.key} data-target={sel.target} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                  <b style={{ flex: 1 }}>{s.object}</b>
                  <button onClick={() => view.current?.focus(sel.key)}>{s.focus}</button>
                  {edits && (
                    <button data-testid="interior-remove" onClick={() => { remove(sel.key); }}>
                      {s.remove}
                    </button>
                  )}
                </div>
                {editedKeys.has(sel.key) && (
                  <div className="muted" data-testid="interior-card-edited" style={{ fontSize: '0.85em', marginBottom: 4 }}>
                    ✎ {s.edited}
                  </div>
                )}
                <table style={{ borderSpacing: '6px 2px' }}>
                  <tbody>
                    <tr>
                      <td className="muted">{s.record}</td>
                      <td>
                        <a href="#" onClick={(e) => {
                            e.preventDefault();
                            go(sel.target);
                          }} title={sel.target}>
                          {name(sel.target)}
                        </a>
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">{s.kind}</td>
                      <td>{kindName(sel)}</td>
                    </tr>
                    <tr>
                      <td className="muted">{s.where}</td>
                      <td>
                        {([0, 1, 2] as const).map((i) => (
                          <NumberField
                            key={i}
                            testId={`interior-pos-${'xyz'[i]}`}
                            width={58}
                            value={round(sel.position[i])}
                            onCommit={(v) => {
                              const p: [number, number, number] = [...sel.position];
                              p[i] = v;
                              moveTo(sel, p, [...sel.rotation], false);
                            }}
                          />
                        ))}
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">{s.turn}</td>
                      <td>
                        <NumberField testId="interior-yaw" value={yawDeg(sel.rotation)} onCommit={(v) => { moveTo(sel, [...sel.position], yawQuat(v), true); }} />°
                      </td>
                    </tr>
                    {sel.floor !== undefined && (
                      <tr>
                        <td className="muted">{s.floor}</td>
                        <td data-testid="interior-floor">{sel.floor}</td>
                      </tr>
                    )}
                    {sel.locked !== undefined && (
                      <tr>
                        <td className="muted">{s.lock}</td>
                        <td>{sel.locked ? `${s.locked}${sel.lockLevel !== undefined ? `, ${s.level} ${sel.lockLevel}` : ''}` : '—'}</td>
                      </tr>
                    )}
                    {sel.items && (
                      <tr>
                        <td className="muted">{s.contents}</td>
                        <td>
                          <a href="#" onClick={(e) => {
                              e.preventDefault();
                              go(sel.items!);
                            }} title={sel.items}>
                            {name(sel.items)}
                          </a>
                        </td>
                      </tr>
                    )}
                    <tr>
                      <td className="muted">{s.key}</td>
                      <td className="mono">{sel.key}</td>
                    </tr>
                    {sel.state && (
                      <tr>
                        <td className="muted">{s.state}</td>
                        <td className="mono">{sel.state}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            <div data-testid="interior-list">
              {objects.map((o) => (
                <div
                  key={o.key}
                  className={o.key === selected ? 'menu-item active' : 'menu-item'}
                  data-key={o.key}
                  style={{ cursor: 'pointer', padding: '1px 4px', background: o.key === selected ? 'var(--selection, #2f4f6f)' : undefined }}
                  onClick={() => {
                    view.current?.select(o.key);
                    view.current?.focus(o.key);
                  }}
                >
                  {editedKeys.has(o.key) ? '✎ ' : ''}
                  {name(o.target)}{' '}
                  <span className="muted">
                    · {kindName(o)}
                    {o.floor !== undefined ? ` · ${s.floor.toLowerCase()} ${o.floor}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="muted" style={{ padding: '2px 6px', fontSize: '0.8em' }}>
        {s.help}
      </div>
    </div>
  );
}

registerPanel({
  id: 'interior',
  title: (t) => INTERIOR_STRINGS[langOf(t)].panel,
  hint: (t) => INTERIOR_STRINGS[langOf(t)].hint,
  icon: '⌂',
  component: InteriorPanel,
  area: 'center',
  shows: { kinds: ['record'], types: ['BUILDING'] },
  order: 99,
});
