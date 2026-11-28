/**
 * Builds the neural network's training data from saved replays: every turn from each side's
 * point of view (src/nn/examples.ts), written as flat binary arrays for numpy/PyTorch.
 *
 *   npm run featurize                      # all replays, as many processes as cores and free memory allow
 *   npm run featurize -- --jobs 4 --max 2000 --dir data/replays --out data/features
 *
 * Output in data/features/<format>/:
 *   layout.json   field names and label codes (the contract with the Python side)
 *   vocab.json    id -> name for species, moves, items, abilities
 *   properties.json  types, base stats, move power/category/target/flags... per vocab row
 *   games.txt     replay id per game index
 *   per shard k:  ints-k.i16 (rows × 12 × 9), floats-k.i8 (rows × (12 × mon floats + global), value/127),
 *                 labels-k.i8 (rows × 7), meta-k.i32 (rows × 5: game, turn, side, rating, held out)
 * Read with python/dataset.py.
 */
import { fork } from 'node:child_process';
import { availableParallelism, freemem } from 'node:os';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLAY_DIR, ReplayStore } from '../src/data/replays.js';
import { isHeldOut } from '../src/data/positions.js';
import { loadPrior } from '../src/data/priors.js';
import { gameExamples } from '../src/nn/examples.js';
import { layout, Vocab } from '../src/nn/features.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const dir = opt('dir') ?? REPLAY_DIR;
const store = new ReplayStore(dir);
const format = opt('format') ?? store.formats()[0];
if (!format) { console.log('No replays found. Run: npm run fetch-replays'); process.exit(0); }
const outDir = join(opt('out') ?? join(process.cwd(), 'data', 'features'), format);
const ids = store.ids(format).sort().slice(0, opt('max') ? Number(opt('max')) : undefined);
const shardArg = opt('shard');

if (!shardArg) {
	// Each process holds its own copy of Showdown's data and the usage stats (~0.6 GB), so free
	// memory, not cores, is usually the limit on a laptop. Too many and it all ends up in swap.
	const PER_PROCESS = 0.6e9;
	const byMemory = Math.floor((freemem() - 1e9) / PER_PROCESS);
	const jobs = Math.max(1, Number(opt('jobs') ?? Math.min(availableParallelism() - 1, byMemory)));
	mkdirSync(outDir, { recursive: true });
	const vocab = new Vocab();
	writeFileSync(join(outDir, 'layout.json'), JSON.stringify({ ...layout(vocab), format, shards: jobs }, null, 1));
	writeFileSync(join(outDir, 'vocab.json'), JSON.stringify(vocab));
	writeFileSync(join(outDir, 'properties.json'), JSON.stringify(vocab.properties()));
	writeFileSync(join(outDir, 'games.txt'), ids.join('\n') + '\n');
	console.log(`${format}: ${ids.length} replays, ${jobs} processes (${(freemem() / 1e9).toFixed(1)} GB free; set --jobs to change) → ${outDir}`);
	const started = Date.now();
	const script = fileURLToPath(import.meta.url);
	const progress = new Array<number>(jobs).fill(0);
	let lastPrint = Date.now();
	const report = () => {
		const done = progress.reduce((a, b) => a + b, 0);
		const s = (Date.now() - started) / 1000;
		const eta = done ? (s / done) * (ids.length - done) : 0;
		console.log(`  ${done}/${ids.length} games (${(100 * done / ids.length).toFixed(0)}%), ${(done / s).toFixed(0)} games/s, about ${Math.ceil(eta / 60)} min left`);
	};
	await Promise.all(Array.from({ length: jobs }, (_, k) => new Promise<void>((res, rej) => {
		const child = fork(script, [...args, '--shard', `${k}/${jobs}`], { execArgv: ['--import', 'tsx'] });
		child.on('message', (m: { done: number }) => {
			progress[k] = m.done;
			if (Date.now() - lastPrint > 15_000) { lastPrint = Date.now(); report(); }
		});
		child.on('exit', code => (code === 0 ? res() : rej(new Error(`shard ${k} exited with ${code}`))));
	})));
	let rows = 0, games = 0, skippedSides = 0, failed = 0, held = 0;
	const act = { known: 0, slots: 0 };
	for (let k = 0; k < jobs; k++) {
		const s = JSON.parse(readFileSync(join(outDir, `shard-${k}.json`), 'utf8'));
		rows += s.rows; games += s.games; skippedSides += s.skippedSides; failed += s.failed; held += s.heldOutRows;
		act.known += s.actionsKnown; act.slots += s.actionSlots;
	}
	console.log(`${rows} positions from ${games} games (${held} held out) in ${((Date.now() - started) / 1000).toFixed(0)} s`);
	console.log(`  choices with a usable label: ${act.known} of ${act.slots} active slots (${(100 * act.known / Math.max(1, act.slots)).toFixed(1)}%)`);
	console.log(`  ${skippedSides} sides skipped (own Zoroark or incomplete team), ${failed} games failed`);
	process.exit(0);
}

const [k, n] = shardArg.split('/').map(Number) as [number, number];
const vocab = new Vocab();
const prior = loadPrior();
const files = {
	ints: openSync(join(outDir, `ints-${k}.i16`), 'w'),
	floats: openSync(join(outDir, `floats-${k}.i8`), 'w'),
	labels: openSync(join(outDir, `labels-${k}.i8`), 'w'),
	meta: openSync(join(outDir, `meta-${k}.i32`), 'w'),
};
const stats = { rows: 0, games: 0, skippedSides: 0, failed: 0, heldOutRows: 0, actionsKnown: 0, actionSlots: 0 };
let processed = 0;
for (let g = k; g < ids.length; g += n) {
	const id = ids[g]!;
	if (++processed % 50 === 0) process.send?.({ done: processed });
	let ex;
	try {
		ex = gameExamples(id, store.load(format, id).log, vocab, { prior });
	} catch (e) {
		stats.failed++;
		if (stats.failed <= 3) console.warn(`${id}: ${(e as Error).message.split('\n')[0]}`);
		continue;
	}
	if (!ex.length) continue;
	stats.games++;
	stats.skippedSides += 2 - new Set(ex.map(e => e.side)).size;
	const r = (store.load(format, id) as { rating?: number }).rating ?? 0;
	const held = isHeldOut(id) ? 1 : 0;
	for (const e of ex) {
		writeSync(files.ints, Buffer.from(e.features.ints.buffer));
		writeSync(files.floats, Buffer.from(Int8Array.from(e.features.floats, x => Math.round(Math.max(-1, Math.min(1, x)) * 127)).buffer));
		writeSync(files.labels, Buffer.from(e.labels.buffer));
		writeSync(files.meta, Buffer.from(Int32Array.from([g, e.turn, e.side === 'p1' ? 0 : 1, r, held]).buffer));
		stats.rows++;
		stats.heldOutRows += held;
		for (const a of [e.labels[0]!, e.labels[3]!]) { stats.actionSlots++; if (a >= 0) stats.actionsKnown++; }
	}
}
for (const f of Object.values(files)) closeSync(f);
writeFileSync(join(outDir, `shard-${k}.json`), JSON.stringify(stats));
process.exit(0);
