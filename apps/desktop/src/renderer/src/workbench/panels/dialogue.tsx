/**
 * Панели диалогов: граф диалога, проигрыватель разговора.
 */
import type { ReactNode } from 'react';
import { DialogueGraphTab } from '../../components/DialogueGraphTab.tsx';
import { TalkTab } from '../../components/TalkTab.tsx';
import { registerPanel, type PanelProps } from '../registry.ts';
import { useFollowed, useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

function GraphPanel({ def, params }: PanelProps): ReactNode {
  const { project, go } = useWorkbench();
  const { sid, version } = useFollowed(def, params);
  if (sid === undefined) return <Empty />;
  return <DialogueGraphTab key={sid} project={project} sid={sid} version={version} onGo={go} />;
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
  id: 'player',
  title: (t) => t.panel_player,
  icon: '▶',
  component: PlayerPanel,
  area: 'bottom',
  shows: { kinds: ['record'], types: ['CHARACTER'] },
  multi: true,
  order: 60,
});
