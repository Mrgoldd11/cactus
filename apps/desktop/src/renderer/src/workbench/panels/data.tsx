/**
 * Data panels: categories, record list, record inspector, «Where in game», diagnostics,
 * AI changes. Each is one `registerPanel` call.
 */
import { useMemo, type ReactNode } from 'react';
import { useT } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { MOD_CHANGES_ID } from '../../project.ts';
import { findNode } from '../category.ts';
import { useAiChangesets, useLiveStatus } from '../../live.ts';
import { CategoryTree } from '../../components/CategoryTree.tsx';
import { RecordList } from '../../components/RecordList.tsx';
import { RecordEditor } from '../../components/RecordEditor.tsx';
import { WhereTab } from '../../components/WhereTab.tsx';
import { AiPanel } from '../../components/AiPanel.tsx';
import { IssueFixer } from '../../components/IssueFixer.tsx';
import { registerPanel, type PanelProps } from '../registry.ts';
import { useFollowed, useWorkbench } from '../context.ts';
import { useSelectionVersion } from '../selection.ts';
import { useStore } from '../store.ts';
import { bulkScope } from '../bulk-scope.ts';
import { addAnimsRace } from '../anim-requests.ts';
import { Empty } from './common.tsx';

function CategoriesPanel(): ReactNode {
  const { project, category } = useWorkbench();
  const version = useProjectVersion(project);
  const nodeId = useStore(category);
  const modCount = useMemo(() => project.ctx.modRecords().length, [project, version]);
  return (
    <CategoryTree
      project={project}
      version={version}
      selected={nodeId}
      onSelect={(id) => {
        category.set(id);
      }}
      modCount={modCount}
    />
  );
}

function RecordsPanel(): ReactNode {
  const { project, category, selection, go, report, newRecord, newRace, searchRef, open } = useWorkbench();
  const version = useProjectVersion(project);
  useSelectionVersion(selection);
  const nodeId = useStore(category);
  const node = nodeId === MOD_CHANGES_ID ? undefined : findNode(project.tree, nodeId);
  const ids = useMemo(() => project.idsForNode(node ?? MOD_CHANGES_ID), [project, node, version]);
  const sel = selection.latest((s) => s.kind === 'record');
  return (
    <RecordList
      project={project}
      version={version}
      ids={ids}
      selected={sel?.kind === 'record' ? sel.sid : undefined}
      onSelect={go}
      searchRef={searchRef}
      onNew={newRecord}
      onDuplicate={(sid) => {
        report(
          tryEdit(() => {
            go(project.ctx.duplicateRecord(sid));
          }),
        );
      }}
      onReport={report}
      onBulk={(sids) => {
        bulkScope.set({ ids: sids, stamp: Date.now() });
        open('bulk');
      }}
      onNewRace={node?.type === 'RACE' ? newRace : undefined}
      onAddAnims={
        node?.type === 'RACE'
          ? (race) => {
              if (race !== undefined) addAnimsRace.set({ race, stamp: Date.now() });
              open('add-anims');
            }
          : undefined
      }
    />
  );
}

function InspectorPanel({ def, params }: PanelProps): ReactNode {
  const { project, go, report } = useWorkbench();
  const { sid, version } = useFollowed(def, params);
  const t = useT();
  if (sid === undefined) return <div className="record-editor empty muted">{t.noSelection}</div>;
  return <RecordEditor key="editor" project={project} version={version} sid={sid} onGo={go} onReport={report} />;
}

function WherePanel({ def, params }: PanelProps): ReactNode {
  const { project, go, report } = useWorkbench();
  const { sid, version } = useFollowed(def, params);
  if (sid === undefined || !project.record(sid)) return <Empty />;
  return (
    <div className="panel-scroll">
      <WhereTab project={project} sid={sid} version={version} onGo={go} onReport={report} />
    </div>
  );
}

function DiagnosticsPanel(): ReactNode {
  const { project, go, report } = useWorkbench();
  return (
    <div className="panel-scroll panel-pad" data-testid="diagnostics">
      <IssueFixer project={project} onGo={go} onReport={report} />
    </div>
  );
}

function AiChangesPanel(): ReactNode {
  const { project, go, report } = useWorkbench();
  const changesets = useAiChangesets();
  const status = useLiveStatus();
  return (
    <AiPanel
      project={project}
      changesets={changesets}
      status={status}
      onGo={go}
      onReport={report}
    />
  );
}

registerPanel({ id: 'categories', group: 'data', title: (t) => t.panel_categories, icon: '☰', component: CategoriesPanel, area: 'left', order: 10 });
registerPanel({ id: 'records', group: 'data', title: (t) => t.panel_records, icon: '▤', component: RecordsPanel, area: 'left', order: 20 });
registerPanel({
  id: 'inspector', group: 'data',
  title: (t) => t.panel_inspector,
  icon: 'ⓘ',
  component: InspectorPanel,
  area: 'center',
  shows: { kinds: ['record', 'line', 'scene'] },
  multi: true,
  order: 30,
});
registerPanel({ id: 'where', group: 'data', title: (t) => t.panel_where, icon: '⌖', component: WherePanel, area: 'right', shows: { kinds: ['record', 'line'] }, multi: true, order: 70 });
registerPanel({ id: 'diagnostics', group: 'mod', title: (t) => t.panel_diagnostics, icon: '⚠', component: DiagnosticsPanel, area: 'bottom', order: 80 });
registerPanel({ id: 'ai', group: 'mod', title: (t) => t.panel_ai, icon: '✦', component: AiChangesPanel, area: 'right', order: 90 });
