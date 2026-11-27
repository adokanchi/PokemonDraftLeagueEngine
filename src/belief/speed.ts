/**
 * Turn-order model: what speeds and priorities a Pokémon could act with, and how likely an
 * observed order ("A moved before B") is.
 *
 * Modifiers mirror Showdown's onModifyPriority / onModifySpe / onFractionalPriority handlers
 * (the full list in vendor/pokemon-showdown/data). Speeds are computed with Champions' stat
 * formula (base + 20 + stat points, then nature). Near-ties are treated as possible either way,
 * so the model never rules out an order the simulator could produce.
 */
import type { Move, Species } from '../showdown.js';
import type { SpreadEntry } from '../data/priors.js';

export interface SpeedContext {
	/** Speed boost stage (-6..6). */
	stage: number;
	tailwind: boolean;
	/** Grass Pledge + Water Pledge swamp on this side. */
	swamp: boolean;
	paralyzed: boolean;
	statused: boolean;
	weather?: string;
	terrain?: string;
	trickRoom: boolean;
	hpFull: boolean;
	/** Lost its item this battle (Unburden). */
	itemLost: boolean;
	/** Item it holds now when that's known from the log and may differ from its own (Trick etc.). */
	currentItem?: string;
}

export interface Actor {
	/** Possible (priority, speed) outcomes with probabilities. */
	points: { priority: number; speed: number; p: number }[];
}

export interface Holder {
	species: Species;
	/** Ability id -> probability. */
	abilities: Map<string, number>;
	/** Item id -> probability ('' = none). Use a single entry when known. */
	items: Map<string, number>;
	/** Speed spreads (or a single exact entry for our own Pokémon). */
	spreads: SpreadEntry[];
}

const stageMult = (s: number) => (s >= 0 ? (2 + s) / 2 : 2 / (2 - s));

function abilitySpeedMult(ability: string, ctx: SpeedContext): number {
	switch (ability) {
	case 'chlorophyll': return ctx.weather === 'sunnyday' || ctx.weather === 'desolateland' ? 2 : 1;
	case 'swiftswim': return ctx.weather === 'raindance' || ctx.weather === 'primordialsea' ? 2 : 1;
	case 'sandrush': return ctx.weather === 'sandstorm' ? 2 : 1;
	case 'slushrush': return ctx.weather === 'snowscape' || ctx.weather === 'hail' ? 2 : 1;
	case 'surgesurfer': return ctx.terrain === 'electricterrain' ? 2 : 1;
	case 'quickfeet': return ctx.statused ? 1.5 : 1;
	case 'unburden': return ctx.itemLost ? 2 : 1;
	// Can't tell from the log whether these are active; allow the boost.
	case 'protosynthesis': case 'quarkdrive': return 1.5;
	case 'slowstart': return 0.5;
	default: return 1;
	}
}

function itemSpeedMult(item: string): number {
	if (item === 'choicescarf') return 1.5;
	if (['ironball', 'machobrace', 'poweranklet', 'powerband', 'powerbelt', 'powerbracer', 'powerlens', 'powerweight'].includes(item)) return 0.5;
	return 1;
}

/** Move priority for a user with this ability (including fractional "moves last" effects). */
export function movePriority(move: Move, ability: string, item: string, ctx: SpeedContext, grounded = true): number {
	let pr = move.priority;
	if (ability === 'prankster' && move.category === 'Status') pr += 1;
	if (ability === 'galewings' && move.type === 'Flying' && ctx.hpFull) pr += 1;
	if (ability === 'triage' && move.flags.heal) pr += 3;
	if (move.id === 'grassyglide' && ctx.terrain === 'grassyterrain' && grounded) pr += 1;
	if (ability === 'stall') pr -= 0.1;
	if (ability === 'myceliummight' && move.category === 'Status') pr -= 0.1;
	if (['laggingtail', 'fullincense'].includes(item)) pr -= 0.1;
	return pr;
}

export function speedStat(species: Species, sp: number, nature: number): number {
	return Math.floor((species.baseStats.spe + 20 + sp) * nature);
}

/** All (priority, speed) outcomes for a holder using `move` in this context. */
export function actorFor(holder: Holder, move: Move, ctx: SpeedContext): Actor {
	const grouped = new Map<string, { priority: number; speed: number; p: number }>();
	const items = [...holder.items].map(([item, p]) => [item, itemSpeedMult(item), p] as const);
	// Collapse items to speed multipliers (most share 1x) but keep fractional-priority items apart.
	const itemGroups = new Map<string, { mult: number; item: string; p: number }>();
	for (const [item, mult, p] of items) {
		const key = ['laggingtail', 'fullincense'].includes(item) ? item : String(mult);
		const g = itemGroups.get(key) ?? { mult, item: key === item ? item : '', p: 0 };
		g.p += p;
		itemGroups.set(key, g);
	}
	const spreads = new Map<number, number>();
	for (const s of holder.spreads) {
		const stat = speedStat(holder.species, s.sp, s.nature);
		spreads.set(stat, (spreads.get(stat) ?? 0) + s.p);
	}
	for (const [ability, pa] of holder.abilities) {
		if (!pa) continue;
		const am = abilitySpeedMult(ability, ctx);
		for (const ig of itemGroups.values()) {
			if (!ig.p) continue;
			// Klutz: held items have no effect.
			const itemMult = ability === 'klutz' ? 1 : ig.mult;
			const priority = movePriority(move, ability, ability === 'klutz' ? '' : ig.item, ctx);
			for (const [stat, ps] of spreads) {
				let speed = Math.floor(stat * stageMult(ctx.stage));
				speed *= am * itemMult;
				if (ctx.tailwind) speed *= 2;
				if (ctx.swamp) speed *= 0.25;
				if (ctx.paralyzed && ability !== 'quickfeet') speed *= 0.5;
				speed = Math.floor(speed);
				const key = `${priority}:${speed}`;
				const g = grouped.get(key) ?? { priority, speed, p: 0 };
				g.p += pa * ig.p * ps;
				grouped.set(key, g);
			}
		}
	}
	return { points: [...grouped.values()] };
}

/**
 * Probability that `first` acts before `second` (same turn, consecutive actions).
 * Equal priority: faster first (slower under Trick Room). Speeds within 2 points count as
 * possible either way (rounding in Showdown's modifier chain, random speed ties).
 */
export function probOrder(first: Actor, second: Actor, trickRoom: boolean): number {
	const totalA = first.points.reduce((s, x) => s + x.p, 0);
	const totalB = second.points.reduce((s, x) => s + x.p, 0);
	if (!totalA || !totalB) return 1;
	const byPriority = new Map<number, { speed: number; p: number }[]>();
	for (const b of second.points) {
		const list = byPriority.get(b.priority) ?? [];
		list.push({ speed: b.speed, p: b.p });
		byPriority.set(b.priority, list);
	}
	const sorted = new Map<number, { speeds: number[]; cum: number[] }>();
	for (const [pr, list] of byPriority) {
		list.sort((x, y) => x.speed - y.speed);
		const cum: number[] = [];
		let c = 0;
		for (const x of list) { c += x.p; cum.push(c); }
		sorted.set(pr, { speeds: list.map(x => x.speed), cum });
	}
	const massBelow = (pr: number, limit: number) => { // P(second has priority pr and speed <= limit)
		const s = sorted.get(pr);
		if (!s) return 0;
		let lo = 0, hi = s.speeds.length;
		while (lo < hi) { const mid = (lo + hi) >> 1; if (s.speeds[mid]! <= limit) lo = mid + 1; else hi = mid; }
		return lo ? s.cum[lo - 1]! : 0;
	};
	const massOf = (pr: number) => { const s = sorted.get(pr); return s ? s.cum[s.cum.length - 1]! : 0; };
	const priorities = [...sorted.keys()];
	let ok = 0;
	for (const a of first.points) {
		let m = 0;
		for (const pr of priorities) {
			if (pr < a.priority) m += massOf(pr);
			else if (pr === a.priority) {
				m += trickRoom ? massOf(pr) - massBelow(pr, a.speed - 3) : massBelow(pr, a.speed + 2);
			}
		}
		ok += a.p * m;
	}
	return ok / (totalA * totalB);
}
