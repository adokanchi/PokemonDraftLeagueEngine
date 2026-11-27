/**
 * Simulator throughput benchmark: how many battles/turns per second this machine can simulate,
 * on one thread and on all threads, plus the cost of copying a battle state.
 *
 *   npm run bench                 # all hardware threads, 10 s per phase
 *   npm run bench -- --threads 8 --seconds 20
 *
 * Uses the example Reg M-C teams (examples/team-a.txt vs team-b.txt) with random legal play.
 */
import { readFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cloneBattle, createBattle, legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng, playOut, RandomPolicy } from '../src/sim/play.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const teamA = readFileSync(join(root, 'examples/team-a.txt'), 'utf8');
const teamB = readFileSync(join(root, 'examples/team-b.txt'), 'utf8');

interface Result { battles: number; turns: number; seconds: number }

function runFor(seconds: number, seed: number): Result {
	const rng = makeRng(seed);
	const policies: [RandomPolicy, RandomPolicy] = [new RandomPolicy(rng), new RandomPolicy(rng)];
	const start = performance.now();
	let battles = 0;
	let turns = 0;
	while (performance.now() - start < seconds * 1000) {
		const battle = createBattle({ p1: { name: 'A', team: teamA }, p2: { name: 'B', team: teamB }, seed: seed * 100000 + battles });
		turns += playOut(battle, policies).turns;
		battles++;
	}
	return { battles, turns, seconds: (performance.now() - start) / 1000 };
}

function cloneCost(): { cloneMs: number; cloneAndTurnMs: number } {
	const rng = makeRng(7);
	const battle = createBattle({ p1: { name: 'A', team: teamA }, p2: { name: 'B', team: teamB }, seed: 7 });
	while (!battle.ended && battle.turn < 3) {
		for (const side of sidesNeedingChoice(battle)) {
			const o = legalChoices(battle, side);
			submit(battle, side, o[Math.floor(rng() * o.length)]!);
		}
	}
	const n = 500;
	let t = performance.now();
	for (let i = 0; i < n; i++) cloneBattle(battle);
	const cloneMs = (performance.now() - t) / n;
	t = performance.now();
	for (let i = 0; i < n; i++) {
		const c = cloneBattle(battle);
		const startTurn = c.turn;
		while (!c.ended && c.turn === startTurn) {
			for (const side of sidesNeedingChoice(c)) {
				const o = legalChoices(c, side);
				submit(c, side, o[Math.floor(rng() * o.length)]!);
			}
		}
	}
	return { cloneMs, cloneAndTurnMs: (performance.now() - t) / n };
}

if (!isMainThread) {
	const { seconds, seed } = workerData as { seconds: number; seed: number };
	parentPort!.postMessage(runFor(seconds, seed));
} else {
	const arg = (name: string, def: number) => {
		const i = process.argv.indexOf(`--${name}`);
		return i >= 0 ? Number(process.argv[i + 1]) : def;
	};
	const threads = arg('threads', availableParallelism());
	const seconds = arg('seconds', 10);
	console.log(`CPU: ${cpus()[0]?.model ?? 'unknown'} | ${availableParallelism()} hardware threads | Node ${process.version}`);
	console.log(`Example teams, random legal play. ${seconds}s per phase.\n`);

	runFor(1, 999); // warm-up
	const single = runFor(seconds, 1);
	const msPerTurn = (1000 * single.seconds) / single.turns;
	console.log(`1 thread:   ${(single.battles / single.seconds).toFixed(1)} battles/s, ` +
		`${(single.turns / single.seconds).toFixed(0)} turns/s (${msPerTurn.toFixed(2)} ms/turn, ${(single.turns / single.battles).toFixed(1)} turns/battle)`);

	const c = cloneCost();
	console.log(`state copy: ${c.cloneMs.toFixed(2)} ms; copy + simulate one turn: ${c.cloneAndTurnMs.toFixed(2)} ms`);

	const results = await Promise.all(Array.from({ length: threads }, (_, i) => new Promise<Result>((resolve, reject) => {
		const w = new Worker(fileURLToPath(import.meta.url), {
			workerData: { seconds, seed: i + 2 },
			execArgv: ['--import', 'tsx'],
		});
		w.once('message', resolve);
		w.once('error', reject);
	})));
	const battles = results.reduce((a, r) => a + r.battles, 0);
	const turns = results.reduce((a, r) => a + r.turns, 0);
	const secs = Math.max(...results.map(r => r.seconds));
	const turnsPerSec = turns / secs;
	console.log(`${threads} threads: ${(battles / secs).toFixed(1)} battles/s, ${turnsPerSec.toFixed(0)} turns/s ` +
		`(${(turnsPerSec / (single.turns / single.seconds)).toFixed(1)}x one thread)\n`);

	const decisionTurns = 30 * 30 * 8;
	console.log('What that means (rough):');
	console.log(`  one-turn search (30x30 joint actions x 8 opponent-set samples = ${decisionTurns} turns): ` +
		`~${(decisionTurns * c.cloneAndTurnMs / threads / 1000).toFixed(1)} s on all threads`);
	const previewGames = 90 * 90 * 30;
	console.log(`  team preview matrix with random playouts (90x90 cells x 30 games): ` +
		`~${(previewGames / (battles / secs) / 60).toFixed(0)} min on all threads`);
}
