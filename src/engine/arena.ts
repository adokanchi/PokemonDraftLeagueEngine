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
	/** Opponent: a random player, a cheating one-turn greedy bot, or the solver bot itself. */
	vs: 'random' | 'greedy' | 'self';
	solve: SolveOptions;
	/** Team preview for the solver bot, and for the opponent when it's the solver too. */
	preview?: 'solver' | 'random';
	vsPreview?: 'solver' | 'random';
	/** After a faint, for the opponent when it's the solver: search replacements or take the healthiest. */
	vsReplacements?: 'search' | 'healthiest';
	replacements?: 'search' | 'healthiest';
}

export interface ArenaResult {
	game: number;
	result: 'won' | 'lost' | 'tied';
	turns: number;
	/** Milliseconds per solver decision. */
	timings: number[];
}

export function playArenaGame({ game: g, vs, solve, preview, vsPreview, vsReplacements, replacements }: ArenaGame): ArenaResult {
	const solverSide = g % 2;
	const bot = new SolverBot({ solve, seed: g + 1, preview, replacements });
	const opponent: Policy = vs === 'greedy' ? new OracleGreedyBot(3, g) : vs === 'self' ? new SolverBot({ solve, seed: g + 1001, preview: vsPreview, replacements: vsReplacements }) : new RandomPolicy(makeRng(g));
	const policies: [Policy, Policy] = solverSide === 0 ? [bot, opponent] : [opponent, bot];
	const battle = createBattle({ p1: { name: 'A', team: randomTeam(10000 + g * 2) }, p2: { name: 'B', team: randomTeam(10001 + g * 2) }, seed: g + 1, keepLog: true });
	const res = playOut(battle, policies, 100);
	const me = solverSide === 0 ? 'A' : 'B';
	return { game: g, result: !res.winner ? 'tied' : res.winner === me ? 'won' : 'lost', turns: res.turns, timings: bot.timings };
}
