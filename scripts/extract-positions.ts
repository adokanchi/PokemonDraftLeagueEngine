/**
 * Turns saved replays into training labels: one line per game in
 * data/positions/<format>.jsonl.gz with the replay id, rating, upload time, winner, and each
 * side's per-turn choices (see src/data/positions.ts). Positions aren't stored; the featurizer
 * rebuilds each one from the replay log, so the labels stay small and the features can change.
 *
 *   npm run extract-positions
 *   npm run extract-positions -- --format gen9championsvgc2026regmc --dir data/replays --out data/positions
 *   npm run extract-positions -- --examples "no action shown" 5    # print sample turns for a reason, no output file
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { REPLAY_DIR, ReplayStore } from '../src/data/replays.js';
import { labelLog } from '../src/data/positions.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const store = new ReplayStore(opt('dir') ?? REPLAY_DIR);
const outDir = opt('out') ?? join(process.cwd(), 'data', 'positions');
const exIdx = args.indexOf('--examples');
const exWhy = exIdx >= 0 ? args[exIdx + 1] : undefined;
let exLeft = exIdx >= 0 ? Number(args[exIdx + 2] ?? 5) : 0;
const formats = opt('format') ? [opt('format')!] : store.formats();
if (!formats.length) { console.log('No replays found. Run: npm run fetch-replays'); process.exit(0); }
mkdirSync(outDir, { recursive: true });

for (const format of formats) {
	const file = join(outDir, `${format}.jsonl.gz`);
	const gz = createGzip();
	const done = new Promise<void>(res => gz.pipe(createWriteStream(file)).on('finish', () => res()));
	let unplayed = 0;
	let games = 0, noWinner = 0, failed = 0, slots = 0, labelled = 0, switches = 0, replacements = 0;
	const whys: Record<string, number> = {};
	for (const r of store.all(format)) {
		try {
			const g = labelLog(r.log);
			if (!g.winner) { noWinner++; continue; }
			games++;
			if (g.unplayedTurn) unplayed++;
			for (const t of g.turns) for (const [slot, l] of t.slots.entries()) {
				if (!l) continue;
				if (exWhy && exLeft > 0 && l.action === 'unknown' && l.why.startsWith(exWhy)) {
					exLeft--;
					const lines = r.log.split('\n');
					const a = lines.indexOf(`|turn|${t.turn}`), b = lines.indexOf(`|turn|${t.turn + 1}`);
					console.log(`--- ${r.id} turn ${t.turn} ${t.side}${'ab'[slot]}: ${l.why}`);
					console.log(lines.slice(Math.max(0, a), b > 0 ? b : a + 40).filter(x => x && !/^\|(t:|c|j|l|raw|)\|/.test(x)).join('\n'));
				}
				slots++;
				if (l.action === 'unknown') { const k = l.why.split(' (')[0]!; whys[k] = (whys[k] ?? 0) + 1; }
				else { labelled++; if (l.action === 'switch') switches++; }
			}
			replacements += g.replacements.length;
			if (!exWhy && !gz.write(JSON.stringify({ id: r.id, rating: r.rating ?? null, uploadtime: r.uploadtime, ...g }) + '\n')) await new Promise<void>(res => gz.once('drain', () => res()));
		} catch (e) {
			failed++;
			if (failed <= 5) console.warn(`${r.id}: ${(e as Error).message}`);
		}
	}
	gz.end();
	await done;
	console.log(`${format}: ${games} games → ${file}`);
	console.log(`  ${slots} slot-turns, ${(100 * labelled / Math.max(1, slots)).toFixed(1)}% labelled (${switches} switches), ${replacements} faint replacements`);
	console.log(`  skipped: ${noWinner} without a result, ${failed} failed; ${unplayed} games ended on a turn that never ran (forfeit/timer)`);
	console.log('  unlabelled:', whys);
}
