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
import { reconstructBattle, withZoroarkAs } from './reconstruct.js';
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

/**
 * Narrowing a side's joint choices: score each Pokémon's actions separately, keep the best few per
 * Pokémon, and combine. `narrowProbes` lists the joint choices whose scores are needed (one per
 * Pokémon action, paired with the first legal choice containing it); none if no narrowing is needed.
 */
function narrowProbes(legal: string[], keep: number): string[] {
	if (legal.length <= keep) return [];
	const nSlots = legal[0]!.split(', ').length;
	const out = new Set<string>();
	for (let slot = 0; slot < nSlots; slot++) {
		const seen = new Set<string>();
		for (const c of legal) {
			const a = c.split(', ')[slot]!;
			if (!seen.has(a)) { seen.add(a); out.add(c); }
		}
	}
	return [...out];
}

function narrowPick(legal: string[], score: (choice: string) => number, perSlot: number, keep: number): string[] {
	if (legal.length <= keep) return legal;
	const parts = legal.map(c => c.split(', '));
	const nSlots = parts[0]!.length;
	const best: string[][] = [];
	for (let slot = 0; slot < nSlots; slot++) {
		const actions = [...new Set(parts.map(p => p[slot]!))];
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
	/** Which of our active slots hold our own Zoroark, when we know (the log only shows its disguise). */
	ownZoroark?: { slot: number; isZoroark: boolean }[];
}

/** One simulated turn: in guess k, we play `mine` and they play `theirs`. */
export type Cell = [k: number, mine: string, theirs: string];

/** A guess of the opponent's team, with what's needed to rebuild the battle for it (anywhere). */
export interface Determinization {
	state: KnownBattleState;
	teams: Record<SideId, PokemonSet[]>;
	seed: number;
}

/** Simulate cells: in-process, or spread over worker threads (see pool.ts). Results in order. */
export type CellRunner = (cells: Cell[]) => number[] | Promise<number[]>;

/** Score one cell on a rebuilt battle (NaN when the simulator can't play it). */
export function runCell(battles: Battle[], me: SideIndex, cell: Cell): number {
	return playCell(battles[cell[0]]!, me, cell[1], cell[2]);
}

/** Rebuild the battle for a determinization (same seed, same battle: worker threads rely on it). */
export function buildDeterminization(d: Determinization): Battle {
	return reconstructBattle({ state: d.state, teams: d.teams, seed: d.seed }).battle;
}

interface Prepared {
	o: Required<SolveOptions>;
	me: SideIndex;
	them: SideIndex;
	dets: Determinization[];
	battles: Battle[];
	rng: () => number;
	t0: number;
}

/** Draw the guesses of their team and rebuild the battle for each. */
function prepare(input: SolveInput): Prepared {
	const t0 = performance.now();
	const o = { samples: 6, keep: 12, perSlot: 4, replies: 4, iterations: 3000, seed: 1, ...input.options };
	const rng = makeRng(o.seed);
	const me: SideIndex = input.me === 'p1' ? 0 : 1;
	const them = (1 - me) as SideIndex;
	const themId: SideId = input.me === 'p1' ? 'p2' : 'p1';
	const dets: Determinization[] = [];
	const battles: Battle[] = [];
	for (let k = 0; k < o.samples; k++) {
		const sample = input.model.sampleTeam();
		if (sample.sets.length === 0) continue;
		let state = input.model.withOwnZoroark(input.state, input.ownZoroark);
		if (sample.zoroarkIdent) {
			const zoro = sample.sets.find(s => s.species.startsWith('Zoroark'));
			if (zoro) state = withZoroarkAs(state, themId, sample.zoroarkIdent, zoro.species);
		}
		const det: Determinization = { state, teams: { [input.me]: input.myTeam, [themId]: sample.sets } as Record<SideId, PokemonSet[]>, seed: o.seed * 1000 + k };
		try {
			const battle = buildDeterminization(det);
			if (legalChoices(battle, me).length && legalChoices(battle, them).length) { dets.push(det); battles.push(battle); }
		} catch {
			// A guess the simulator can't represent: skip it.
		}
	}
	if (!battles.length) throw new Error('Could not rebuild the battle for any guess of their team');
	return { o, me, them, dets, battles, rng, t0 };
}

/**
 * The search as a sequence of batches: each `yield` hands over cells to simulate and receives
 * their scores, so the same search runs in-process or across worker threads.
 */
function* search(p: Prepared): Generator<Cell[], SolveResult, number[]> {
	const { o, me, them, battles, rng } = p;
	const weights = battles.map(() => 1 / battles.length);
	const myLegal = legalChoices(battles[0]!, me);
	let simulations = 0;
	const meanOf = (values: number[]) => {
		const ok = values.filter(v => !Number.isNaN(v));
		return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : -Infinity;
	};

	// 1. Narrow our options against a few random replies per guess.
	const replies = battles.map(b => {
		const legal = legalChoices(b, them);
		return Array.from({ length: Math.min(o.replies, legal.length) }, () => legal[Math.floor(rng() * legal.length)]!);
	});
	const probesMine = narrowProbes(myLegal, o.keep);
	const cells1: Cell[] = probesMine.flatMap(c => battles.flatMap((_, k) => replies[k]!.map(r => [k, c, r] as Cell)));
	const v1 = cells1.length ? yield cells1 : [];
	simulations += cells1.length;
	const byChoice = new Map<string, number[]>();
	cells1.forEach((cell, i) => { const a = byChoice.get(cell[1]) ?? []; a.push(v1[i]!); byChoice.set(cell[1], a); });
	const mine = narrowPick(myLegal, c => meanOf(byChoice.get(c) ?? []), o.perSlot, o.keep);

	// 2. Narrow theirs in each guess against our best few.
	const probes = mine.slice(0, Math.min(3, mine.length));
	const theirLegal = battles.map(b => legalChoices(b, them));
	const cells2: Cell[] = theirLegal.flatMap((legal, k) => narrowProbes(legal, o.keep).flatMap(c => probes.map(m => [k, m, c] as Cell)));
	const v2 = cells2.length ? yield cells2 : [];
	simulations += cells2.length;
	const theirScore = new Map<string, number>(); // key k|choice -> sum of -value (NaN as 0)
	cells2.forEach((cell, i) => { const key = `${cell[0]}|${cell[2]}`; theirScore.set(key, (theirScore.get(key) ?? 0) - (v2[i]! || 0)); });
	const theirs = theirLegal.map((legal, k) => narrowPick(legal, c => (theirScore.get(`${k}|${c}`) ?? 0) / probes.length, o.perSlot, o.keep));

	// 3. Payoff matrices.
	const cells3: Cell[] = battles.flatMap((_, k) => mine.flatMap(m => theirs[k]!.map(t => [k, m, t] as Cell)));
	const v3 = yield cells3;
	simulations += cells3.length;
	let idx = 0;
	const matrices = battles.map((_, k) => mine.map(() => theirs[k]!.map(() => { const v = v3[idx++]!; return Number.isNaN(v) ? 0 : v; })));

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
	return { options, value: sol.value, opponent, samples: battles.length, simulations, ms: performance.now() - p.t0, reference: battles[0]! };
}

/** One-turn search in this thread. */
export function solveTurn(input: SolveInput): SolveResult {
	const p = prepare(input);
	const gen = search(p);
	let step = gen.next();
	while (!step.done) step = gen.next(step.value.map(cell => runCell(p.battles, p.me, cell)));
	return step.value;
}

/**
 * One-turn search with the simulations spread over a pool of worker threads (same result as
 * `solveTurn` for the same input and seed).
 */
export async function solveTurnParallel(input: SolveInput, pool: { setup(dets: Determinization[], me: SideIndex): CellRunner }): Promise<SolveResult> {
	const p = prepare(input);
	const run = pool.setup(p.dets, p.me);
	const gen = search(p);
	let step = gen.next();
	while (!step.done) step = gen.next(await run(step.value));
	const res = step.value;
	res.ms = performance.now() - p.t0;
	return res;
}

/** A possible replacement after a faint: the choice string, and who goes into which slot. */
export interface ReplacementOption {
	choice: string;
	slots: { slot: number; set: PokemonSet; hp?: number; maxHp?: number; status?: string }[];
}

/**
 * The known state as it would be at the start of next turn if these replacements came in
 * (the opponent's own replacements, if any, are unknown and left out).
 */
export function stateWithReplacements(state: KnownBattleState, me: SideId, slots: ReplacementOption['slots']): KnownBattleState {
	const out = structuredClone(state);
	const side = out.sides[me];
	for (const r of slots) {
		const ident = `${me}: ${r.set.name}`;
		let mon = side.pokemon.find(p => p.ident === ident) ?? side.pokemon.find(p => !p.seen && p.teamSpecies === r.set.species);
		if (!mon) {
			mon = {
				ident, side: me, name: r.set.name, species: r.set.species, teamSpecies: r.set.species, permanentSpecies: r.set.species,
				level: r.set.level || 50, gender: '', hp: r.hp ?? 100, maxHp: r.maxHp ?? 100, status: '', boosts: {}, volatiles: {},
				fainted: false, activeSlot: null, seen: true, megaEvolved: false, moves: {}, item: { swapped: false },
			} as KnownBattleState['sides'][SideId]['pokemon'][number];
			side.pokemon.push(mon);
		}
		const old = side.pokemon.find(p => p.ident === side.active[r.slot]);
		if (old) old.activeSlot = null;
		if (r.hp !== undefined) { mon.hp = r.hp; mon.maxHp = r.maxHp ?? mon.maxHp; }
		if (r.status !== undefined) mon.status = r.status as never;
		Object.assign(mon, { activeSlot: r.slot, seen: true, switchedInTurn: state.turn, boosts: {}, volatiles: {}, lastMove: undefined, lastMoveTurn: undefined });
		mon.stint = { timesAttacked: 0, moves: {}, faintedAllies: side.pokemon.filter(p => p.fainted).length };
		side.active[r.slot] = mon.ident;
	}
	out.turn = state.turn + 1;
	return out;
}

/**
 * After a faint: score each replacement by searching the next turn from the position it leads to,
 * and pick the best (in-process, or on a worker pool).
 */
export async function chooseReplacement(input: ReplacementInput & { pool?: Parameters<typeof solveTurnParallel>[1] }): Promise<ReplacementResult> {
	const values: { choice: string; value: number }[] = [];
	for (const [r, sub] of replacementSearches(input)) {
		try { values.push({ choice: r.choice, value: (input.pool ? await solveTurnParallel(sub, input.pool) : solveTurn(sub)).value }); } catch { values.push({ choice: r.choice, value: -Infinity }); }
	}
	return pickReplacement(input, values);
}

/** Same, in this thread. */
export function chooseReplacementSync(input: ReplacementInput): ReplacementResult {
	const values: { choice: string; value: number }[] = [];
	for (const [r, sub] of replacementSearches(input)) {
		try { values.push({ choice: r.choice, value: solveTurn(sub).value }); } catch { values.push({ choice: r.choice, value: -Infinity }); }
	}
	return pickReplacement(input, values);
}

export type ReplacementInput = Omit<SolveInput, 'state'> & { state: KnownBattleState; replacements: ReplacementOption[] };
export interface ReplacementResult {
	/** The best replacement, or undefined if none could be searched (use a fallback). */
	choice?: string;
	values: { choice: string; value: number }[];
}

function replacementSearches(input: ReplacementInput): [ReplacementOption, SolveInput][] {
	if (input.replacements.length <= 1) return [];
	return input.replacements.map(r => [r, { ...input, state: stateWithReplacements(input.state, input.me, r.slots), options: { samples: 3, keep: 8, perSlot: 3, replies: 2, iterations: 1000, ...input.options } }]);
}

function pickReplacement(input: ReplacementInput, values: { choice: string; value: number }[]): ReplacementResult {
	if (input.replacements.length === 1) return { choice: input.replacements[0]!.choice, values };
	values.sort((a, b) => b.value - a.value);
	return { choice: values[0] && values[0].value > -Infinity ? values[0].choice : undefined, values };
}
