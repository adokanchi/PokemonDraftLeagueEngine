/** Bots for practice and bot-vs-bot testing. */
import type { Battle, PokemonSet } from '../showdown.js';
import { cloneBattle, legalChoices, sidesNeedingChoice, sideRequest, submit, type SideIndex } from '../sim/battle.js';
import { evaluate } from './evaluate.js';
import { makeRng, type Policy } from '../sim/play.js';
import { viewOfLog } from '../state/parser.js';
import { OpponentModel } from '../belief/sets.js';
import type { SetPrior } from '../data/priors.js';
import { chooseReplacementSync, solveTurn, type SolveOptions, type SolveResult } from './solver.js';
import { previewFromLog } from './preview.js';

/** Rewrite "switch N" from a rebuilt battle's team order to the real battle's. */
export function translateChoice(from: Battle, to: Battle, side: SideIndex, choice: string): string {
	const src = from.sides[side]!.pokemon;
	const dst = to.sides[side]!.pokemon;
	return choice.replace(/switch (\d)/g, (_, n) => {
		const species = src[Number(n) - 1]?.set.species;
		const i = dst.findIndex(p => p.set.species === species);
		return `switch ${i + 1}`;
	});
}

export interface SolverBotOptions {
	solve?: SolveOptions;
	/** 'mix' samples from the recommended mixed strategy; 'best' always plays its top option. */
	play?: 'mix' | 'best';
	prior?: SetPrior;
	seed?: number;
	/** Team preview: the matchup solver (default) or a random pick. */
	preview?: 'solver' | 'random';
	/**
	 * After a faint: bring in the healthiest (default), or search each replacement. (Search didn't
	 * win more games with the hand-written evaluator: 56-64 over 120; revisit with the learned one.)
	 */
	replacements?: 'search' | 'healthiest';
}

/** The one-turn solver as a player. Only sees what a player would (its own view of the log). */
export class SolverBot implements Policy {
	private model?: OpponentModel;
	private fed = 0;
	private rng: () => number;
	readonly timings: number[] = [];
	last?: SolveResult;

	constructor(private opts: SolverBotOptions = {}) {
		this.rng = makeRng(opts.seed ?? 7);
	}

	/** The opponent model, fed with the log so far. */
	private ensureModel(battle: Battle, side: SideIndex): OpponentModel {
		const me = battle.sides[side]!.id as 'p1' | 'p2';
		if (!this.model) {
			this.model = new OpponentModel({
				side: me === 'p1' ? 'p2' : 'p1', ownTeam: battle.sides[side]!.team as PokemonSet[],
				// (Right after team preview the party is in the order we brought it.)
				ownOrder: battle.sides[side]!.pokemon.slice(0, 4).map(p => p.set.species),
				prior: this.opts.prior, seed: this.opts.seed,
			});
		}
		const view = viewOfLog(battle.log, me);
		for (; this.fed < view.length; this.fed++) this.model.feed(view[this.fed]!);
		return this.model;
	}

	choose(battle: Battle, side: SideIndex, options: string[]): string {
		const req = sideRequest(battle, side);
		const random = () => options[Math.floor(this.rng() * options.length)]!;
		if (!req) return random();
		if (req.teamPreview) {
			if (this.opts.preview === 'random') return random();
			const me = battle.sides[side]!.id as 'p1' | 'p2';
			try {
				const team = battle.sides[side]!.team as PokemonSet[];
				const res = previewFromLog({ lines: viewOfLog(battle.log, me), me, team, prior: this.opts.prior, seed: Math.floor(this.rng() * 1e6) });
				// (Showdown takes the four in any order: leads first, then the back in our preferred order.)
				return new Set(res.pick).size === 4 ? `team ${res.pick.map(i => i + 1).join('')}` : random();
			} catch {
				return random();
			}
		}
		const me = battle.sides[side]!.id as 'p1' | 'p2';
		if (req.forceSwitch) {
			if (this.opts.replacements !== 'search' || options.length <= 1) return healthiestSwitch(battle, side, options);
			const model = this.ensureModel(battle, side);
			const mine = battle.sides[side]!.pokemon;
			const replacements = options.map(choice => ({
				choice,
				slots: choice.split(', ').flatMap((part, slot) => {
					const m = /^switch (\d)$/.exec(part);
					const p = m ? mine[Number(m[1]) - 1] : undefined;
					return p ? [{ slot, set: p.set as PokemonSet, hp: p.hp, maxHp: p.maxhp, status: p.status }] : [];
				}),
			}));
			const res = chooseReplacementSync({ state: model.state, me, myTeam: mine.map(p => p.set as PokemonSet), model, replacements, options: { seed: Math.floor(this.rng() * 1e6), ...this.opts.solve } });
			return res.choice ?? healthiestSwitch(battle, side, options);
		}
		const model = this.ensureModel(battle, side);
		try {
			const res = solveTurn({
				state: model.state, me, myTeam: battle.sides[side]!.pokemon.map(p => p.set as PokemonSet), model,
				// We know our own Pokémon, whatever disguise the log shows.
				ownZoroark: battle.sides[side]!.active.map((p, slot) => ({ slot, isZoroark: !!p && p.baseSpecies.baseSpecies === 'Zoroark' })),
				options: { seed: Math.floor(this.rng() * 1e6), ...this.opts.solve },
			});
			this.last = res;
			this.timings.push(res.ms);
			let pick = res.options[0]!;
			if (this.opts.play !== 'best') {
				let r = this.rng();
				pick = res.options.find(o => (r -= o.p) <= 0) ?? pick;
			}
			const choice = translateChoice(res.reference, battle, side, pick.choice);
			return options.includes(choice) ? choice : random();
		} catch {
			return random();
		}
	}
}

/** Forced switch: bring in the healthiest option(s). */
export function healthiestSwitch(battle: Battle, side: SideIndex, options: string[]): string {
	const mons = battle.sides[side]!.pokemon;
	const score = (c: string) => [...c.matchAll(/switch (\d)/g)].reduce((s, m) => {
		const p = mons[Number(m[1]) - 1];
		return s + (p ? p.hp / p.maxhp : 0);
	}, 0);
	return options.reduce((best, c) => (score(c) > score(best) ? c : best), options[0]!);
}

/**
 * Baseline that cheats: copies the real battle (so it knows the opponent's sets) and picks the
 * option with the best average score over a few random replies, one turn ahead.
 */
export class OracleGreedyBot implements Policy {
	private rng: () => number;
	constructor(private replies = 3, seed = 3) { this.rng = makeRng(seed); }

	choose(battle: Battle, side: SideIndex, options: string[]): string {
		const req = sideRequest(battle, side);
		if (!req || req.teamPreview) return options[Math.floor(this.rng() * options.length)]!;
		if (req.forceSwitch) return healthiestSwitch(battle, side, options);
		const them = (1 - side) as SideIndex;
		const theirOptions = legalChoices(battle, them);
		if (!theirOptions.length) return options[0]!;
		const replies = Array.from({ length: this.replies }, () => theirOptions[Math.floor(this.rng() * theirOptions.length)]!);
		let best = options[0]!, bestV = -Infinity;
		for (const o of options) {
			let v = 0;
			for (const r of replies) {
				const b = cloneBattle(battle);
				const turn = b.turn;
				if (!submit(b, side, o) || !submit(b, them, r)) continue;
				let guard = 0;
				while (!b.ended && b.turn === turn && guard++ < 10) {
					for (const s of sidesNeedingChoice(b)) { const l = legalChoices(b, s); if (l.length) submit(b, s, l[0]!); }
				}
				v += evaluate(b, side);
			}
			if (v > bestV) { bestV = v; best = o; }
		}
		return best;
	}
}
