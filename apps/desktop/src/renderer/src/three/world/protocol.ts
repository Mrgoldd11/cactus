/** Messages between the «World» view and its background threads (`worker.ts`). */

export interface SubmeshArrays {
  index: Uint32Array | Uint16Array;
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  colors?: Float32Array;
}

export type WorkerRequest =
  | { id: number; type: 'terrain'; heights: Uint16Array; size: number; uv: [number, number, number, number] }
  | { id: number; type: 'mesh'; bytes: Uint8Array }
  | { id: number; type: 'dds'; bytes: Uint8Array; maxSize: number }
  | { id: number; type: 'png'; bytes: Uint8Array; size: number };

export type WorkerReply =
  | { id: number; type: 'terrain'; pos: Float32Array; nor: Float32Array; uvs: Float32Array; min: number; max: number }
  | { id: number; type: 'mesh'; submeshes: SubmeshArrays[] }
  | { id: number; type: 'dds'; width: number; height: number; rgba: Uint8Array }
  | { id: number; type: 'png'; width: number; height: number; rgba: Uint8Array }
  | { id: number; type: 'error'; message: string };

export type ReplyOf<K extends WorkerRequest['type']> = Extract<WorkerReply, { type: K }>;

/** Background thread pool: request — promise of the answer (round robin between threads). */
export class WorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, { resolve: (r: WorkerReply) => void; reject: (e: Error) => void }>();
  private next = 1;
  private turn = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: `world-${i}` });
      w.onmessage = (e: MessageEvent<WorkerReply>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.type === 'error') p.reject(new Error(e.data.message));
        else p.resolve(e.data);
      };
      this.workers.push(w);
    }
  }

  run<K extends WorkerRequest['type']>(req: Omit<Extract<WorkerRequest, { type: K }>, 'id'>, transfer: Transferable[] = []): Promise<ReplyOf<K>> {
    const id = this.next++;
    const w = this.workers[this.turn++ % this.workers.length]!;
    return new Promise<ReplyOf<K>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: WorkerReply) => void, reject });
      w.postMessage({ ...req, id }, transfer);
    });
  }

  get busy(): number {
    return this.pending.size;
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(new Error('closed'));
    this.pending.clear();
  }
}
