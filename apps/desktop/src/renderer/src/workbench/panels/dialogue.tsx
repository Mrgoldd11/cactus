/**
 * Панели диалогов: граф диалога (с правкой), инспектор реплики, проигрыватель разговора.
 * Реплики, выбранные в графе или инспекторе, — выбор вида «line»: граф за ними не прыгает,
 * инспектор реплики показывает последнюю.
 */
import type { ReactNode } from 'react';
import { DialogueGraphTab } from '../../components/DialogueGraphTab.tsx';
import { LineInspector } from '../../components/LineInspector.tsx';
import { TalkTab } from '../../components/TalkTab.tsx';
import { registerPanel, type PanelProps } from '../registry.ts';
import { useFollowed, useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Выбрать реплику (без истории «назад/вперёд»: это шаги внутри диалога). */
function useSelectLine(dialog: string | undefined): (sid: string, parent?: string) => void {
  const { selection } = useWorkbench();
  return (sid, parent) => {
    selection.select({ kind: 'line', sid, ...(dialog !== undefined ? { dialog } : {}), ...(parent !== undefined ? { parent } : {}) }, { history: false });
  };
}

function GraphPanel({ def, params }: PanelProps): ReactNode {
  const { project, go, report, selection } = useWorkbench();
  const { sid, version } = useFollowed(def, params);
  const select = useSelectLine(sid);
  if (sid === undefined) return <Empty />;
  const line = selection.latest((s) => s.kind === 'line');
  return <DialogueGraphTab key={sid} project={project} sid={sid} version={version} onGo={go} selected={line?.kind === 'line' ? line.sid : undefined} onSelect={select} onReport={report} />;
}

function LinePanel({ def, params }: PanelProps): ReactNode {
  const { project, go, report } = useWorkbench();
  const { sid, item, version } = useFollowed(def, params);
  const dialog = item?.kind === 'line' ? item.dialog : undefined;
  const select = useSelectLine(dialog);
  if (sid === undefined || !project.record(sid)) return <Empty />;
  const parent = item?.kind === 'line' ? item.parent : undefined;
  return <LineInspector project={project} sid={sid} {...(parent !== undefined ? { parent } : {})} version={version} onGo={go} onSelect={select} onReport={report} />;
}

function PlayerPanel({ def, params }: PanelProps): ReactNode {
  const { project, go } = useWorkbench();
  const { sid, version } = useFollowed(def, params);
  if (sid === undefined) return <Empty />;
  return (
    <div className="panel-scroll">
      <TalkTab project={project} sid={sid} version={version} onGo={go} />
    </div>
  );
}

registerPanel({
  id: 'graph',
  title: (t) => t.panel_graph,
  icon: '⑂',
  component: GraphPanel,
  area: 'center',
  // Реплики из самого графа выбираются как «line» — граф за ними не прыгает.
  shows: { kinds: ['record'], types: ['DIALOGUE_PACKAGE', 'DIALOGUE', 'DIALOGUE_LINE'] },
  multi: true,
  order: 40,
});
registerPanel({
  id: 'line',
  title: (t) => t.panel_line,
  icon: '❝',
  component: LinePanel,
  area: 'right',
  shows: { kinds: ['line', 'record'], types: ['DIALOGUE', 'DIALOGUE_LINE'] },
  multi: true,
  order: 45,
});
registerPanel({
  id: 'player',
  title: (t) => t.panel_player,
  icon: '▶',
  component: PlayerPanel,
  area: 'bottom',
  shows: { kinds: ['record'], types: ['CHARACTER'] },
  multi: true,
  order: 60,
});
