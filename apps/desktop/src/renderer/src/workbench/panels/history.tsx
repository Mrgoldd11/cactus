/** Панель «История»: все шаги правки, где вы сейчас, переход к любому шагу щелчком. */
import type { ReactNode } from 'react';
import { HistoryList } from '../../components/History.tsx';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';

function HistoryPanel(): ReactNode {
  const { project, status } = useWorkbench();
  return <HistoryList project={project} status={status} />;
}

registerPanel({
  id: 'history', group: 'mod',
  title: (t) => t.panel_history,
  icon: '↶',
  component: HistoryPanel,
  area: 'right',
  order: 85,
  hint: (t) => t.histHint,
});
