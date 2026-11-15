/**
 * Рабочее пространство на dockview: панели из реестра, стыковка, вкладки, плавающие группы,
 * «во всё окно», сворачивание, закрепление панели на записи. Раскладка сохраняется в
 * настройках и восстанавливается при следующем запуске.
 */
import { Component, useEffect, useRef, type ErrorInfo, type FunctionComponent, type ReactNode } from 'react';
import {
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { decodeText } from '@kenshi-editor/core';
import type { WorkspaceSettings } from '../../../shared/api.ts';
import { useT } from '../i18n.ts';
import { useProjectVersion } from '../hooks.ts';
import { allPanels, panelDef, type PanelDef, type PanelParams } from './registry.ts';
import { accepts, useWorkbench, WorkbenchContext, type Workbench as WorkbenchValue } from './context.ts';
import { useSelectionVersion } from './selection.ts';
import { applyPreset, layoutKnown, panelTitle, type PresetId } from './layouts.ts';

// Все панели регистрируются сами при загрузке своих файлов: оболочка их не перечисляет.
import.meta.glob('./panels/*.tsx', { eager: true });

const SAVE_DELAY_MS = 300;

class PanelBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(e: unknown): { error: string } {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  override componentDidCatch(e: unknown, info: ErrorInfo): void {
    console.error(e, info.componentStack);
  }
  override render(): ReactNode {
    if (this.state.error !== undefined) return <div className="panel-empty error">{this.state.error}</div>;
    return this.props.children;
  }
}

/** Рамка панели: заголовок вкладки (с именем закреплённой записи), граница ошибок. */
function makeFrame(def: PanelDef): FunctionComponent<IDockviewPanelProps<PanelParams>> {
  const Inner = def.component;
  function Frame({ params, api }: IDockviewPanelProps<PanelParams>): ReactNode {
    const t = useT();
    const { project } = useWorkbench();
    useProjectVersion(project);
    const p = params;
    const rec = p.sid === undefined ? undefined : project.record(p.sid);
    const name = p.sid === undefined ? undefined : (project.ctx.localizedName(p.sid) ?? (rec ? decodeText(rec.name) : p.sid));
    const title = panelTitle(def, t, name);
    useEffect(() => {
      if (api.title !== title) api.setTitle(title);
    }, [api, title]);
    return (
      <div className="panel-body" data-panel={def.id}>
        <PanelBoundary>
          <Inner def={def} params={p} api={api} />
        </PanelBoundary>
      </div>
    );
  }
  Frame.displayName = `Panel(${def.id})`;
  return Frame;
}

let frames: Record<string, FunctionComponent<IDockviewPanelProps<PanelParams>>> | undefined;
function components(): Record<string, FunctionComponent<IDockviewPanelProps<PanelParams>>> {
  frames ??= Object.fromEntries(allPanels().map((d) => [d.id, makeFrame(d)]));
  return frames;
}

const HEADER_HEIGHT = 35;
const collapsedHeights = new WeakMap<DockviewGroupPanel, number>();

function toggleCollapse(group: DockviewGroupPanel): void {
  const prev = collapsedHeights.get(group);
  if (prev !== undefined) {
    collapsedHeights.delete(group);
    group.api.setConstraints({ minimumHeight: 100, maximumHeight: Number.MAX_SAFE_INTEGER });
    group.api.setSize({ height: prev });
    group.element.classList.remove('kedit-collapsed');
  } else {
    const h = group.api.height;
    group.api.setConstraints({ minimumHeight: HEADER_HEIGHT, maximumHeight: HEADER_HEIGHT });
    group.api.setSize({ height: HEADER_HEIGHT });
    // Нет соседа сверху/снизу — свернуть некуда.
    if (group.api.height >= h) {
      group.api.setConstraints({ minimumHeight: 100, maximumHeight: Number.MAX_SAFE_INTEGER });
      return;
    }
    collapsedHeights.set(group, h);
    group.element.classList.add('kedit-collapsed');
  }
}

/** Кнопки справа в заголовке группы: закрепить на записи, свернуть, во всё окно. */
function HeaderActions({ activePanel, group, containerApi }: IDockviewHeaderActionsProps): ReactNode {
  const t = useT();
  const wb = useWorkbench();
  useSelectionVersion(wb.selection);
  const def = activePanel ? panelDef(activePanel.api.component) : undefined;
  const params = (activePanel?.params ?? {}) as PanelParams;
  const followed = def?.shows && params.sid === undefined ? wb.selection.latest((s) => accepts(wb.project, def, s)) : undefined;
  const followedSid = followed === undefined ? undefined : followed.kind === 'scene' ? followed.sid : followed.sid;
  const pin = (): void => {
    if (!def || !activePanel) return;
    if (params.sid !== undefined) {
      if (def.multi) {
        activePanel.api.close();
        wb.open(def.id);
      } else activePanel.api.updateParameters({});
    } else if (followedSid !== undefined) {
      if (def.multi) wb.open(def.id, { sid: followedSid });
      else activePanel.api.updateParameters({ sid: followedSid });
    }
  };
  const maximized = group.api.isMaximized();
  return (
    <div className="dv-actions">
      {def?.shows && (params.sid !== undefined || followedSid !== undefined) && (
        <button className={`dv-action${params.sid !== undefined ? ' on' : ''}`} data-testid="panel-pin" title={params.sid !== undefined ? t.unpinPanel : t.pinPanel} onClick={pin}>
          📌
        </button>
      )}
      {group.api.location.type === 'grid' && (
        <>
          <button
            className="dv-action"
            title={t.collapseGroup}
            onClick={() => {
              toggleCollapse(group);
            }}
          >
            ▁
          </button>
          <button
            className={`dv-action${maximized ? ' on' : ''}`}
            title={t.maximizeGroup}
            onClick={() => {
              if (maximized) containerApi.exitMaximizedGroup();
              else group.api.maximize();
            }}
          >
            ⤢
          </button>
        </>
      )}
    </div>
  );
}

interface Props {
  wb: WorkbenchValue;
  /** Сохранённая раскладка (из настроек) или пусто — тогда ставится `preset`. */
  initial: WorkspaceSettings | undefined;
  preset: PresetId;
  onApi: (api: DockviewApi) => void;
  /** Раскладка изменилась (для меню «Окно»). */
  onChange: () => void;
}

export function Workbench({ wb, initial, preset, onApi, onChange }: Props): ReactNode {
  const t = useT();
  const presetRef = useRef(preset);
  presetRef.current = preset;
  const tRef = useRef(t);
  tRef.current = t;
  const disposers = useRef<(() => void)[]>([]);

  useEffect(
    () => () => {
      for (const d of disposers.current) d();
      disposers.current = [];
    },
    [],
  );

  const onReady = (e: DockviewReadyEvent): void => {
    const api = e.api;
    let restored = false;
    if (initial?.layout !== undefined && layoutKnown(initial.layout)) {
      try {
        api.fromJSON(initial.layout as Parameters<DockviewApi['fromJSON']>[0]);
        restored = api.panels.length > 0;
      } catch (err) {
        console.warn('Раскладку не восстановить, ставлю по умолчанию', err);
      }
    }
    if (!restored) applyPreset(api, presetRef.current, tRef.current);
    onApi(api);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = (): void => {
      timer = undefined;
      void window.kedit.setSettings({ workspace: { layout: api.toJSON(), preset: presetRef.current } });
    };
    const sub = api.onDidLayoutChange(() => {
      onChange();
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(save, SAVE_DELAY_MS);
    });
    disposers.current.push(() => {
      sub.dispose();
      if (timer !== undefined) {
        clearTimeout(timer);
        save();
      }
    });
  };

  return (
    <WorkbenchContext.Provider value={wb}>
      <div className="workbench" data-testid="workbench">
        <DockviewReact
          components={components()}
          onReady={onReady}
          theme={themeAbyss}
          rightHeaderActionsComponent={HeaderActions}
          getTabContextMenuItems={() => ['close', 'closeOthers', 'separator', 'maximize', 'float']}
        />
      </div>
    </WorkbenchContext.Provider>
  );
}
