/**
 * Дерево категорий из fcs_layout.def (как в FCS) с числом записей в каждом узле, плюс
 * псевдо-узел «Изменения мода» и «Прочие типы» для типов, которых в дереве нет.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { OTHER_TYPES_ID, type CategoryNode } from '@kenshi-editor/core';
import { useT } from '../i18n.ts';
import { MOD_CHANGES_ID, type Project } from '../project.ts';

interface Props {
  project: Project;
  version: number;
  selected: string;
  onSelect: (id: string) => void;
  modCount: number;
}

export function CategoryTree({ project, version, selected, onSelect, modCount }: Props): ReactNode {
  const t = useT();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    const walk = (n: CategoryNode): void => {
      m.set(n.id, project.idsForNode(n).length);
      n.children.forEach(walk);
    };
    project.tree.forEach(walk);
    return m;
  }, [project, version]);

  const toggle = (id: string): void => {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const label = (n: CategoryNode): string => {
    if (n.id === OTHER_TYPES_ID) return t.otherTypes;
    if (n.type === undefined) return t.everything;
    return n.label;
  };

  const renderNode = (n: CategoryNode, depth: number): ReactNode => {
    const isOpen = open.has(n.id);
    const count = counts.get(n.id) ?? 0;
    return (
      <li key={n.id}>
        <div
          className={`tree-row ${selected === n.id ? 'selected' : ''} ${count === 0 ? 'muted' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          data-testid={`cat-${n.id}`}
          title={n.type !== undefined ? `${n.type}${n.filters.length ? ` · ${n.filters.map((f) => `${f.field}${f.op}${f.value}`).join(', ')}` : ''}` : undefined}
          onClick={() => {
            onSelect(n.id);
          }}
        >
          {n.children.length > 0 ? (
            <span
              className="twisty"
              onClick={(e) => {
                e.stopPropagation();
                toggle(n.id);
              }}
            >
              {isOpen ? '▾' : '▸'}
            </span>
          ) : (
            <span className="twisty" />
          )}
          <span className="tree-label">{label(n)}</span>
          <span className="count">{count}</span>
        </div>
        {isOpen && n.children.length > 0 && <ul>{n.children.map((c) => renderNode(c, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <div className="tree-pane" data-testid="category-tree">
      <div className="pane-title">{t.categories}</div>
      <ul className="tree">
        <li>
          <div
            className={`tree-row mod-changes ${selected === MOD_CHANGES_ID ? 'selected' : ''}`}
            data-testid="cat-mod"
            onClick={() => {
              onSelect(MOD_CHANGES_ID);
            }}
          >
            <span className="twisty">★</span>
            <span className="tree-label">{t.modChanges}</span>
            <span className="count">{modCount}</span>
          </div>
        </li>
        {project.tree.map((n) => renderNode(n, 0))}
      </ul>
    </div>
  );
}
