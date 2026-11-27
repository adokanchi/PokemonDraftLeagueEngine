/**
 * A pool of worker threads for the turn search. Each search sends its determinizations to every
 * worker once (each rebuilds the battles itself), then batches of cells are shared out to
 * whichever workers are free.
 *
 *   const pool = await SearchPool.start();          // one worker per spare CPU thread
 *   const res = await solveTurnParallel(input, pool);
 *   await pool.close();
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { SideIndex } from '../sim/battle.js';
import type { Cell, CellRunner, Determinization } from './solver.js';

interface Job { cells: Cell[]; resolve: (v: number[]) => void; reject: (e: Error) => void }

/** Default worker count: all hardware threads but one (left for this thread and the system). */
export function defaultThreads(): number {
	return Math.max(1, availableParallelism() - 1);
}

export class SearchPool {
	private idle: Worker[] = [];
	private queue: { job: Job; id: number }[] = [];
	private pending = new Map<number, { worker: Worker; job: Job }>();
	private nextBatch = 0;
	private nextSearch = 0;
	private closed = false;

	private constructor(private readonly workers: Worker[]) {
		for (const w of workers) {
			w.on('message', (m: { type: string; batch: number; values?: number[]; message?: string }) => {
				const p = this.pending.get(m.batch);
				if (!p) return;
				this.pending.delete(m.batch);
				if (m.type === 'values') p.job.resolve(m.values!);
				else p.job.reject(new Error(m.message));
				this.release(w);
			});
			w.on('error', e => {
				for (const [batch, p] of this.pending) if (p.worker === w) { this.pending.delete(batch); p.job.reject(e); }
			});
		}
		this.idle = [...workers];
	}

	/** Start `threads` workers (default: all hardware threads but one) and wait until they're ready. */
	static async start(threads = defaultThreads()): Promise<SearchPool> {
		const url = new URL(`./search-worker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);
		const workers = Array.from({ length: Math.max(1, threads) }, () => new Worker(url, { execArgv: ['--import', 'tsx'] }));
		await Promise.all(workers.map(w => new Promise<void>((resolve, reject) => {
			w.once('message', () => resolve());
			w.once('error', reject);
		})));
		return new SearchPool(workers);
	}

	get size() { return this.workers.length; }

	/** Hand a search's guesses to every worker; returns the runner for its batches of cells. */
	setup(dets: Determinization[], me: SideIndex): CellRunner {
		const id = ++this.nextSearch;
		for (const w of this.workers) w.postMessage({ type: 'setup', id, dets, me });
		return cells => this.run(id, cells);
	}

	/** Simulate cells across the workers, in chunks small enough to balance the load. */
	private async run(id: number, cells: Cell[]): Promise<number[]> {
		if (this.closed) throw new Error('search pool is closed');
		if (!cells.length) return [];
		const chunk = Math.max(1, Math.ceil(cells.length / (this.workers.length * 4)));
		const parts: Promise<number[]>[] = [];
		for (let i = 0; i < cells.length; i += chunk) {
			parts.push(new Promise((resolve, reject) => {
				this.queue.push({ job: { cells: cells.slice(i, i + chunk), resolve, reject }, id });
			}));
		}
		this.pump();
		return (await Promise.all(parts)).flat();
	}

	private pump() {
		while (this.idle.length && this.queue.length) {
			const w = this.idle.pop()!;
			const { job, id } = this.queue.shift()!;
			const batch = ++this.nextBatch;
			this.pending.set(batch, { worker: w, job });
			w.postMessage({ type: 'cells', id, batch, cells: job.cells });
		}
	}

	private release(w: Worker) {
		this.idle.push(w);
		this.pump();
	}

	async close() {
		this.closed = true;
		await Promise.all(this.workers.map(w => w.terminate()));
	}
}
