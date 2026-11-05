/** Категории дерева: поиск узла и категория при открытии проекта. */
import { OTHER_TYPES_ID, type CategoryNode } from '@kenshi-editor/core';
import { MOD_CHANGES_ID, type Project } from '../project.ts';

export function findNode(nodes: readonly CategoryNode[], id: string): CategoryNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = findNode(n.children, id);
    if (c) return c;
  }
  return undefined;
}

/** Категория при открытии: изменения мода, если они есть, иначе «Все». */
export function initialCategory(project: Project): string {
  const everythingId = project.tree.find((n) => n.type === undefined && n.id !== OTHER_TYPES_ID)?.id ?? MOD_CHANGES_ID;
  return project.ctx.modRecords().length > 0 ? MOD_CHANGES_ID : everythingId;
}
