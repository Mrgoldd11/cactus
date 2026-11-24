/**
 * Editor side of the live link: runs MCP requests on the open mod. AI edits
 * are applied at once as one history edit (visible in the window, undone with Ctrl+Z) and go into
 * the list of change sets: the user reviews, accepts or rolls them back.
 */
import { writeDataFile } from '../format/write.ts';
import type { ModContext } from '../model/context.ts';
import { EditError } from '../model/context.ts';
import type { RecordDiff } from '../model/diff.ts';
import { applyOps, type EditOp } from '../model/ops.ts';
import { changesetDiff, formatRecordDiff } from '../model/present.ts';
import { bytesToBase64, type AiChangeset, type LiveRequestBody, type LiveSnapshot, type LiveState, type ProposeResult } from './protocol.ts';

/** What is open in the window. */
export interface LiveSource {
  ctx: ModContext;
  version: number;
  session: number;
  modPath?: string;
  game?: string;
  dependencies: { name: string; path: string }[];
}

export interface HostedChangeset extends AiChangeset {
  diffs: RecordDiff[];
}

export class LiveHost {
  private readonly source: () => LiveSource | undefined;
  private list: HostedChangeset[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(source: () => LiveSource | undefined) {
    this.source = source;
  }

  /** AI change sets (new ones at the end). */
  get changesets(): readonly HostedChangeset[] {
    return this.list;
  }

  get pending(): number {
    return this.list.filter((c) => c.status === 'pending').length;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Another mod was opened: the previous sets no longer belong to it. */
  reset(): void {
    this.list = [];
    this.emit();
  }

  private open(): LiveSource {
    const s = this.source();
    if (!s) throw new EditError({ en: 'No mod is open in the editor', ru: 'В редакторе не открыт мод', zh: '编辑器中没有打开的 Mod' });
    return s;
  }

  /** Mark sets undone in the window with Ctrl+Z (they are no longer in the history). */
  private refresh(ctx: ModContext): void {
    let changed = false;
    for (const c of this.list) {
      if ((c.status === 'pending' || c.status === 'accepted') && !ctx.findChangeset(c.id)) {
        c.status = 'undone';
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  state(): LiveState {
    const s = this.open();
    return {
      version: s.version,
      session: s.session,
      modName: s.ctx.modName,
      ...(s.modPath !== undefined ? { modPath: s.modPath } : {}),
      ...(s.game !== undefined ? { game: s.game } : {}),
      dependencies: s.dependencies,
      dirty: s.ctx.dirty,
    };
  }

  /** Run an MCP request; an error is an exception with a readable text. */
  handle(req: LiveRequestBody): unknown {
    switch (req.method) {
      case 'hello':
        return { ok: true };
      case 'state':
        return this.state();
      case 'snapshot': {
        const s = this.open();
        const snap: LiveSnapshot = { ...this.state(), mod: bytesToBase64(writeDataFile(s.ctx.buildModFile())) };
        return snap;
      }
      case 'propose':
        return this.propose(req.title, req.ops);
      case 'changesets': {
        const s = this.source();
        if (s) this.refresh(s.ctx);
        return this.list.map(wire);
      }
    }
  }

  propose(title: string, ops: readonly EditOp[]): ProposeResult {
    const { ctx } = this.open();
    if (ops.length === 0) throw new EditError({ en: 'Empty set of edits', ru: 'Пустой набор правок', zh: '修改集为空' });
    const before = ctx.history().undo.at(-1)?.id;
    const res = applyOps(ctx, ops, `ИИ: ${title}`);
    const cs = ctx.history().undo.at(-1);
    if (!cs || cs.id === before) throw new EditError({ en: 'The edits changed nothing', ru: 'Правки ничего не изменили', zh: '这些修改没有改变任何内容' });
    const diffs = changesetDiff(ctx, cs);
    const hosted: HostedChangeset = {
      id: cs.id,
      title,
      status: 'pending',
      touched: res.touched,
      created: res.created,
      summary: diffs.flatMap((d) => formatRecordDiff(ctx, d)),
      at: Date.now(),
      diffs,
    };
    this.list.push(hosted);
    this.emit();
    return { changeset: wire(hosted), aliases: res.aliases };
  }

  accept(id: number): void {
    const c = this.find(id);
    if (c.status !== 'pending') return;
    c.status = 'accepted';
    this.emit();
  }

  /** Roll back a set (with a new edit; an error if the records were changed later). */
  rollback(id: number): void {
    const c = this.find(id);
    const { ctx } = this.open();
    ctx.rollbackChangeset(id);
    c.status = 'rolled-back';
    this.emit();
  }

  private find(id: number): HostedChangeset {
    const c = this.list.find((x) => x.id === id);
    if (!c) throw new EditError({ en: `No change set ${id}`, ru: `Нет набора изменений ${id}`, zh: `没有修改集 ${id}` });
    return c;
  }
}

function wire(c: HostedChangeset): AiChangeset {
  return { id: c.id, title: c.title, status: c.status, touched: [...c.touched], created: [...c.created], summary: [...c.summary], at: c.at };
}
