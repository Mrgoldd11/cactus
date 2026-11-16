/**
 * Заготовка этапа 7 (3D-вид): панель «Вид сцены» (тип viewport) и инспектор компонентов.
 * Объекты сцены выбираются через общий сервис выбора как `{ kind: 'scene', id, sid }`.
 */
import type { ReactNode } from 'react';
import { decodeText } from '@kenshi-editor/core';
import { useT } from '../../i18n.ts';
import { registerPanel, type PanelProps } from '../registry.ts';
import { useFollowed, useWorkbench } from '../context.ts';

function ViewportPanel(): ReactNode {
  const t = useT();
  return (
    <div className="viewport-stub" data-testid="viewport">
      <div className="viewport-grid" />
      <div className="viewport-note">
        <b>{t.placeholderSoon}</b>
        <p>{t.viewportStub}</p>
      </div>
    </div>
  );
}

function ComponentsPanel({ def, params }: PanelProps): ReactNode {
  const t = useT();
  const { project } = useWorkbench();
  const { sid, item } = useFollowed(def, params);
  const rec = sid === undefined ? undefined : project.record(sid);
  return (
    <div className="panel-scroll components-stub">
      <p className="muted">{t.componentsStub}</p>
      {item?.kind === 'scene' && <div className="mono">{item.id}</div>}
      {rec && (
        <div>
          <b>{decodeText(rec.name)}</b> <span className="badge">{project.ctx.typeName(rec.type)}</span>
        </div>
      )}
    </div>
  );
}

registerPanel({ id: 'viewport', group: 'scene', title: (t) => t.panel_viewport, icon: '◫', component: ViewportPanel, area: 'center', order: 100, placeholder: true });
registerPanel({
  id: 'components', group: 'scene',
  title: (t) => t.panel_components,
  icon: '⚙',
  component: ComponentsPanel,
  area: 'right',
  shows: { kinds: ['scene', 'record'] },
  order: 110,
  placeholder: true,
});
