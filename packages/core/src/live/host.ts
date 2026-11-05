/**
 * Сторона редактора в живой связи: выполняет запросы MCP над открытым модом. Правки ИИ
 * применяются сразу одной правкой истории (видны в окне, отменяются Ctrl+Z) и попадают в
 * список наборов изменений: пользователь их смотрит, принимает или откатывает.
 */
import { writeDataFile } from '../format/write.ts';
import type { ModContext } from '../model/context.ts';
import { EditError } from '../model/context.ts';
import type { RecordDiff } from '../model/diff.ts';
import { applyOps, type EditOp } from '../model/ops.ts';
import { changesetDiff, formatRecordDiff } from '../model/present.ts';
import { bytesToBase64, type AiChangeset, type LiveRequestBody, type LiveSnapshot, type LiveState, type ProposeResult } from './protocol.ts';

/** Что открыто в окне. */
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

  /** Наборы изменений ИИ (новые — в конце). */
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

  /** Открыт другой мод — прежние наборы больше не относятся к нему. */
  reset(): void {
    this.list = [];
    this.emit();
  }

  private open(): LiveSource {
    const s = this.source();
    if (!s) throw new EditError('В редакторе не открыт мод');
    return s;
  }

  /** Отметить наборы, отменённые в окне через Ctrl+Z (их больше нет в истории). */
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

  /** Выполнить запрос MCP; ошибка — исключение с понятным текстом. */
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
    if (ops.length === 0) throw new EditError('Пустой набор правок');
    const before = ctx.history().undo.at(-1)?.id;
    const res = applyOps(ctx, ops, `ИИ: ${title}`);
    const cs = ctx.history().undo.at(-1);
    if (!cs || cs.id === before) throw new EditError('Правки ничего не изменили');
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

  /** Откатить набор (новой правкой; если записи меняли позже — ошибка). */
  rollback(id: number): void {
    const c = this.find(id);
    const { ctx } = this.open();
    ctx.rollbackChangeset(id);
    c.status = 'rolled-back';
    this.emit();
  }

  private find(id: number): HostedChangeset {
    const c = this.list.find((x) => x.id === id);
    if (!c) throw new EditError(`Нет набора изменений ${id}`);
    return c;
  }
}

function wire(c: HostedChangeset): AiChangeset {
  return { id: c.id, title: c.title, status: c.status, touched: [...c.touched], created: [...c.created], summary: [...c.summary], at: c.at };
}
