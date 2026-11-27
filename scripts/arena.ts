/**
 * Bot-vs-bot games: the one-turn solver against a random player, alternating sides.
 *
 *   npm run arena -- 20                 # games (default 10)
 *   npm run arena -- 20 --samples 3 --keep 8
 *   npm run arena -- 20 --vs greedy     # against a one-turn-greedy bot that can see your sets (cheats)
 *   npm run arena -- 40 --jobs 8        # play 8 games at a time on worker threads (default: all threads but one)
 */
import { Worker } from 'node:worker_threads';
import { defaultThreads } from '../src/engine/pool.js';
import { playArenaGame, type ArenaGame, type ArenaResult } from '../src/engine/arena.js';

const args = process.argv.slice(2);
const opt = (name: string, def: number) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const games = Number(args.find((a, i) => /^\d+$/.test(a) && !args[i - 1]?.startsWith('--')) ?? 10);
const vs = (args.includes('--vs') ? args[args.indexOf('--vs') + 1] : 'random') as ArenaGame['vs'];
const jobs = Math.max(1, Math.min(games, opt('jobs', defaultThreads())));
const solve = { samples: opt('samples', 2), keep: opt('keep', 6), perSlot: opt('perslot', 3), replies: opt('replies', 2), iterations: 1500 };

const t0 = performance.now();
const results: ArenaResult[] = [];
const report = (r: ArenaResult) => {
	results.push(r);
	process.stdout.write(`game ${r.game + 1}: solver ${r.result} in ${r.turns} turns\n`);
};

if (jobs === 1) {
	for (let g = 0; g < games; g++) report(playArenaGame({ game: g, vs, solve }));
} else {
	console.log(`Playing ${games} games, ${jobs} at a time...`);
	let next = 0;
	await Promise.all(Array.from({ length: jobs }, () => new Promise<void>((resolve, reject) => {
		const w = new Worker(new URL('./arena-worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
		const feed = () => {
			if (next >= games) { void w.terminate().then(() => resolve()); return; }
			w.postMessage({ game: next++, vs, solve } satisfies ArenaGame);
		};
		w.on('message', (m: ArenaResult | 'ready') => { if (m !== 'ready') report(m); feed(); });
		w.on('error', reject);
	})));
}

const wins = results.filter(r => r.result === 'won').length;
const losses = results.filter(r => r.result === 'lost').length;
const ties = results.length - wins - losses;
const times = results.flatMap(r => r.timings);
const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
console.log(`\nSolver vs ${vs}: ${wins}-${losses}${ties ? `-${ties}` : ''} (${(100 * wins / games).toFixed(0)}% wins)`);
console.log(`Average ${avg.toFixed(0)} ms per decision; ${((performance.now() - t0) / 1000).toFixed(0)} s total`);
