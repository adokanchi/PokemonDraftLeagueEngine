/**
 * Worker thread for SearchPool: keeps the rebuilt battles of the current search and simulates
 * cells (one turn: our choice vs theirs) on request.
 */
import { parentPort } from 'node:worker_threads';
import type { Battle } from '../showdown.js';
import type { SideIndex } from '../sim/battle.js';
import { buildDeterminization, runCell, type Cell, type Determinization } from './solver.js';

type Msg =
	| { type: 'setup'; id: number; dets: Determinization[]; me: SideIndex }
	| { type: 'cells'; id: number; batch: number; cells: Cell[] };

let current: { id: number; battles: Battle[]; me: SideIndex } | undefined;

parentPort!.on('message', (msg: Msg) => {
	if (msg.type === 'setup') {
		// (Rebuilt lazily-on-setup: the same seeds give the same battles as on the main thread.)
		current = { id: msg.id, battles: msg.dets.map(buildDeterminization), me: msg.me };
		return;
	}
	if (!current || current.id !== msg.id) {
		parentPort!.postMessage({ type: 'error', batch: msg.batch, message: `search ${msg.id} is not set up in this worker` });
		return;
	}
	const values = msg.cells.map(c => runCell(current!.battles, current!.me, c));
	parentPort!.postMessage({ type: 'values', batch: msg.batch, values });
});
parentPort!.postMessage({ type: 'ready' });
