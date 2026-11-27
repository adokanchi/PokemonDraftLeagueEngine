/**
 * Opponent model: what each of their Pokémon's set probably is, from everything seen so far.
 *
 * For every species in their team preview we keep a pool of candidate full sets (moves,
 * ability, item, stat points, nature), built from Showdown's curated random-doubles sets and,
 * when available, Smogon usage stats. Candidates always respect the hard facts (revealed moves,
 * ability and item; item clause; drafted Mega stones; earlier games of the set) and are
 * weighted by soft evidence:
 *  - damage our attacks did to them, and theirs did to us (Showdown's own damage formula);
 *  - turn order against our Pokémon (their speed and priority).
 * Illusion is handled by the IllusionTracker: reveals are credited to Zoroark or to the shown
 * species only when it is clear which one it was.
 *
 * `sampleTeam()` draws a complete team of four consistent with all of it, for search.
 */
import { Teams, toID, type PokemonSet } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';
import { loadPrior, UniformPrior, type SetPrior } from '../data/priors.js';
import type { TeamKnowledge } from '../state/knowledge.js';
import type { MonState, SideId } from '../state/types.js';
import { IllusionTracker } from './illusion.js';
import { DamageCalc, type CombatantState } from './damage.js';
import { makeRng } from '../sim/play.js';
import { seedFromInt } from '../sim/battle.js';

/** Likelihood for evidence that doesn't fit a candidate (soft: our model of damage isn't perfect). */
const MISFIT = 0.05;
const CLEAR = 0.05; // P(Zoroark) below this = clearly the shown species; above 1 - CLEAR = clearly Zoroark

export interface Candidate {
	set: PokemonSet;
	/** Log-likelihood of the evidence so far. */
	logw: number;
	/** Prior weight (how common this kind of set is). */
	prior: number;
}

interface Facts {
	moves: Set<string>;
	ability?: string;
	item?: string;
}

interface HitObservation {
	kind: 'ourHit' | 'theirHit';
	/** Species (team forme) of the opponent Pokémon involved. */
	species: string;
	move: string;
	crit: boolean;
	spread: boolean;
	weather?: string;
	terrain?: string;
	/** Our Pokémon's set and state. */
	ours: CombatantState;
	/** Opponent Pokémon's state (set filled per candidate). */
	theirs: Omit<CombatantState, 'set'>;
	/** Observed HP lost, in % of max (theirs) or exact HP (ours, when known). */
	lost: number;
	lostExact: boolean;
	fainted: boolean;
	/** HP % before the hit (for Focus Sash / Sturdy). */
	beforePct: number;
}

export interface OpponentModelOptions {
	/** The opponent's side. */
	side: SideId;
	/** Our full team (all six sets; the ones we brought are matched by species). */
	ownTeam: PokemonSet[];
	format?: ResolvedFormat;
	prior?: SetPrior;
	knowledge?: TeamKnowledge;
	/** Their drafted Megas: team species -> Mega Stone. */
	megaStones?: Record<string, string>;
	/** Candidate sets kept per species. */
	poolSize?: number;
	seed?: number;
}

const STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;

export class OpponentModel {
	readonly illusion: IllusionTracker;
	readonly side: SideId;
	private format: ResolvedFormat;
	private prior: SetPrior;
	private uniform: UniformPrior;
	private calc: DamageCalc;
	private rng: () => number;
	private generator: { randomSet(species: string, teamDetails: object, isLead: boolean, isDoubles: boolean): PokemonSet };
	private facts = new Map<string, Facts>();
	private pools = new Map<string, Candidate[]>();
	private observations: HitObservation[] = [];
	private pendingMove?: { ident: string; side: SideId; move: string; spread: boolean; crits: Set<string>; snapshot: string };
	private poolSize: number;

	constructor(private opts: OpponentModelOptions) {
		this.side = opts.side;
		this.format = opts.format ?? resolveFormat();
		this.prior = opts.prior ?? loadPrior(this.format);
		this.uniform = this.prior instanceof UniformPrior ? this.prior : new UniformPrior(this.format);
		this.calc = new DamageCalc(this.format);
		this.rng = makeRng(opts.seed ?? 12345);
		this.poolSize = opts.poolSize ?? 48;
		this.generator = Teams.getGenerator('gen9championsrandomdoublesbattle', seedFromInt(opts.seed ?? 99) as never) as never;
		for (const [species, k] of Object.entries(opts.knowledge ?? {})) {
			this.facts.set(species, { moves: new Set(k.moves), ability: k.ability, item: k.item });
		}
		this.illusion = new IllusionTracker({
			side: opts.side, format: this.format, prior: this.prior, ownTeam: opts.ownTeam,
			knowledge: opts.knowledge, megaStones: opts.megaStones,
			onReveal: (e, slot, pZ) => this.onReveal(e.mon, e.type, e.type === 'ability' ? e.ability : e.type === 'item' ? e.item : e.move, pZ),
		});
	}

	get state() { return this.illusion.parser.state; }

	// ---- feeding ---------------------------------------------------------------------------------

	feedLog(text: string): this {
		for (const line of text.split('\n')) this.feed(line);
		return this;
	}

	private splitSide: SideId | null = null;
	private splitSkip = 0;

	feed(rawLine: string): void {
		const line = rawLine.replace(/\r$/, '');
		// Omniscient logs: only look at the line the parser will use (as IllusionTracker does).
		if (line.startsWith('|split|')) { this.splitSide = line.slice(7) as SideId; this.illusion.feed(line); return; }
		if (this.splitSide) {
			const keep = this.splitSide === this.illusion.parser.state.perspective;
			this.splitSide = null;
			this.splitSkip = keep ? 1 : 0;
			if (!keep) { this.illusion.feed(line); return; }
		} else if (this.splitSkip > 0) { this.splitSkip--; this.illusion.feed(line); return; }
		const parts = line.slice(1).split('|');
		const cmd = parts[0] ?? '';
		// Before the parser applies the line: remember the context of each move and HP before hits.
		let hitBefore: { mon: MonState; hp: number; maxHp: number } | undefined;
		if (cmd === 'move') {
			const user = this.monAt(parts[1]);
			this.pendingMove = user && !/\[from\]/.test(line) ? {
				ident: user.ident, side: user.side, move: parts[2] ?? '', spread: /\[spread\]/.test(line), crits: new Set(),
				snapshot: JSON.stringify(this.state),
			} : undefined;
		} else if (cmd === '-crit' && this.pendingMove && parts[1]) {
			this.pendingMove.crits.add(parts[1]);
		} else if (cmd === '-damage' && !/\[from\]/.test(line) && this.pendingMove) {
			const t = this.monAt(parts[1]);
			if (t && t.ident !== this.pendingMove.ident) hitBefore = { mon: t, hp: t.hp, maxHp: t.maxHp };
		} else if (cmd === 'turn' || cmd === 'upkeep') {
			this.pendingMove = undefined;
		}
		this.illusion.feed(line);
		if (hitBefore && this.pendingMove) this.recordHit(hitBefore, parts[1]!);
	}

	private monAt(pos: string | undefined): MonState | undefined {
		const m = /^(p[12])([ab]): /.exec(pos ?? '');
		if (!m) return undefined;
		const side = this.state.sides[m[1] as SideId];
		const ident = side.active['ab'.indexOf(m[2]!)];
		return side.pokemon.find(p => p.ident === ident);
	}

	private ownSetFor(mon: MonState): PokemonSet | undefined {
		const forme = this.teamForme(mon.teamSpecies);
		return this.opts.ownTeam.find(s => this.teamForme(s.species) === forme);
	}

	private teamForme(name: string): string {
		const sp = this.format.dex.species.get(name);
		if (typeof sp.battleOnly === 'string') return sp.battleOnly;
		if (Array.isArray(sp.battleOnly)) return sp.battleOnly[0]!;
		return sp.isMega ? sp.baseSpecies : sp.name;
	}

	/** Which species the opponent Pokémon in this slot is, if it's clear (Illusion). */
	private clearSpecies(mon: MonState): string | undefined {
		if (mon.activeSlot === null) return this.teamForme(mon.teamSpecies);
		const pz = this.illusion.slotZ(mon.activeSlot);
		const zoroark = this.illusion.report().zoroark;
		if (pz <= CLEAR) return this.teamForme(mon.teamSpecies);
		if (pz >= 1 - CLEAR && zoroark) return zoroark;
		return undefined;
	}

	private recordHit(before: { mon: MonState; hp: number; maxHp: number }, targetPos: string) {
		const pm = this.pendingMove!;
		const snap = JSON.parse(pm.snapshot) as typeof this.state;
		const target = before.mon;
		const attackerSide = pm.side;
		const find = (side: SideId, ident: string) => snap.sides[side].pokemon.find(p => p.ident === ident);
		const attacker = find(attackerSide, pm.ident);
		const defender = find(target.side, target.ident);
		if (!attacker || !defender || attacker.transformedInto || defender.transformedInto) return;
		const move = this.format.dex.moves.get(pm.move);
		if (!move.exists || move.category === 'Status' || move.damageCallback || move.ohko || move.multihit) return;
		const state = (m: MonState) => ({
			species: m.species, boosts: m.boosts, hpFraction: m.hp / m.maxHp, status: m.status,
			item: m.item.current === '' ? '' : m.item.swapped ? m.item.current : undefined,
			sideConditions: Object.keys(snap.sides[m.side].conditions),
		});
		const after = target.hp;
		const base = { move: move.id, crit: pm.crits.has(targetPos), spread: pm.spread, weather: snap.field.weather, terrain: snap.field.terrain, fainted: target.fainted || after === 0 };
		if (attackerSide !== this.side && target.side === this.side) {
			const ours = this.ownSetFor(attacker);
			const species = this.clearSpecies(target);
			if (!ours || !species || before.maxHp !== 100) return;
			this.addObservation({ ...base, kind: 'ourHit', species, ours: { set: ours, ...state(attacker) }, theirs: state(defender), lost: before.hp - after, lostExact: false, beforePct: before.hp });
		} else if (attackerSide === this.side && target.side !== this.side) {
			const ours = this.ownSetFor(target);
			const species = this.clearSpecies(attacker);
			if (!ours || !species) return;
			const exact = before.maxHp !== 100;
			this.addObservation({ ...base, kind: 'theirHit', species, ours: { set: ours, ...state(defender) }, theirs: state(attacker), lost: before.hp - after, lostExact: exact, beforePct: 100 * before.hp / before.maxHp });
		}
	}

	private addObservation(o: HitObservation) {
		this.observations.push(o);
		const pool = this.pools.get(o.species);
		if (pool) for (const c of pool) c.logw += Math.log(this.hitLikelihood(o, c.set));
	}

	private hitLikelihood(o: HitObservation, set: PokemonSet): number {
		try {
			const theirs = { ...o.theirs, set };
			const ctx = { crit: o.crit, spread: o.spread, weather: o.weather, terrain: o.terrain };
			const r = o.kind === 'ourHit' ? this.calc.range(o.ours, theirs, o.move, ctx) : this.calc.range(theirs, o.ours, o.move, ctx);
			if (r.immune) return MISFIT;
			const scale = o.lostExact ? 1 : 100 / r.maxHp;
			const lo = r.min * scale - (o.lostExact ? 1 : 1.5);
			const hi = r.max * scale + (o.lostExact ? 1 : 1.5);
			if (o.fainted) return hi >= o.lost ? 1 : MISFIT;
			if (o.lost >= lo && o.lost <= hi) return 1;
			// Survived a hit that should have KO'd from full: Focus Sash / Sturdy.
			if (o.kind === 'ourHit' && o.beforePct >= 100 && o.lost >= 98 && (toID(set.item) === 'focussash' || toID(set.ability) === 'sturdy')) return 1;
			return MISFIT;
		} catch {
			return 1;
		}
	}

	// ---- hard facts --------------------------------------------------------------------------------

	private onReveal(mon: MonState, type: 'ability' | 'item' | 'move', value: string, pZ: number) {
		let species: string | undefined;
		const zoroark = this.illusion.report().zoroark;
		if (pZ <= CLEAR) species = this.teamForme(mon.teamSpecies);
		else if (pZ >= 1 - CLEAR && zoroark) species = zoroark;
		if (!species || !value) return;
		const f = this.factsFor(species);
		const dex = this.format.dex;
		let changed = false;
		if (type === 'move' && !f.moves.has(value) && f.moves.size < 4) { f.moves.add(value); changed = true; }
		if (type === 'ability' && !f.ability && !mon.megaEvolved && !mon.abilityChanged && dex.species.get(species).abilities) {
			const legal = Object.values(dex.species.get(species).abilities).map(a => toID(a as string));
			if (legal.includes(value)) { f.ability = value; changed = true; }
		}
		if (type === 'item' && f.item === undefined && !mon.item.swapped) {
			// The first item seen on a Pokémon is the one it brought, unless it was tricked.
			if (!dex.items.get(value).megaStone || this.opts.megaStones?.[species]) { f.item = value; changed = true; }
		}
		if (changed) this.refreshPool(species, type === 'item');
	}

	private factsFor(species: string): Facts {
		let f = this.facts.get(species);
		if (!f) { f = { moves: new Set() }; this.facts.set(species, f); }
		return f;
	}

	/** Items known to be on other team members (item clause). */
	private takenItems(except: string): Set<string> {
		const out = new Set<string>();
		for (const [species, f] of this.facts) if (species !== except && f.item) out.add(f.item);
		for (const [species, stone] of Object.entries(this.opts.megaStones ?? {})) if (species !== except) out.add(toID(stone));
		return out;
	}

	private refreshPool(species: string, itemChanged: boolean) {
		if (this.pools.has(species)) this.pools.delete(species);
		// Item clause: a newly known item invalidates other species' candidates holding it.
		if (itemChanged) for (const s of [...this.pools.keys()]) if (s !== species) this.pools.delete(s);
	}

	// ---- candidates -------------------------------------------------------------------------------

	private spreadFor(set: PokemonSet, species: string): { nature: string; evs: PokemonSet['evs'] } {
		const usage = this.prior.fullSpreads(species);
		if (usage.length && this.rng() < 0.8) {
			let r = this.rng();
			for (const s of usage) { r -= s.p; if (r <= 0) return { nature: s.nature, evs: { ...s.sp } }; }
		}
		const dex = this.format.dex;
		const moves = set.moves.map(m => dex.moves.get(m));
		const phys = moves.filter(m => m.category === 'Physical').length;
		const spec = moves.filter(m => m.category === 'Special').length;
		const sp = dex.species.get(species);
		const trickRoom = moves.some(m => m.id === 'trickroom') || sp.baseStats.spe < 50;
		const zero = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
		const atk = phys >= spec ? 'atk' : 'spa';
		const r = this.rng();
		if (phys + spec <= 1) {
			const nat = r < 0.5 ? (atk === 'atk' ? 'Impish' : 'Bold') : (atk === 'atk' ? 'Careful' : 'Calm');
			return { nature: nat, evs: { ...zero, hp: 32, def: 17, spd: 17 } };
		}
		if (trickRoom && r < 0.7) return { nature: atk === 'atk' ? 'Brave' : 'Quiet', evs: { ...zero, hp: 32, [atk]: 32, def: 2 } };
		if (r < 0.55) {
			const fast = this.rng() < 0.5;
			return { nature: atk === 'atk' ? (fast ? 'Jolly' : 'Adamant') : (fast ? 'Timid' : 'Modest'), evs: { ...zero, hp: 2, [atk]: 32, spe: 32 } };
		}
		return { nature: atk === 'atk' ? 'Adamant' : 'Modest', evs: { ...zero, hp: 32, [atk]: 32, spd: 2 } };
	}

	private sampleFromUsage(species: string): PokemonSet | undefined {
		if (!this.prior.hasUsage) return undefined;
		const pick = (m: Map<string, number>) => { let r = this.rng(); for (const [k, p] of m) { r -= p; if (r <= 0) return k; } return [...m.keys()][0]; };
		const ability = pick(this.prior.abilityProbs(species)) ?? '';
		const item = pick(this.prior.itemProbs(species)) ?? '';
		const learn = [...this.uniform.learnset(species)].map(m => [m, this.prior.moveInclusion(species, m)] as const).filter(([, p]) => p > 0);
		const moves: string[] = [];
		while (moves.length < 4 && learn.length) {
			const total = learn.reduce((s, [, p]) => s + p, 0);
			let r = this.rng() * total;
			const i = learn.findIndex(([, p]) => (r -= p) <= 0);
			moves.push(learn[i < 0 ? 0 : i]![0]);
			learn.splice(i < 0 ? 0 : i, 1);
		}
		return { name: species, species, item, ability, moves, nature: 'Hardy', gender: '', level: 50, evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } } as PokemonSet;
	}

	private sampleFromGenerator(species: string): PokemonSet | undefined {
		const stone = this.opts.megaStones?.[species];
		const key = stone ? this.format.dex.items.get(stone).megaStone?.[species] ?? species : species;
		try { return this.generator.randomSet(key, {}, false, true); } catch { return undefined; }
	}

	private makeCandidate(species: string): PokemonSet | undefined {
		const base = (this.prior.hasUsage && this.rng() < 0.7 ? this.sampleFromUsage(species) : undefined) ?? this.sampleFromGenerator(species) ?? this.sampleFromUsage(species);
		if (!base) return undefined;
		const f = this.factsFor(species);
		const dex = this.format.dex;
		const taken = this.takenItems(species);
		const stone = this.opts.megaStones?.[species];
		let item = f.item ?? (stone ? toID(stone) : toID(base.item));
		if (!f.item && !stone && (taken.has(item) || dex.items.get(item).megaStone)) {
			const options = [...this.prior.itemProbs(species)].filter(([i]) => !taken.has(i) && !dex.items.get(i).megaStone);
			let r = this.rng() * options.reduce((s, [, p]) => s + p, 0);
			item = options.find(([, p]) => (r -= p) <= 0)?.[0] ?? '';
		}
		const known = [...f.moves];
		const moves = [...known];
		for (const m of base.moves.map(toID)) if (moves.length < 4 && !moves.includes(m)) moves.push(m);
		const ability = f.ability ?? toID(base.ability);
		const set: PokemonSet = { ...base, name: species, species, item, ability, moves, level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } } as PokemonSet;
		const spread = this.spreadFor(set, species);
		set.nature = spread.nature;
		set.evs = spread.evs;
		return set;
	}

	/** Candidate sets for a species, weighted by the evidence (built on demand). */
	pool(species: string): Candidate[] {
		let pool = this.pools.get(species);
		if (pool) return pool;
		pool = [];
		const seen = new Map<string, Candidate>();
		for (let i = 0; i < this.poolSize * 3 && seen.size < this.poolSize; i++) {
			const set = this.makeCandidate(species);
			if (!set) break;
			const key = JSON.stringify([set.moves.slice().sort(), set.ability, set.item, set.nature, STAT_IDS.map(s => set.evs[s])]);
			const existing = seen.get(key);
			if (existing) { existing.prior++; continue; }
			const c: Candidate = { set, logw: 0, prior: 1 };
			for (const o of this.observations) if (o.species === species) c.logw += Math.log(this.hitLikelihood(o, set));
			seen.set(key, c);
		}
		pool = [...seen.values()];
		this.pools.set(species, pool);
		return pool;
	}

	/** Normalised posterior over a species' candidate sets. */
	posterior(species: string): { set: PokemonSet; p: number }[] {
		const pool = this.pool(species);
		const max = Math.max(...pool.map(c => c.logw));
		const ws = pool.map(c => c.prior * Math.exp(c.logw - max));
		const total = ws.reduce((a, b) => a + b, 0) || 1;
		return pool.map((c, i) => ({ set: c.set, p: ws[i]! / total })).sort((a, b) => b.p - a.p);
	}

	private drawSet(species: string, avoidItems: Set<string>): PokemonSet | undefined {
		const post = this.posterior(species);
		for (let attempt = 0; attempt < 30; attempt++) {
			let r = this.rng();
			const pick = post.find(x => (r -= x.p) <= 0) ?? post[0];
			if (!pick) return undefined;
			if (!pick.set.item || !avoidItems.has(toID(pick.set.item))) return pick.set;
		}
		// Still clashing (item clause): keep the set but give it the likeliest free item,
		// unless its item is a known fact.
		const set = post[0]?.set;
		if (!set || this.factsFor(species).item || this.opts.megaStones?.[species]) return set;
		const dex = this.format.dex;
		const free = [...this.prior.itemProbs(species)].filter(([i]) => i && !avoidItems.has(i) && !dex.items.get(i).megaStone).sort((a, b) => b[1] - a[1]);
		return { ...set, item: free[0]?.[0] ?? '' };
	}

	// ---- sampling a full team ---------------------------------------------------------------------

	/**
	 * A complete guess at the four they brought, consistent with the log. `zoroarkIdent`, when
	 * set, names the Pokémon on the field that is (in this sample) Zoroark in disguise.
	 */
	sampleTeam(): { sets: PokemonSet[]; zoroarkIdent?: string } {
		const side = this.state.sides[this.side];
		const report = this.illusion.report();
		const zoroark = report.zoroark;
		const brought: string[] = [];
		let zoroarkIdent: string | undefined;
		// A disguised Zoroark on the field, per the Illusion posterior.
		for (const s of report.slots) {
			if (!zoroark || !s.shown || zoroarkIdent) continue;
			if (this.rng() < s.pZoroark) {
				const ident = side.active[s.slot];
				const mon = side.pokemon.find(p => p.ident === ident);
				if (mon && this.teamForme(mon.species) !== zoroark) zoroarkIdent = ident ?? undefined;
				brought.push(zoroark);
			}
		}
		for (const m of side.pokemon) {
			if (!m.seen || m.ident.endsWith('#illusion')) continue;
			const sp = this.teamForme(m.teamSpecies);
			if (!brought.includes(sp)) brought.push(sp);
		}
		const preview = side.preview.map(s => this.teamForme(s));
		const unseen = preview.filter(s => !brought.includes(s));
		const pick = Math.min(4, side.teamSize ?? 4);
		// Zoroark not seen in this sample: include it with its posterior chance of being brought.
		if (zoroark && !brought.includes(zoroark) && brought.length < pick) {
			const pSeenSlots = report.slots.reduce((s, x) => s + x.pZoroark, 0);
			const pBack = Math.max(0, report.pBrought - pSeenSlots) / Math.max(1e-9, 1 - pSeenSlots);
			if (this.rng() < pBack) brought.push(zoroark);
		}
		const rest = unseen.filter(s => s !== zoroark);
		while (brought.length < pick && rest.length) {
			const i = Math.floor(this.rng() * rest.length);
			brought.push(rest.splice(i, 1)[0]!);
		}
		const sets: PokemonSet[] = [];
		const used = new Set<string>();
		for (const species of brought.slice(0, pick)) {
			const set = this.drawSet(species, used);
			if (!set) continue;
			if (set.item) used.add(toID(set.item));
			sets.push(set);
		}
		return { sets, zoroarkIdent };
	}

	/** Most likely sets per species seen so far (for display). */
	summary(top = 3): Record<string, { set: PokemonSet; p: number }[]> {
		const out: Record<string, { set: PokemonSet; p: number }[]> = {};
		for (const species of this.state.sides[this.side].preview.map(s => this.teamForme(s))) out[species] = this.posterior(species).slice(0, top);
		return out;
	}

	factsSummary(): Record<string, { moves: string[]; ability?: string; item?: string }> {
		const out: Record<string, { moves: string[]; ability?: string; item?: string }> = {};
		for (const [s, f] of this.facts) out[s] = { moves: [...f.moves], ability: f.ability, item: f.item };
		return out;
	}
}
