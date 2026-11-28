/**
 * Team preview: which four to bring, and which two to lead with.
 *
 * v0 is a matchup model, not simulation. For every pairing of one of our Pokémon with one of
 * theirs it works out the one-on-one: how many turns each needs to KO the other (Showdown's own
 * damage formula with our exact sets and their likely ones, accuracy and multi-hit included),
 * and who moves first. That gives a score in [-1, 1] per pairing. A bring of four is valued by
 * (a) whether each of their Pokémon has an answer among ours and (b) whether each of ours avoids
 * being hard-countered by theirs; leads by the same measure between the two lead pairs. Bring and
 * leads are then solved as a simultaneous game against their best pick (regret matching), so the
 * result is a mix when several picks are close.
 *
 * Not modelled yet: support moves (Tailwind, Trick Room, Fake Out, Intimidate, redirection),
 * spread damage, and synergy between partners. A simulation-based layer replaces this later.
 */
import { toID, type PokemonSet } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';
import { createBattle } from '../sim/battle.js';
import { parseBattleLog } from '../state/parser.js';
import { makeRng } from '../sim/play.js';
import { DamageCalc } from '../belief/damage.js';
import { OpponentModel as OpponentModelCtor } from '../belief/sets.js';

export interface PreviewInput {
	/** Our six. */
	mine: PokemonSet[];
	/** Their six, each with its likely sets (from the opponent model: `model.summary(k)`). */
	theirs: { species: string; sets: { set: PokemonSet; p: number }[] }[];
	format?: ResolvedFormat;
	iterations?: number;
	seed?: number;
}

export interface PreviewOption {
	/** Indices into `mine`, leads first (then the back two, better one first). */
	order: number[];
	/** Probability in the recommended mix. */
	p: number;
	/** Value against their best response (higher is better). */
	value: number;
}

export interface PreviewResult {
	options: PreviewOption[];
	/** Pick drawn from the mix (or the top option): indices into `mine`, leads first. */
	pick: number[];
	/** One-on-one scores: matchup[i][j] for our i vs their j, in [-1, 1]. */
	matchup: number[][];
	/** Their likely picks: indices into `theirs`, leads first. */
	theirLikely: { order: number[]; p: number }[];
}

const choose = (n: number, k: number): number[][] => {
	const out: number[][] = [];
	const rec = (start: number, acc: number[]) => {
		if (acc.length === k) { out.push(acc); return; }
		for (let i = start; i < n; i++) rec(i + 1, [...acc, i]);
	};
	rec(0, []);
	return out;
};

/** Species to calculate with: the Mega forme when it holds its stone. */
function battleSpecies(set: PokemonSet, format: ResolvedFormat): string {
	const item = format.dex.items.get(set.item);
	const sp = format.dex.species.get(set.species);
	const mega = item.megaStone ? (typeof item.megaStone === 'string' ? item.megaStone : (item.megaStone as Record<string, string>)[sp.name]) : undefined;
	return mega ? format.dex.species.get(mega).name : sp.name;
}

export class PreviewSolver {
	private calc: DamageCalc;
	private format: ResolvedFormat;
	private speedCache = new Map<PokemonSet, number>();

	constructor(format: ResolvedFormat = resolveFormat()) {
		this.format = format;
		this.calc = new DamageCalc(format);
	}

	/** Expected fraction of the defender's HP our best move takes per turn (accuracy and hits included). */
	private bestDamage(attacker: PokemonSet, defender: PokemonSet): number {
		const dex = this.format.dex;
		const aSp = battleSpecies(attacker, this.format), dSp = battleSpecies(defender, this.format);
		const state = parseBattleLog(['|player|p1|A|', '|player|p2|B|', '|gametype|doubles', '|start',
			`|switch|p1a: A|${aSp}, L50|100/100`, `|switch|p2a: D|${dSp}, L50|100/100`, '|turn|1'].join('\n'));
		let best = 0;
		for (const id of attacker.moves) {
			const move = dex.moves.get(id);
			if (!move.exists || move.category === 'Status') continue;
			if (['fakeout', 'firstimpression', 'suckerpunch', 'thunderclap', 'explosion', 'selfdestruct', 'finalgambit', 'mistyexplosion'].includes(move.id)) continue;
			let r;
			try {
				r = this.calc.range({ state, attacker: 'p1: A', defender: 'p2: D', move: move.name, crit: false, spread: false, hit: 1 },
					m => (m.side === 'p1' ? attacker : defender));
			} catch { continue; }
			if (r.immune || !r.maxHp) continue;
			const acc = move.accuracy === true ? 1 : move.accuracy / 100;
			const mh = move.multihit as number | number[] | undefined;
			const hits = Array.isArray(mh) ? (mh[0] === 2 && mh[1] === 5 ? 3.1 : (mh[0]! + mh[1]!) / 2) : mh ?? 1;
			// Moves that need a charge turn or a recharge turn do half as much per turn.
			const slow = move.flags.charge || move.flags.recharge || move.self?.volatileStatus === 'mustrecharge' ? 0.5 : 1;
			best = Math.max(best, ((r.min + r.max) / 2 / r.maxHp) * acc * hits * slow);
		}
		return best;
	}

	private speed(set: PokemonSet): number {
		let s = this.speedCache.get(set);
		if (s === undefined) {
			try {
				const b = createBattle({ format: this.format, p1: { name: 'a', team: [set] }, p2: { name: 'b', team: [set] }, seed: 1 });
				const p = b.sides[0]!.pokemon[0]!;
				const sp = this.format.dex.species.get(battleSpecies(set, this.format));
				// Mega speed from the Mega's base stat; Choice Scarf.
				const base = p.species.baseStats.spe, mega = sp.baseStats.spe;
				s = p.storedStats.spe * (mega / base) * (toID(set.item) === 'choicescarf' ? 1.5 : 1);
			} catch { s = 0; }
			this.speedCache.set(set, s);
		}
		return s;
	}

	/** One-on-one: +1 we win clearly, -1 they do. */
	private oneOnOne(a: PokemonSet, b: PokemonSet): number {
		const turns = (d: number) => (d <= 0 ? 8 : Math.min(8, Math.ceil(1 / d - 1e-9)));
		const tA = turns(this.bestDamage(a, b)), tB = turns(this.bestDamage(b, a));
		const sa = this.speed(a), sb = this.speed(b);
		const first = sa > sb ? 0.5 : sa < sb ? -0.5 : 0;
		return Math.tanh(0.8 * (tB - tA + first));
	}

	solve(input: PreviewInput): PreviewResult {
		const { mine, theirs } = input;
		const rng = makeRng(input.seed ?? 1);
		// Matchups, averaged over their likely sets.
		const matchup = mine.map(a => theirs.map(t => {
			const total = t.sets.reduce((s, x) => s + x.p, 0) || 1;
			return t.sets.reduce((s, x) => s + x.p * this.oneOnOne(a, x.set), 0) / total;
		}));
		const nM = mine.length, nT = theirs.length;
		// Options: a bring of four with an ordered lead pair (unordered within the pair).
		const options = (n: number) => choose(n, Math.min(4, n)).flatMap(four => choose(four.length, 2).map(([i, j]) => {
			const leads = [four[i!]!, four[j!]!];
			return { four, leads, back: four.filter(x => !leads.includes(x)) };
		}));
		const ours = options(nM), their = options(nT);
		// Value of four vs four: each of theirs answered, each of ours not hard-countered. Leads the same way.
		const groupValue = (us: number[], them: number[]) =>
			them.reduce((s, j) => s + Math.max(...us.map(i => matchup[i]![j]!)), 0) / them.length
			+ us.reduce((s, i) => s + Math.min(...them.map(j => matchup[i]![j]!)), 0) / us.length;
		const LEAD_WEIGHT = 0.6;
		const payoff = ours.map(o => their.map(t => groupValue(o.four, t.four) + LEAD_WEIGHT * groupValue(o.leads, t.leads)));
		// Regret matching (we maximise, they minimise).
		const iters = input.iterations ?? 2000;
		const rx = new Array(ours.length).fill(0), sx = new Array(ours.length).fill(0);
		const ry = new Array(their.length).fill(0), sy = new Array(their.length).fill(0);
		const strat = (r: number[]) => { const pos = r.map(v => Math.max(0, v)); const t = pos.reduce((a, b) => a + b, 0); return t > 0 ? pos.map(v => v / t) : r.map(() => 1 / r.length); };
		for (let it = 0; it < iters; it++) {
			const x = strat(rx), y = strat(ry);
			const ux = payoff.map(row => row.reduce((s, v, j) => s + v * y[j]!, 0));
			const uy = their.map((_, j) => -payoff.reduce((s, row, i) => s + row[j]! * x[i]!, 0));
			const ex = ux.reduce((s, v, i) => s + v * x[i]!, 0), ey = uy.reduce((s, v, j) => s + v * y[j]!, 0);
			for (let i = 0; i < ours.length; i++) { rx[i] += ux[i]! - ex; sx[i] += x[i]!; }
			for (let j = 0; j < their.length; j++) { ry[j] += uy[j]! - ey; sy[j] += y[j]!; }
		}
		const px = sx.map(v => v / iters), py = sy.map(v => v / iters);
		const order = (o: { leads: number[]; back: number[] }, vs: (i: number) => number) => [...o.leads, ...[...o.back].sort((a, b) => vs(b) - vs(a))];
		// Back order: the one better against their likely four first.
		const theirWeight = new Array(nT).fill(0);
		their.forEach((t, j) => t.four.forEach(k => { theirWeight[k] += py[j]!; }));
		const vsThem = (i: number) => matchup[i]!.reduce((s, v, j) => s + v * theirWeight[j]!, 0);
		const value = (i: number) => payoff[i]!.reduce((s, v, j) => s + v * py[j]!, 0);
		const opts = ours.map((o, i) => ({ order: order(o, vsThem), p: px[i]!, value: value(i) }))
			.sort((a, b) => b.p - a.p || b.value - a.value);
		let r = rng();
		const pick = (opts.find(o => (r -= o.p) <= 0) ?? opts[0]!).order;
		const ourWeight = new Array(nM).fill(0);
		ours.forEach((o, i) => o.four.forEach(k => { ourWeight[k] += px[i]!; }));
		const vsUs = (j: number) => -matchup.reduce((s, row, i) => s + row[j]! * ourWeight[i]!, 0);
		const theirLikely = their.map((t, j) => ({ order: order(t, vsUs), p: py[j]! })).filter(t => t.p > 0.01).sort((a, b) => b.p - a.p).slice(0, 5);
		return { options: opts.filter(o => o.p > 0.005).slice(0, 8), pick, matchup, theirLikely };
	}
}

/**
 * Team preview from a battle log (up to "|teampreview"): reads their six, takes their likely sets
 * from the opponent model (including what earlier games of the set revealed), and solves.
 */
export function previewFromLog(opts: {
	lines: string[];
	me: 'p1' | 'p2';
	team: PokemonSet[];
	knowledge?: import('../state/knowledge.js').TeamKnowledge;
	megaStones?: Record<string, string>;
	prior?: import('../data/priors.js').SetPrior;
	seed?: number;
	solver?: PreviewSolver;
	setsPerSpecies?: number;
}): PreviewResult & { theirSpecies: string[] } {
	// (Imported here to keep the solver itself free of the opponent model.)
	const model = new OpponentModelCtor({
		side: opts.me === 'p1' ? 'p2' : 'p1', ownTeam: opts.team, knowledge: opts.knowledge,
		megaStones: opts.megaStones, prior: opts.prior, seed: opts.seed,
	});
	for (const l of opts.lines) model.feed(l);
	const preview = model.state.sides[opts.me === 'p1' ? 'p2' : 'p1'].preview;
	const summary = model.summary(opts.setsPerSpecies ?? 4);
	const theirs = Object.entries(summary).map(([species, sets]) => ({ species, sets }));
	const res = (opts.solver ?? new PreviewSolver()).solve({ mine: opts.team, theirs, seed: opts.seed });
	return { ...res, theirSpecies: theirs.map(t => t.species).length ? theirs.map(t => t.species) : preview };
}
