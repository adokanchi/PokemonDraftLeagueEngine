/**
 * One-turn search: what should I do this turn?
 *
 * 1. Draw K complete guesses of the opponent's team from the OpponentModel and rebuild the
 *    battle for each (determinization).
 * 2. Narrow both sides to their most promising joint actions: score each Pokémon's actions
 *    separately against a few replies, keep the best per Pokémon, and combine.
 * 3. Simulate every remaining (ours x theirs) pair once per guess, finishing the turn
 *    (including forced switches), and score the result with the position evaluator.
 * 4. Solve the zero-sum game "we pick one mixed strategy; in each guess the opponent best
 *    responds" by regret matching. Simultaneous moves mean the answer is often a mix
 *    (e.g. Protect 60% / attack 40%).
 */
import type { Battle, PokemonSet } from '../showdown.js';
import { cloneBattle, legalChoices, sidesNeedingChoice, submit, type SideIndex } from '../sim/battle.js';
import { makeRng } from '../sim/play.js';
import type { KnownBattleState, SideId } from '../state/types.js';
import { reconstructBattle } from './reconstruct.js';
import { evaluate } from './evaluate.js';
import type { OpponentModel } from '../belief/sets.js';

export interface SolveOptions {
	/** Opponent-team guesses. */
	samples?: number;
	/** Joint actions kept per side after narrowing. */
	keep?: number;
	/** Actions kept per Pokémon when combining. */
	perSlot?: number;
	/** Opponent replies used while narrowing. */
	replies?: number;
	/** Regret-matching iterations. */
	iterations?: number;
	seed?: number;
}

export interface OptionResult {
	choice: string;
	label: string;
	/** Probability in the recommended mixed strategy. */
	p: number;
	/** Expected score of this option against the opponent's best mix (-1..1). */
	value: number;
}

export interface SolveResult {
	options: OptionResult[];
	/** Expected score of the recommended mix (-1..1). */
	value: number;
	/** What the opponent is likely to do, aggregated over guesses. */
	opponent: { label: string; p: number }[];
	samples: number;
	simulations: number;
	ms: number;
	/** A rebuilt battle the choice strings refer to (switch numbers follow its team order). */
	reference: Battle;
}

/** Play out the rest of the turn: forced switches pick the first legal option. */
function finishTurn(battle: Battle, startTurn: number) {
	let guard = 0;
	while (!battle.ended && battle.turn === startTurn && guard++ < 20) {
		const pending = sidesNeedingChoice(battle);
		if (!pending.length) break;
		for (const s of pending) {
			const o = legalChoices(battle, s);
			if (!o.length) return;
			submit(battle, s, o[0]!);
			if (battle.ended) break;
		}
	}
}

function playCell(base: Battle, me: SideIndex, mine: string, theirs: string): number {
	try {
		return playCellUnsafe(base, me, mine, theirs);
	} catch {
		return NaN; // the simulator choked on this rebuilt position; ignore the cell
	}
}

function playCellUnsafe(base: Battle, me: SideIndex, mine: string, theirs: string): number {
	const b = cloneBattle(base);
	const turn = b.turn;
	const them = (1 - me) as SideIndex;
	if (!submit(b, me, mine)) return NaN;
	if (!b.ended && b.sides[them]!.activeRequest && !b.sides[them]!.isChoiceDone()) {
		if (!submit(b, them, theirs)) return NaN;
	}
	finishTurn(b, turn);
	return evaluate(b, me);
}

/** Human-readable label for a joint choice ("Garchomp: Earthquake; Incineroar: Fake Out → Kingambit"). */
export function describeChoice(battle: Battle, side: SideIndex, choice: string): string {
	const s = battle.sides[side]!;
	const foe = s.foe;
	return choice.split(', ').map((part, slot) => {
		const mon = s.active[slot];
		const name = mon?.name ?? `slot ${slot + 1}`;
		const m = /^move (\d)(?: (-?\d))?( mega)?$/.exec(part);
		if (m) {
			const move = mon?.moveSlots[Number(m[1]) - 1]?.move ?? `move ${m[1]}`;
			let target = '';
			if (m[2]) {
				const loc = Number(m[2]);
				const t = loc > 0 ? foe.active[loc - 1] : s.active[-loc - 1];
				target = ` → ${t?.name ?? `slot ${Math.abs(loc)}`}${loc < 0 ? ' (ally)' : ''}`;
			}
			return `${name}: ${m[3] ? 'Mega Evolve + ' : ''}${move}${target}`;
		}
		const sw = /^switch (\d)$/.exec(part);
		if (sw) return `${name}: switch to ${s.pokemon[Number(sw[1]) - 1]?.name ?? '?'}`;
		return `${name}: ${part}`;
	}).join('; ');
}

/** Split joint choices into per-Pokémon actions, and rebuild the joint ones that are legal. */
function narrow(legal: string[], score: (choice: string) => number, perSlot: number, keep: number): string[] {
	if (legal.length <= keep) return legal;
	const parts = legal.map(c => c.split(', '));
	const nSlots = parts[0]!.length;
	const best: string[][] = [];
	for (let slot = 0; slot < nSlots; slot++) {
		const actions = [...new Set(parts.map(p => p[slot]!))];
		// Pair each action with the other slot's most common action in the legal list.
		const scored = actions.map(a => {
			const joint = legal.find(c => c.split(', ')[slot] === a)!;
			return { a, v: score(joint) };
		}).sort((x, y) => y.v - x.v);
		best.push(scored.slice(0, perSlot).map(x => x.a));
	}
	const combos = legal.filter(c => c.split(', ').every((a, slot) => best[slot]!.includes(a)));
	if (combos.length <= keep) return combos;
	const rank = new Map(combos.map(c => [c, c.split(', ').reduce((s, a, slot) => s + best[slot]!.indexOf(a), 0)]));
	return combos.sort((x, y) => rank.get(x)! - rank.get(y)!).slice(0, keep);
}

/** Regret matching for "one mix for us vs a best-responding opponent in each guess". */
function solveGame(matrices: number[][][], weights: number[], iterations: number) {
	const n = matrices[0]!.length;
	const regretX = new Array(n).fill(0);
	const sumX = new Array(n).fill(0);
	const regretY = matrices.map(m => new Array(m[0]!.length).fill(0));
	const sumY = matrices.map(m => new Array(m[0]!.length).fill(0));
	const strat = (r: number[]) => {
		const pos = r.map(x => Math.max(0, x));
		const t = pos.reduce((a, b) => a + b, 0);
		return t > 0 ? pos.map(x => x / t) : r.map(() => 1 / r.length);
	};
	for (let it = 0; it < iterations; it++) {
		const x = strat(regretX);
		const ys = regretY.map(strat);
		const u = new Array(n).fill(0); // our payoff per option vs current opponent mixes
		matrices.forEach((m, k) => {
			const y = ys[k]!;
			const w = weights[k]!;
			for (let i = 0; i < n; i++) {
				let v = 0;
				for (let j = 0; j < y.length; j++) v += m[i]![j]! * y[j]!;
				u[i] += w * v;
			}
			// Opponent (minimiser) in guess k.
			const uy = y.map((_, j) => { let v = 0; for (let i = 0; i < n; i++) v += m[i]![j]! * x[i]!; return -v; });
			const ey = uy.reduce((s, v, j) => s + v * y[j]!, 0);
			for (let j = 0; j < y.length; j++) regretY[k]![j] += uy[j]! - ey;
			for (let j = 0; j < y.length; j++) sumY[k]![j] += y[j]!;
		});
		const ex = u.reduce((s, v, i) => s + v * x[i]!, 0);
		for (let i = 0; i < n; i++) { regretX[i] += u[i]! - ex; sumX[i] += x[i]!; }
	}
	const xs = sumX.map(v => v / iterations);
	const ys = sumY.map(s => s.map(v => v / iterations));
	const values = new Array(n).fill(0);
	matrices.forEach((m, k) => {
		for (let i = 0; i < n; i++) {
			let v = 0;
			for (let j = 0; j < ys[k]!.length; j++) v += m[i]![j]! * ys[k]![j]!;
			values[i] += weights[k]! * v;
		}
	});
	const value = values.reduce((s, v, i) => s + v * xs[i]!, 0);
	return { x: xs, ys, values, value };
}

export interface SolveInput {
	state: KnownBattleState;
	me: SideId;
	/** The four we brought. */
	myTeam: PokemonSet[];
	model: OpponentModel;
	options?: SolveOptions;
}

export function solveTurn(input: SolveInput): SolveResult {
	const t0 = performance.now();
	const o = { samples: 6, keep: 12, perSlot: 4, replies: 4, iterations: 3000, seed: 1, ...input.options };
	const rng = makeRng(o.seed);
	const me: SideIndex = input.me === 'p1' ? 0 : 1;
	const them = (1 - me) as SideIndex;
	const themId: SideId = input.me === 'p1' ? 'p2' : 'p1';
	let simulations = 0;

	// 1. Determinizations.
	const battles: Battle[] = [];
	for (let k = 0; k < o.samples; k++) {
		const sample = input.model.sampleTeam();
		if (sample.sets.length === 0) continue;
		let state = input.state;
		if (sample.zoroarkIdent) {
			state = structuredClone(state);
			const zoro = sample.sets.find(s => s.species.startsWith('Zoroark'));
			const mon = state.sides[themId].pokemon.find(p => p.ident === sample.zoroarkIdent);
			if (zoro && mon) { mon.species = zoro.species; mon.teamSpecies = zoro.species; }
		}
		try {
			const { battle } = reconstructBattle({ state, teams: { [input.me]: input.myTeam, [themId]: sample.sets } as never, seed: o.seed * 1000 + k });
			if (legalChoices(battle, me).length && legalChoices(battle, them).length) battles.push(battle);
		} catch {
			// A guess the simulator can't represent: skip it.
		}
	}
	if (!battles.length) throw new Error('Could not rebuild the battle for any guess of their team');
	const weights = battles.map(() => 1 / battles.length);
	const myLegal = legalChoices(battles[0]!, me);

	// 2. Narrow our options against a few random replies per guess; then theirs against ours.
	const replies = battles.map(b => {
		const legal = legalChoices(b, them);
		return Array.from({ length: Math.min(o.replies, legal.length) }, () => legal[Math.floor(rng() * legal.length)]!);
	});
	const avg = (fn: (b: Battle, k: number) => number[]) => {
		let s = 0, n = 0;
		battles.forEach((b, k) => { for (const v of fn(b, k)) if (!Number.isNaN(v)) { s += v; n++; } });
		return n ? s / n : -Infinity;
	};
	const mine = narrow(myLegal, c => avg((b, k) => replies[k]!.map(r => { simulations++; return playCell(b, me, c, r); })), o.perSlot, o.keep);
	const theirs = battles.map(b => {
		const legal = legalChoices(b, them);
		const probes = mine.slice(0, Math.min(3, mine.length));
		return narrow(legal, c => {
			let s = 0;
			for (const m of probes) { simulations++; s -= playCell(b, me, m, c) || 0; }
			return s / probes.length;
		}, o.perSlot, o.keep);
	});

	// 3. Payoff matrices.
	const matrices = battles.map((b, k) => mine.map(m => theirs[k]!.map(t => {
		simulations++;
		const v = playCell(b, me, m, t);
		return Number.isNaN(v) ? 0 : v;
	})));

	// 4. Solve.
	const sol = solveGame(matrices, weights, o.iterations);
	const options = mine.map((choice, i) => ({ choice, label: describeChoice(battles[0]!, me, choice), p: sol.x[i]!, value: sol.values[i]! }))
		.sort((a, b) => b.p - a.p || b.value - a.value);
	const opp = new Map<string, number>();
	battles.forEach((b, k) => theirs[k]!.forEach((t, j) => {
		const label = describeChoice(b, them, t);
		opp.set(label, (opp.get(label) ?? 0) + weights[k]! * sol.ys[k]![j]!);
	}));
	const opponent = [...opp].map(([label, p]) => ({ label, p })).sort((a, b) => b.p - a.p).slice(0, 8);
	return { options, value: sol.value, opponent, samples: battles.length, simulations, ms: performance.now() - t0, reference: battles[0]! };
}
