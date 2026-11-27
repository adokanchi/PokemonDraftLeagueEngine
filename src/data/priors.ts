/**
 * Prior beliefs about opponents' sets: abilities, items, moves and speed spreads per species.
 *
 * Two sources:
 *  - UniformPrior: built only from Showdown's legality data (always available).
 *  - UsagePrior: Smogon usage stats ("chaos" JSON, downloaded with `npm run fetch-usage`),
 *    blended with the uniform prior so every legal option keeps some probability (draft coaches
 *    run things ladder players don't).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TeamValidator, toID } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';

export interface SpreadEntry {
	/** Stat points in Speed (0–32). */
	sp: number;
	/** Nature multiplier on Speed: 1.1, 1 or 0.9. */
	nature: number;
	p: number;
}

export interface SetPrior {
	readonly source: string;
	/** Ability id -> probability (sums to 1). */
	abilityProbs(species: string): Map<string, number>;
	/** Item id -> probability (sums to 1; '' = no item). */
	itemProbs(species: string): Map<string, number>;
	/** Probability that this move is one of the Pokémon's four. 0 if it can't learn it. */
	moveInclusion(species: string, move: string): number;
	canLearn(species: string, move: string): boolean;
	speedSpreads(species: string): SpreadEntry[];
}

/** Fallback speed investment when there's no data: mostly 0 or 32 points, some in between. */
function defaultSpeedSpreads(): SpreadEntry[] {
	const natures: [number, number][] = [[1.1, 0.3], [1, 0.5], [0.9, 0.2]];
	const out: SpreadEntry[] = [];
	for (const [nature, pn] of natures) {
		for (let sp = 0; sp <= 32; sp++) {
			const psp = sp === 0 ? 0.35 : sp === 32 ? 0.4 : 0.25 / 31;
			out.push({ sp, nature, p: pn * psp });
		}
	}
	return out;
}

export class UniformPrior implements SetPrior {
	readonly source = 'uniform (no usage data)';
	private learnable = new Map<string, Set<string>>();
	private validator: TeamValidator;
	private legalItems: string[];
	private legalMoves: string[];

	constructor(readonly format: ResolvedFormat = resolveFormat()) {
		this.validator = TeamValidator.get(format.formatId);
		const dex = format.dex;
		this.legalItems = dex.items.all().filter(i => i.exists && !i.isNonstandard && !i.megaStone).map(i => i.id);
		this.legalMoves = dex.moves.all().filter(m => m.exists && !m.isNonstandard && !m.isZ && !m.isMax).map(m => m.id);
	}

	learnset(species: string): Set<string> {
		const id = toID(species);
		let set = this.learnable.get(id);
		if (!set) {
			const sp = this.format.dex.species.get(species);
			set = new Set(this.legalMoves.filter(m => this.validator.checkCanLearn(this.format.dex.moves.get(m), sp) === null));
			this.learnable.set(id, set);
		}
		return set;
	}

	canLearn(species: string, move: string): boolean {
		return this.learnset(species).has(toID(move));
	}

	abilityProbs(species: string): Map<string, number> {
		const sp = this.format.dex.species.get(species);
		const abilities = [...new Set(Object.values(sp.abilities).map(a => toID(a as string)))]
			.filter(a => { const ab = this.format.dex.abilities.get(a); return ab.exists && !ab.isNonstandard; });
		return new Map(abilities.map(a => [a, 1 / abilities.length]));
	}

	itemProbs(_species: string): Map<string, number> {
		return new Map(this.legalItems.map(i => [i, 1 / this.legalItems.length]));
	}

	moveInclusion(species: string, move: string): number {
		const ls = this.learnset(species);
		if (!ls.has(toID(move))) return 0;
		return Math.min(1, 4 / ls.size);
	}

	speedSpreads(_species: string): SpreadEntry[] {
		return defaultSpeedSpreads();
	}
}

interface ChaosMon {
	'Raw count'?: number;
	Abilities?: Record<string, number>;
	Items?: Record<string, number>;
	Moves?: Record<string, number>;
	Spreads?: Record<string, number>;
}

/** Usage-based prior with an open-world floor of `floor` (share of probability kept uniform). */
export class UsagePrior implements SetPrior {
	readonly source: string;
	private data: Record<string, ChaosMon>;
	private byId = new Map<string, ChaosMon>();

	constructor(chaosJson: { info?: Record<string, unknown>; data: Record<string, ChaosMon> }, readonly base: UniformPrior,
		private floor = 0.03, sourceName = 'usage stats') {
		this.data = chaosJson.data;
		for (const [name, mon] of Object.entries(this.data)) this.byId.set(toID(name), mon);
		this.source = sourceName;
	}

	private mon(species: string): ChaosMon | undefined {
		return this.byId.get(toID(species));
	}

	private blend(usage: Record<string, number> | undefined, uniform: Map<string, number>): Map<string, number> {
		if (!usage) return uniform;
		const total = Object.values(usage).reduce((a, b) => a + b, 0);
		if (!total) return uniform;
		const out = new Map<string, number>();
		for (const [k, v] of uniform) out.set(k, this.floor * v);
		for (const [rawK, w] of Object.entries(usage)) {
			const k = rawK === 'nothing' ? '' : toID(rawK);
			if (!uniform.has(k) && k !== '') continue; // not legal any more
			out.set(k, (out.get(k) ?? 0) + (1 - this.floor) * (w / total));
		}
		const sum = [...out.values()].reduce((a, b) => a + b, 0);
		for (const [k, v] of out) out.set(k, v / sum);
		return out;
	}

	canLearn(species: string, move: string) { return this.base.canLearn(species, move); }

	abilityProbs(species: string) { return this.blend(this.mon(species)?.Abilities, this.base.abilityProbs(species)); }

	itemProbs(species: string) {
		const uniform = new Map(this.base.itemProbs(species));
		uniform.set('', 1 / (uniform.size + 1));
		return this.blend(this.mon(species)?.Items, uniform);
	}

	moveInclusion(species: string, move: string): number {
		const uni = this.base.moveInclusion(species, move);
		if (!uni) return 0;
		const mon = this.mon(species);
		const raw = mon?.['Raw count'] ?? 0;
		const total = mon?.Abilities ? Object.values(mon.Abilities).reduce((a, b) => a + b, 0) : 0;
		if (!mon?.Moves || !total || !raw) return uni;
		const w = mon.Moves[toID(move)] ?? 0;
		return Math.min(1, (1 - this.floor) * (w / total) + this.floor * uni);
	}

	speedSpreads(species: string): SpreadEntry[] {
		const spreads = this.mon(species)?.Spreads;
		if (!spreads) return this.base.speedSpreads(species);
		const agg = new Map<string, SpreadEntry>();
		let total = 0;
		for (const [key, w] of Object.entries(spreads)) {
			const m = /^(\w+):([\d/]+)$/.exec(key);
			if (!m) continue;
			const nature = this.base.format.dex.natures.get(m[1]!);
			const stats = m[2]!.split('/').map(Number);
			let sp = stats[5] ?? 0;
			if (stats.some(s => s > 32)) sp = Math.floor(sp / 8); // EV-scale data
			const mult = nature.plus === 'spe' ? 1.1 : nature.minus === 'spe' ? 0.9 : 1;
			const k = `${sp}:${mult}`;
			const e = agg.get(k) ?? { sp, nature: mult, p: 0 };
			e.p += w;
			total += w;
			agg.set(k, e);
		}
		if (!total) return this.base.speedSpreads(species);
		const usage = [...agg.values()].map(e => ({ ...e, p: (1 - this.floor) * e.p / total }));
		const fallback = this.base.speedSpreads(species).map(e => ({ ...e, p: this.floor * e.p }));
		return [...usage, ...fallback];
	}
}

/** Directory where `npm run fetch-usage` stores Smogon usage files. */
export const USAGE_DIR = join(process.cwd(), 'data', 'usage');

/** Usage prior from the newest downloaded stats for the format, else the uniform prior. */
export function loadPrior(format: ResolvedFormat = resolveFormat(), dir = USAGE_DIR): SetPrior {
	const base = new UniformPrior(format);
	if (!existsSync(dir)) return base;
	const files = readdirSync(dir).filter(f => f.startsWith(format.formatId) && f.endsWith('.json')).sort();
	const newest = files.at(-1);
	if (!newest) return base;
	const json = JSON.parse(readFileSync(join(dir, newest), 'utf8'));
	return new UsagePrior(json, base, 0.03, `usage stats (${newest})`);
}
