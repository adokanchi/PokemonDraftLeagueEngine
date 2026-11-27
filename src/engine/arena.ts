/**
 * One bot-vs-bot arena game: the solver bot against a random player or a cheating greedy bot,
 * on random teams. Used by `npm run arena`, in this thread or in worker threads (`--jobs`).
 */
import { createBattle } from '../sim/battle.js';
import { makeRng, playOut, RandomPolicy, type Policy } from '../sim/play.js';
import { randomTeam } from '../../test/helpers.js';
import { OracleGreedyBot, SolverBot } from './bots.js';
import type { SolveOptions } from './solver.js';

export interface ArenaGame {
	game: number;
	vs: 'random' | 'greedy';
	solve: SolveOptions;
}

export interface ArenaResult {
	game: number;
	result: 'won' | 'lost' | 'tied';
	turns: number;
	/** Milliseconds per solver decision. */
	timings: number[];
}

export function playArenaGame({ game: g, vs, solve }: ArenaGame): ArenaResult {
	const solverSide = g % 2;
	const bot = new SolverBot({ solve, seed: g + 1 });
	const opponent: Policy = vs === 'greedy' ? new OracleGreedyBot(3, g) : new RandomPolicy(makeRng(g));
	const policies: [Policy, Policy] = solverSide === 0 ? [bot, opponent] : [opponent, bot];
	const battle = createBattle({ p1: { name: 'A', team: randomTeam(10000 + g * 2) }, p2: { name: 'B', team: randomTeam(10001 + g * 2) }, seed: g + 1, keepLog: true });
	const res = playOut(battle, policies, 100);
	const me = solverSide === 0 ? 'A' : 'B';
	return { game: g, result: !res.winner ? 'tied' : res.winner === me ? 'won' : 'lost', turns: res.turns, timings: bot.timings };
}
