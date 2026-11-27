/**
 * Bot-vs-bot games: the one-turn solver against a random player, alternating sides.
 *
 *   npm run arena -- 20                 # games (default 10)
 *   npm run arena -- 20 --samples 3 --keep 8
 *   npm run arena -- 20 --vs greedy     # against a one-turn-greedy bot that can see your sets (cheats)
 */
import { createBattle } from '../src/sim/battle.js';
import { makeRng, playOut, RandomPolicy, type Policy } from '../src/sim/play.js';
import { OracleGreedyBot, SolverBot } from '../src/engine/bots.js';
import { randomTeam } from '../test/helpers.js';

const args = process.argv.slice(2);
const opt = (name: string, def: number) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const games = Number(args.find((a, i) => /^\d+$/.test(a) && !args[i - 1]?.startsWith('--')) ?? 10);
const vs = args.includes('--vs') ? args[args.indexOf('--vs') + 1] : 'random';
const opponent = (g: number): Policy => (vs === 'greedy' ? new OracleGreedyBot(3, g) : new RandomPolicy(makeRng(g)));
const solve = { samples: opt('samples', 2), keep: opt('keep', 6), perSlot: opt('perslot', 3), replies: opt('replies', 2), iterations: 1500 };
let wins = 0, losses = 0, ties = 0;
const times: number[] = [];
const t0 = performance.now();
for (let g = 0; g < games; g++) {
	const solverSide = g % 2;
	const bot = new SolverBot({ solve, seed: g + 1 });
	const policies: [Policy, Policy] = solverSide === 0 ? [bot, opponent(g)] : [opponent(g), bot];
	const battle = createBattle({ p1: { name: 'A', team: randomTeam(10000 + g * 2) }, p2: { name: 'B', team: randomTeam(10001 + g * 2) }, seed: g + 1, keepLog: true });
	const res = playOut(battle, policies, 100);
	const solverName = solverSide === 0 ? 'A' : 'B';
	if (!res.winner) ties++; else if (res.winner === solverName) wins++; else losses++;
	times.push(...bot.timings);
	process.stdout.write(`game ${g + 1}: solver ${res.winner === solverName ? 'won' : res.winner ? 'lost' : 'tied'} in ${res.turns} turns\n`);
}
const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
console.log(`\nSolver vs ${vs}: ${wins}-${losses}${ties ? `-${ties}` : ''} (${(100 * wins / games).toFixed(0)}% wins)`);
console.log(`Average ${avg.toFixed(0)} ms per decision; ${((performance.now() - t0) / 1000).toFixed(0)} s total`);
