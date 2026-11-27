/**
 * Illusion inference: for each opposing Pokémon on the field, how likely is it to be a disguised
 * Zoroark / Zoroark-Hisui?
 *
 * Exact Bayesian bookkeeping over the hidden structure, following Showdown's Illusion rules:
 *  - which 4 of the 6 at team preview were brought, and in what order (360 possibilities);
 *  - which benched Pokémon came in at each switch;
 *  - Showdown's disguise rule: on switch-in, Zoroark copies the last non-fainted party member
 *    after its own position (vendor/pokemon-showdown/data/abilities.ts, `illusion`).
 * Each hypothesis that reproduces what was shown survives, weighted by the evidence seen while
 * each Pokémon was out:
 *  - moves it can't learn (certain), or rarely runs (graded by usage priors);
 *  - abilities revealed (a Zoroark only has Illusion), or a switch-in with no ability message
 *    from a species whose abilities always announce (Tyranitar: Sand Stream / Unnerve);
 *  - turn order vs possible speeds and priority (Prankster Taunt moving after a +0 move;
 *    Torkoal outspeeding Sneasler);
 *  - type immunities to our moves, and sandstorm chip;
 *  - HP/status that doesn't match how that Pokémon last left the field;
 *  - items (item clause, known items from earlier games, drafted Mega stones);
 *  - Mega Evolution, or taking an attack without the disguise breaking (both prove it's real).
 */
import { toID, type Move, type PokemonSet, type Species } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';
import { BattleLogParser, type ParserEvent } from '../state/parser.js';
import type { MonState, SideId } from '../state/types.js';
import type { TeamKnowledge } from '../state/knowledge.js';
import { loadPrior, type SetPrior } from '../data/priors.js';
import { switchInAnnouncements, type AnnounceInfo } from './announce.js';
import { actorFor, probOrder, type Actor, type Holder, type SpeedContext } from './speed.js';

/** Likelihood used for "the model says this can't happen" (kept above 0 so a model gap can't wipe everything). */
export const HARD = 1e-6;
const SAND_IMMUNE_ABILITIES = new Set(['overcoat', 'sandveil', 'sandrush', 'sandforce', 'magicguard']);
/** Effects that move an action out of normal priority/speed order for the rest of the turn. */
const ORDER_DISRUPTORS = /(item: Quick Claw|ability: Quick Draw|move: After You|move: Quash|move: Instruct|item: Custap Berry|^\|-waiting\||^\|-combine)/;

interface Phys {
	species: string;
	isZ: boolean;
	fainted: boolean;
	everActive: boolean;
	/** Number of times it has entered the field. */
	entries: number;
	hp?: number;
	status?: string;
	/** Item it brought ('' = none), if known in this hypothesis. */
	item?: string;
	ability?: string;
	moves: string[];
}

interface Hyp {
	w: number;
	/** order[position] = index into phys. Positions 0/1 are the active slots, as in Showdown. */
	order: number[];
	phys: Phys[];
	disguised: boolean[];
	stintZ: Map<number, boolean>;
	/** Which physical Pokémon performed each recorded action (action id -> phys index). */
	actorPhys: Map<number, number>;
}

interface Window {
	slot: number;
	revealed: boolean;
	weatherStart?: string;
	terrainStart?: string;
}

interface Action {
	id: number;
	side: SideId;
	slot: number;
	move: Move;
	ctx: SpeedContext;
	/** Speed context of every active Pokémon when this action started ("side:slot" keys). */
	ctxAll: Map<string, SpeedContext>;
	/** Parser's current species for that slot (Mega forme etc.). */
	shownSpecies: string;
	ident: string;
}

export interface IllusionOptions {
	/** Side to analyse (the opponent). */
	side: SideId;
	format?: ResolvedFormat;
	prior?: SetPrior;
	/** Full sets of the other side (yours): exact speeds, abilities, items. */
	ownTeam?: PokemonSet[];
	/** What earlier games of the set revealed about the analysed side. */
	knowledge?: TeamKnowledge;
	/** Drafted Megas on the analysed side: team species -> Mega Stone. */
	megaStones?: Record<string, string>;
}

export interface SlotReport {
	slot: number;
	shown?: string;
	/** Probability the Pokémon in this slot is Zoroark (disguised or not). */
	pZoroark: number;
}

export interface IllusionReport {
	/** The Zoroark species in their team preview, if any. */
	zoroark?: string;
	/** Probability Zoroark was brought this game. */
	pBrought: number;
	slots: SlotReport[];
	hypotheses: number;
	warnings: string[];
}

function parseLine(line: string) {
	const parts = line.slice(1).split('|');
	const cmd = parts[0] ?? '';
	const args: string[] = [];
	const tags: Record<string, string> = {};
	for (const p of parts.slice(1)) {
		const m = /^\[(\w+)\]\s?(.*)$/.exec(p);
		if (m) tags[m[1]!] = m[2] ?? '';
		else args.push(p);
	}
	return { cmd, args, tags };
}

function posOf(s: string | undefined): { side: SideId; slot: number | null } | null {
	const m = /^(p[12])([ab]?):/.exec(s ?? '');
	if (!m) return null;
	return { side: m[1] as SideId, slot: m[2] ? 'ab'.indexOf(m[2]) : null };
}

const speciesOfDetails = (d: string | undefined) => (d ?? '').split(', ')[0] ?? '';

function hpOf(hp: string | undefined): { hp: number; status: string } {
	const [h, st] = (hp ?? '100/100').split(' ');
	const m = /^(\d+)(?:\/(\d+))?/.exec(h ?? '');
	const cur = m ? Number(m[1]) : 100;
	const max = m?.[2] ? Number(m[2]) : 100;
	return { hp: Math.floor((100 * cur) / max) || (cur > 0 ? 1 : 0), status: st && st !== 'fnt' ? st : '' };
}

export class IllusionTracker {
	readonly parser: BattleLogParser;
	readonly side: SideId;
	private format: ResolvedFormat;
	private prior: SetPrior;
	private announce: Map<string, AnnounceInfo>;
	private hyps: Hyp[] = [];
	private inert = false;
	private initialized = false;
	private preview: string[] = [];
	private zIndex = -1;
	private stint = 0;
	private slotStint: number[] = [-1, -1];
	private windows: Window[] = [];
	private pendingDamage = new Set<number>();
	private sandHit = new Set<number>();
	private lastMove?: { side: SideId; slot: number | null; ident: string; move: Move };
	private turnActions: (Action | null)[] = [];
	private orderBroken = false;
	private actorCache = new Map<string, Actor>();
	readonly warnings: string[] = [];

	constructor(private opts: IllusionOptions) {
		this.side = opts.side;
		this.format = opts.format ?? resolveFormat();
		this.prior = opts.prior ?? loadPrior(this.format);
		this.announce = switchInAnnouncements(this.format);
		const other: SideId = opts.side === 'p1' ? 'p2' : 'p1';
		this.perspective = opts.ownTeam ? other : undefined;
		this.parser = new BattleLogParser({
			format: this.format, perspective: this.perspective,
			onEvent: e => this.pendingEvents.push(e),
		});
	}

	private perspective?: SideId;
	private pendingEvents: ParserEvent[] = [];
	private splitSide: SideId | null = null;
	private splitSkip = 0;

	feedLog(text: string): this {
		for (const line of text.split('\n')) this.feed(line);
		return this;
	}

	/** Feed one protocol line. Handles |split| sections like the parser does. */
	feed(rawLine: string): void {
		const line = rawLine.replace(/\r$/, '');
		if (this.splitSide) {
			const side = this.splitSide;
			this.splitSide = null;
			if (side === this.perspective) { this.splitSkip = 1; this.feedOne(line); } else { this.splitSkip = 0; }
			return;
		}
		if (this.splitSkip > 0) { this.splitSkip--; return; }
		if (line.startsWith('|split|')) { this.splitSide = line.slice(7) as SideId; return; }
		this.feedOne(line);
	}

	// ---- helpers -------------------------------------------------------------------------------

	private get st() { return this.parser.state; }
	private get mySide() { return this.st.sides[this.side]; }
	private activeMon(side: SideId, slot: number): MonState | undefined {
		const s = this.st.sides[side];
		return s.pokemon.find(p => p.ident === s.active[slot]);
	}
	private speciesData(name: string): Species { return this.format.dex.species.get(name); }

	private trueSpecies(h: Hyp, slot: number): string {
		const p = h.phys[h.order[slot]!]!;
		if (p.isZ) return p.species;
		// Real: use the current forme the log shows (Mega etc.), if it's the same Pokémon.
		const shown = this.activeMon(this.side, slot)?.species;
		if (shown && this.speciesData(shown).baseSpecies === this.speciesData(p.species).baseSpecies) return shown;
		return p.species;
	}

	private lastAliveAfter(h: Hyp, pos: number): Phys | undefined {
		for (let i = h.order.length - 1; i > pos; i--) {
			const p = h.phys[h.order[i]!]!;
			if (!p.fainted) return p;
		}
		return undefined;
	}

	/**
	 * Team forme of a shown species: in-battle formes (Mega, Palafin-Hero, Mimikyu-Busted, ...)
	 * show up in switch-in details after the change.
	 */
	private teamForme(name: string): string {
		const sp = this.speciesData(name);
		if (typeof sp.battleOnly === 'string') return sp.battleOnly;
		if (Array.isArray(sp.battleOnly)) return sp.battleOnly[0]!;
		return sp.isMega ? sp.baseSpecies : sp.name;
	}

	private sameSpecies(a: string, b: string) {
		return toID(a) === toID(b) || this.teamForme(a) === this.teamForme(b);
	}

	private clone(h: Hyp): Hyp {
		return {
			w: h.w, order: [...h.order], disguised: [...h.disguised], stintZ: new Map(h.stintZ), actorPhys: new Map(h.actorPhys),
			phys: h.phys.map(p => ({ ...p, moves: [...p.moves] })),
		};
	}

	/** Apply a likelihood to every hypothesis; on total contradiction keep the old ones. */
	private update(fn: (h: Hyp) => number, what: string) {
		if (this.inert || !this.initialized) return;
		const before = this.hyps.map(h => h.w);
		let total = 0;
		for (const h of this.hyps) { h.w *= fn(h); total += h.w; }
		if (!(total > 0)) {
			this.hyps.forEach((h, i) => { h.w = before[i]!; });
			this.warnings.push(`turn ${this.st.turn}: ignored contradictory evidence (${what})`);
			return;
		}
		this.normalize();
	}

	private normalize() {
		const total = this.hyps.reduce((s, h) => s + h.w, 0);
		if (!(total > 0)) return;
		const max = Math.max(...this.hyps.map(h => h.w));
		this.hyps = this.hyps.filter(h => h.w > max * 1e-12);
		const t2 = this.hyps.reduce((s, h) => s + h.w, 0);
		for (const h of this.hyps) h.w /= t2;
		if (this.hyps.length > 20000) {
			this.hyps.sort((a, b) => b.w - a.w);
			this.hyps = this.hyps.slice(0, 20000);
		}
	}

	// ---- initialisation ------------------------------------------------------------------------

	private init() {
		this.initialized = true;
		this.preview = [...this.mySide.preview];
		this.zIndex = this.preview.findIndex(s => this.speciesData(s).baseSpecies === 'Zoroark');
		if (this.zIndex < 0 || this.preview.length < 4) { this.inert = true; return; }
		const k = this.opts.knowledge ?? {};
		const template: Phys[] = this.preview.map((species, i) => {
			const known = k[species];
			const stone = this.opts.megaStones?.[species];
			return {
				species, isZ: i === this.zIndex, fainted: false, everActive: false, entries: 0,
				item: known?.item ?? (stone ? toID(stone) : undefined),
				ability: known?.ability,
				moves: [...(known?.moves ?? [])],
			};
		});
		const n = this.preview.length;
		const pick = Math.min(4, this.mySide.teamSize ?? 4);
		const rec = (chosen: number[]) => {
			if (chosen.length === pick) {
				this.hyps.push({
					w: 1, order: chosen.map((_, i) => i), disguised: [false, false], stintZ: new Map(), actorPhys: new Map(),
					phys: chosen.map(i => ({ ...template[i]!, moves: [...template[i]!.moves] })),
				});
				return;
			}
			for (let i = 0; i < n; i++) if (!chosen.includes(i)) rec([...chosen, i]);
		};
		rec([]);
		this.normalize();
	}

	// ---- structural events ---------------------------------------------------------------------

	private shownOk(h: Hyp, slot: number, shown: string): boolean {
		const p = h.phys[h.order[slot]!]!;
		if (!p.isZ) return this.sameSpecies(p.species, shown);
		const target = this.lastAliveAfter(h, slot);
		h.disguised[slot] = !!target;
		return this.sameSpecies(target ? target.species : p.species, shown);
	}

	private continuity(h: Hyp, p: Phys, hp: number, status: string): number {
		let l = 1;
		if (p.hp !== undefined) {
			if (hp < p.hp - 1) l *= HARD;
			else if (hp > p.hp + 1) {
				const regen = Math.abs(hp - Math.min(100, p.hp + 33)) <= 2;
				l *= regen ? Math.max(HARD, this.abilityProb(p, 'regenerator')) : HARD;
			}
		}
		if (p.status !== undefined && p.status !== status) {
			if (p.status && !status) l *= Math.max(HARD, this.abilityProb(p, 'naturalcure'));
			else if (!(p.status === 'tox' && status === 'psn')) l *= HARD;
		}
		return l;
	}

	private abilityProb(p: Phys, ability: string): number {
		if (p.isZ) return ability === 'illusion' ? 1 : 0;
		if (p.ability) return p.ability === ability ? 1 : 0;
		return this.prior.abilityProbs(p.species).get(ability) ?? 0;
	}

	private onSwitchIn(slot: number, shown: string, hp: number, status: string, lead: boolean, outgoing?: { hp: number; status: string }) {
		if (!this.initialized) this.init();
		if (this.inert) return;
		const id = ++this.stint;
		this.slotStint[slot] = id;
		const next: Hyp[] = [];
		for (const h0 of this.hyps) {
			if (lead && !h0.phys[h0.order[slot]!]!.everActive) {
				const h = this.clone(h0);
				const p = h.phys[h.order[slot]!]!;
				if (!this.shownOk(h, slot, shown)) continue;
				p.everActive = true; p.entries++; p.hp = hp; p.status = status;
				h.stintZ.set(id, p.isZ);
				next.push(h);
				continue;
			}
			// Outgoing Pokémon keeps the HP/status it left with.
			const out = h0.phys[h0.order[slot]!];
			const cands: number[] = [];
			for (let k = 2; k < h0.order.length; k++) if (!h0.phys[h0.order[k]!]!.fainted) cands.push(k);
			for (const k of cands) {
				const h = this.clone(h0);
				const o = h.phys[h.order[slot]!];
				if (o && out && !o.fainted && outgoing) { o.hp = outgoing.hp; o.status = outgoing.status; }
				h.disguised[slot] = false;
				[h.order[slot], h.order[k]] = [h.order[k]!, h.order[slot]!];
				if (!this.shownOk(h, slot, shown)) continue;
				const p = h.phys[h.order[slot]!]!;
				h.w *= (1 / cands.length) * this.continuity(h, p, hp, status);
				p.everActive = true; p.entries++; p.hp = hp; p.status = status;
				h.stintZ.set(id, p.isZ);
				next.push(h);
			}
		}
		if (!next.length) {
			this.warnings.push(`turn ${this.st.turn}: no hypothesis explains ${shown} entering slot ${slot}; keeping previous beliefs`);
			return;
		}
		this.hyps = next;
		this.normalize();
		this.windows = this.windows.filter(w => w.slot !== slot);
		this.windows.push({ slot, revealed: false, weatherStart: this.st.field.weather, terrainStart: this.st.field.terrain });
	}

	// ---- evidence ------------------------------------------------------------------------------

	private moveLik(p: Phys, species: string, move: string): number {
		if (!this.prior.canLearn(species, move)) {
			// Mega formes share the base forme's learnset.
			const base = this.speciesData(species);
			if (!(base.isMega && this.prior.canLearn(base.baseSpecies, move))) return 0;
		}
		if (p.moves.includes(move)) return 1;
		if (p.moves.length >= 4) return 0;
		return Math.max(1e-4, this.prior.moveInclusion(p.isZ ? p.species : this.speciesData(species).isMega ? this.speciesData(species).baseSpecies : species, move));
	}

	private onMove(slot: number, move: string) {
		this.update(h => {
			const p = h.phys[h.order[slot]!]!;
			const l = this.moveLik(p, this.trueSpecies(h, slot), move);
			if (!p.moves.includes(move)) p.moves.push(move);
			return l;
		}, `move ${move}`);
	}

	private onAbility(slot: number, ability: string) {
		this.update(h => {
			const p = h.phys[h.order[slot]!]!;
			const l = this.abilityProb(p, ability);
			if (!p.isZ) p.ability = ability;
			return Math.max(l, p.isZ && ability !== 'illusion' ? 0 : HARD);
		}, `ability ${ability}`);
		for (const w of this.windows) if (w.slot === slot) w.revealed = true;
	}

	private onItem(slot: number, item: string) {
		this.update(h => {
			const p = h.phys[h.order[slot]!]!;
			let l: number;
			if (p.item !== undefined) l = p.item === item ? 1 : HARD;
			else if (h.phys.some(q => q !== p && q.item === item && item !== '')) l = HARD; // item clause
			else l = Math.max(1e-4, this.prior.itemProbs(p.species).get(item) ?? 1e-4);
			p.item = item;
			return l;
		}, `item ${item}`);
	}

	private silentProb(h: Hyp, slot: number, w: Window): number {
		const p = h.phys[h.order[slot]!]!;
		if (p.isZ) return 1;
		const abilities = p.ability ? new Map([[p.ability, 1]]) : this.prior.abilityProbs(p.species);
		const other: SideId = this.side === 'p1' ? 'p2' : 'p1';
		const foeActive = this.st.sides[other].active.some(id => {
			const m = this.st.sides[other].pokemon.find(x => x.ident === id);
			return m && !m.fainted;
		});
		let silent = 0;
		for (const [a, pa] of abilities) {
			const info = this.announce.get(a);
			let s: number;
			if (!info || info.announce === 'never') s = 1;
			else if (info.announce === 'conditional') s = 0.5;
			else if (!foeActive) s = 0.5;
			else if (info.weather && (w.weatherStart === info.weather || this.st.field.weather === info.weather)) s = 1;
			else if (info.terrain && (w.terrainStart === info.terrain || this.st.field.terrain === info.terrain)) s = 1;
			else if (a === 'supersweetsyrup' && p.entries > 1) s = 1; // only announces on its first entry
			else if (a === 'trace' || a === 'imposter') s = 0.5; // depend on the foes' abilities / position
			else s = 0;
			silent += pa * s;
		}
		return Math.max(HARD, silent);
	}

	private closeWindows() {
		const ws = this.windows;
		this.windows = [];
		for (const w of ws) {
			if (w.revealed) continue;
			const mon = this.activeMon(this.side, w.slot);
			if (!mon || mon.fainted) continue;
			this.update(h => this.silentProb(h, w.slot, w), `no ability message for ${mon.species}`);
		}
	}

	private finalizeDamage() {
		for (const slot of this.pendingDamage) {
			// Took an attack and the disguise didn't break: not a disguised Zoroark.
			this.update(h => (h.disguised[slot] ? HARD : 1), 'took an attack without Illusion breaking');
		}
		this.pendingDamage.clear();
	}

	private typesFor(h: Hyp, slot: number): string[] {
		return this.speciesData(this.trueSpecies(h, slot)).types;
	}

	private ownSet(ident: string): PokemonSet | undefined {
		const mon = this.parser.state.sides[this.side === 'p1' ? 'p2' : 'p1'].pokemon.find(p => p.ident === ident);
		if (!mon || !this.opts.ownTeam) return undefined;
		return this.opts.ownTeam.find(s => this.sameSpecies(s.species, mon.teamSpecies) || (s.name && s.name === mon.name));
	}

	/** Our move `move` hit or failed against the analysed slot: was that consistent with its types? */
	private onTypeOutcome(slot: number, move: Move, attackerIdent: string, immune: boolean, statusBefore: string) {
		const attacker = this.ownSet(attackerIdent);
		const attackerAbility = attacker ? toID(attacker.ability) : undefined;
		// Without our own team we can't rule out type-changing or Prankster attackers.
		if (!attacker && (move.type === 'Normal' || move.category === 'Status')) return;
		if (attackerAbility && ['normalize', 'pixilate', 'aerilate', 'refrigerate', 'galvanize', 'dragonize', 'liquidvoice', 'scrappy', 'mindseye'].includes(attackerAbility)) return;
		if (attackerAbility === 'corrosion' && (move.status === 'psn' || move.status === 'tox')) return;
		// Only moves whose success depends on type alone.
		const typeOnly = move.category === 'Status' ?
			!!move.status || !!move.flags.powder || move.id === 'leechseed' || move.ignoreImmunity === false :
			!move.ohko && !['dreameater', 'synchronoise', 'endeavor', 'skydrop', 'weatherball', 'terrainpulse', 'judgment', 'revelationdance', 'thousandarrows', 'smackdown'].includes(move.id);
		if (!typeOnly || move.id === 'attract' || typeof move.ignoreImmunity === 'object') return;
		const dex = this.format.dex;
		const target = this.activeMon(this.side, slot);
		if (!target || target.volatiles.magnetrise || target.volatiles.foresight || target.volatiles.miracleeye || target.volatiles.smackdown ||
			target.item.current === 'airballoon' || (move.category === 'Status' && statusBefore)) return;
		if (move.type === 'Ground' && this.st.field.pseudoWeather.gravity) return;
		if (move.category === 'Status' && move.status && this.st.field.terrain && ['mistyterrain', 'electricterrain'].includes(this.st.field.terrain)) return;
		this.update(h => {
			const types = this.typesFor(h, slot);
			const typeImmune = (move.category !== 'Status' || move.ignoreImmunity === false) && !dex.getImmunity(move.type, types);
			const statusImmune = !!move.status && !dex.getImmunity(move.status, types);
			const powderImmune = !!move.flags.powder && !dex.getImmunity('powder', types);
			const pranksterImmune = attackerAbility === 'prankster' && move.category === 'Status' && !dex.getImmunity('prankster', types);
			const seedImmune = move.id === 'leechseed' && types.includes('Grass');
			const predicted = typeImmune || statusImmune || powderImmune || pranksterImmune || seedImmune;
			return predicted === immune ? 1 : HARD;
		}, `${move.name} ${immune ? 'had no effect' : 'worked'}`);
	}

	private onSandstorm() {
		if (this.st.field.weather !== 'sandstorm') { this.sandHit.clear(); return; }
		const anyCloudNine = Object.values(this.st.sides).some(s => s.pokemon.some(p => p.activeSlot !== null && ['cloudnine', 'airlock'].includes(p.ability ?? '')));
		if (anyCloudNine) { this.sandHit.clear(); return; }
		for (const slot of [0, 1]) {
			const mon = this.activeMon(this.side, slot);
			if (!mon || (mon.fainted && !this.sandHit.has(slot))) continue;
			const hit = this.sandHit.has(slot);
			this.update(h => {
				const types = this.typesFor(h, slot);
				if (!this.format.dex.getImmunity('sandstorm', types)) return hit ? HARD : 1;
				const p = h.phys[h.order[slot]!]!;
				let immuneByAbility = 0;
				if (p.isZ) immuneByAbility = 0;
				else if (p.ability) immuneByAbility = SAND_IMMUNE_ABILITIES.has(p.ability) ? 1 : 0;
				else for (const [a, pa] of this.prior.abilityProbs(p.species)) if (SAND_IMMUNE_ABILITIES.has(a)) immuneByAbility += pa;
				return Math.max(HARD, hit ? 1 - immuneByAbility : immuneByAbility);
			}, 'sandstorm');
		}
		this.sandHit.clear();
	}

	// ---- turn order ----------------------------------------------------------------------------

	private ctxFor(side: SideId, slot: number): SpeedContext {
		const mon = this.activeMon(side, slot);
		const s = this.st.sides[side];
		return {
			stage: mon?.boosts.spe ?? 0,
			tailwind: !!s.conditions.tailwind,
			swamp: !!s.conditions.grasspledge,
			paralyzed: mon?.status === 'par',
			statused: !!mon?.status,
			weather: this.st.field.weather,
			terrain: this.st.field.terrain,
			trickRoom: !!this.st.field.pseudoWeather.trickroom,
			hpFull: (mon?.hp ?? 0) >= (mon?.maxHp ?? 100),
			itemLost: mon?.item.current === '' && !!mon?.item.lostVia,
			currentItem: mon?.item.swapped || (mon?.item.current === '' && mon?.item.lostVia) ? mon.item.current : undefined,
		};
	}

	private holderFromSet(set: PokemonSet, ctx: SpeedContext): Holder {
		const nature = this.format.dex.natures.get(set.nature);
		const mult = nature.plus === 'spe' ? 1.1 : nature.minus === 'spe' ? 0.9 : 1;
		return {
			species: this.speciesData(set.species),
			abilities: new Map([[toID(set.ability), 1]]),
			items: new Map([[ctx.currentItem ?? toID(set.item), 1]]),
			spreads: [{ sp: set.evs?.spe ?? 0, nature: mult, p: 1 }],
		};
	}

	private holderFor(h: Hyp | null, a: Action): Holder {
		if (a.side !== this.side) {
			const set = this.ownSet(a.ident);
			if (set) {
				const holder = this.holderFromSet(set, a.ctx);
				const sp = this.speciesData(a.shownSpecies);
				if (sp.isMega) {
					holder.species = sp;
					holder.abilities = new Map([[toID(sp.abilities[0] as string), 1]]);
				}
				return holder;
			}
			const sp = this.speciesData(a.shownSpecies);
			return { species: sp, abilities: this.prior.abilityProbs(sp.name), items: this.prior.itemProbs(sp.name), spreads: this.prior.speedSpreads(sp.name) };
		}
		const p = this.actorOf(h!, a);
		const species = this.actingSpecies(p, a);
		const sp = this.speciesData(species);
		const abilities = p.isZ ? new Map([['illusion', 1]]) :
			sp.isMega ? new Map([[toID(sp.abilities[0] as string), 1]]) :
			p.ability ? new Map([[p.ability, 1]]) : this.prior.abilityProbs(p.species);
		let items: Map<string, number>;
		if (a.ctx.currentItem !== undefined) items = new Map([[a.ctx.currentItem, 1]]);
		else if (p.item !== undefined) items = new Map([[p.item, 1]]);
		else {
			const taken = new Set(h!.phys.filter(q => q !== p && q.item).map(q => q.item!));
			items = new Map([...this.prior.itemProbs(p.species)].filter(([i]) => !taken.has(i)));
			const tot = [...items.values()].reduce((s, x) => s + x, 0) || 1;
			for (const [i, x] of items) items.set(i, x / tot);
		}
		return { species: this.speciesData(species), abilities, items, spreads: this.prior.speedSpreads(p.isZ ? p.species : p.species) };
	}

	private actorOf(h: Hyp, a: Action): Phys {
		return h.phys[h.actorPhys.get(a.id) ?? h.order[a.slot]!]!;
	}

	/** Species the physical Pokémon had when it acted (Mega forme if the shown one is its Mega). */
	private actingSpecies(p: Phys, a: Action): string {
		if (p.isZ) return p.species;
		return this.sameSpecies(a.shownSpecies, p.species) ? a.shownSpecies : p.species;
	}

	/** Cache key describing exactly what holderFor() depends on. */
	private holderKey(h: Hyp | null, a: Action): string {
		if (a.side !== this.side) return `other:${a.ident}:${a.shownSpecies}`;
		const p = this.actorOf(h!, a);
		const taken = p.item === undefined ? h!.phys.filter(q => q !== p && q.item).map(q => q.item).sort().join(',') : '';
		return `mine:${p.isZ}:${this.actingSpecies(p, a)}:${p.ability ?? ''}:${p.item ?? `?${taken}`}`;
	}

	private actor(h: Hyp | null, a: Action): Actor {
		const key = `${this.holderKey(h, a)}|${a.move.id}|${JSON.stringify(a.ctx)}`;
		let act = this.actorCache.get(key);
		if (!act) {
			act = actorFor(this.holderFor(h, a), a.move, a.ctx);
			this.actorCache.set(key, act);
		}
		return act;
	}

	private actionId = 0;

	private onAction(a: Action | null) {
		const prev = this.turnActions.at(-1);
		this.turnActions.push(a);
		if (a && a.side === this.side && this.initialized && !this.inert) {
			for (const h of this.hyps) h.actorPhys.set(a.id, h.order[a.slot]!);
		}
		if (!a || !prev || this.orderBroken) return;
		if (a.side !== this.side && prev.side !== this.side) return;
		// Showdown re-sorts the queue before each action, so the second actor was ordered with its
		// speed as of the first action (e.g. before the first action paralysed it).
		const ctxThen = prev.ctxAll.get(`${a.side}:${a.slot}`);
		if (!ctxThen) return;
		const second: Action = { ...a, ctx: ctxThen };
		const tr = prev.ctx.trickRoom;
		this.update(h => probOrder(this.actor(h, prev), this.actor(h, second), tr), `turn order ${prev.shownSpecies} before ${a.shownSpecies}`);
	}

	// ---- line dispatch ---------------------------------------------------------------------------

	private feedOne(line: string): void {
		if (!line.startsWith('|')) return;
		const { cmd, args, tags } = parseLine(line);
		const pos = posOf(args[0]);
		const mine = pos?.side === this.side;
		const slot = pos?.slot ?? null;

		// State before the line (for outgoing HP, turn-order context, reveal detection).
		const before = [0, 1].map(s => {
			const m = this.activeMon(this.side, s);
			return m && { ident: m.ident, hp: m.hp, maxHp: m.maxHp, status: m.status };
		});
		let action: Action | null | undefined;
		if ((cmd === 'move' || cmd === 'cant') && pos && slot !== null) {
			const from = tags.from ?? '';
			const called = /^(ability|move|item):/i.test(from) || 'zeffect' in tags;
			const moveName = cmd === 'move' ? args[1] : args[2];
			const mon = this.activeMon(pos.side, slot);
			if (!called && moveName && mon && !mon.volatiles.encore && !mon.transformedInto) {
				const move = this.format.dex.moves.get(moveName);
				const ctxAll = new Map<string, SpeedContext>();
				for (const sd of ['p1', 'p2'] as const) for (const sl of [0, 1]) if (this.activeMon(sd, sl)) ctxAll.set(`${sd}:${sl}`, this.ctxFor(sd, sl));
				action = move.exists ? { id: ++this.actionId, side: pos.side, slot, move, ctx: this.ctxFor(pos.side, slot), ctxAll, shownSpecies: mon.species, ident: mon.ident } : null;
			} else if (!called) {
				action = null;
			}
		}

		if (ORDER_DISRUPTORS.test(line)) this.orderBroken = true;
		if (['move', 'cant', 'turn', 'upkeep'].includes(cmd)) { this.finalizeDamage(); this.closeWindows(); }
		if (cmd === 'faint' && mine && slot !== null && this.pendingDamage.has(slot)) this.finalizeDamage();

		this.pendingEvents = [];
		this.parser.feed(line);
		const events = this.pendingEvents;
		this.pendingEvents = [];

		switch (cmd) {
		case 'switch': case 'drag': {
			if (!mine || slot === null) break;
			const { hp, status } = hpOf(args[2]);
			const lead = this.st.turn === 0;
			const out = before[slot];
			const outgoing = out ? { hp: Math.floor((100 * out.hp) / out.maxHp) || (out.hp > 0 ? 1 : 0), status: out.status } : undefined;
			this.pendingDamage.delete(slot);
			this.onSwitchIn(slot, speciesOfDetails(args[1]), hp, status, lead, outgoing);
			break;
		}
		case 'replace': {
			if (!mine || slot === null) break;
			this.pendingDamage.delete(slot);
			this.update(h => {
				const p = h.phys[h.order[slot]!]!;
				if (!p.isZ) return 0;
				h.disguised[slot] = false;
				return 1;
			}, 'Illusion broke');
			break;
		}
		case 'faint': {
			if (!mine || slot === null) break;
			if (this.inert || !this.initialized) break;
			for (const h of this.hyps) { h.phys[h.order[slot]!]!.fainted = true; h.disguised[slot] = false; }
			break;
		}
		case 'swap': {
			if (!mine || slot === null || !this.initialized || this.inert) break;
			const to = Number(args[1]);
			for (const h of this.hyps) {
				[h.order[slot], h.order[to]] = [h.order[to]!, h.order[slot]!];
				[h.disguised[slot], h.disguised[to]] = [h.disguised[to]!, h.disguised[slot]!];
			}
			[this.slotStint[slot], this.slotStint[to]] = [this.slotStint[to]!, this.slotStint[slot]!];
			break;
		}
		case 'move': {
			if (pos && slot !== null) this.lastMove = { side: pos.side, slot, ident: this.activeMon(pos.side, slot)?.ident ?? '', move: this.format.dex.moves.get(args[1]) };
			if (action !== undefined) this.onAction(action);
			if (toID(args[1]) === 'round') this.orderBroken = true; // allies' Round moves right after
			break;
		}
		case 'cant': {
			if (action !== undefined) this.onAction(action);
			break;
		}
		case 'turn': {
			this.turnActions = [];
			if (this.initialized && !this.inert) for (const h of this.hyps) h.actorPhys.clear();
			this.orderBroken = false;
			this.lastMove = undefined;
			break;
		}
		case 'upkeep': this.onSandstorm(); break;
		case '-damage': {
			if (!mine || slot === null) break;
			if (tags.from) { if (toID(tags.from) === 'sandstorm') this.sandHit.add(slot); break; }
			const lm = this.lastMove;
			const target = this.activeMon(this.side, slot);
			if (lm && target && lm.ident !== target.ident && lm.move.category !== 'Status') this.pendingDamage.add(slot);
			break;
		}
		case '-immune': {
			const lm = this.lastMove;
			if (mine && slot !== null && !tags.from && lm && lm.side !== this.side) this.onTypeOutcome(slot, lm.move, lm.ident, true, before[slot]?.status ?? '');
			break;
		}
		case '-status': {
			const lm = this.lastMove;
			if (mine && slot !== null && !tags.from && lm && lm.side !== this.side && lm.move.status === args[1]) {
				this.onTypeOutcome(slot, lm.move, lm.ident, false, before[slot]?.status ?? '');
			}
			break;
		}
		case '-start': {
			const lm = this.lastMove;
			if (mine && slot !== null && lm && lm.side !== this.side && lm.move.id === 'leechseed' && toID(args[1]) === 'leechseed') {
				this.onTypeOutcome(slot, lm.move, lm.ident, false, before[slot]?.status ?? "");
			}
			break;
		}

		case '-mega': {
			if (mine && slot !== null) {
				const megaSpecies = this.activeMon(this.side, slot)?.species;
				this.update(h => {
					const p = h.phys[h.order[slot]!]!;
					if (p.isZ) return 0;
					const sp = megaSpecies ? this.speciesData(megaSpecies) : undefined;
					if (sp?.isMega) p.ability = toID(sp.abilities[0] as string);
					return 1;
				}, 'Mega Evolution');
			}
			break;
		}
		case '-heal': {
			if (mine && /Revival Blessing/.test(tags.from ?? '') && this.initialized && !this.inert) {
				const mon = this.mySide.pokemon.find(p => p.ident === args[0]!.replace(/^(p[12])[ab]:/, '$1:'));
				const species = mon?.teamSpecies ?? '';
				this.update(h => {
					const p = h.phys.find(q => this.sameSpecies(q.species, species));
					if (!p || !p.fainted) return HARD;
					p.fainted = false;
					p.hp = hpOf(args[1]).hp;
					p.status = '';
					return 1;
				}, 'Revival Blessing');
			}
			break;
		}
		case '-cureteam': {
			if (mine && this.initialized && !this.inert) for (const h of this.hyps) for (const p of h.phys) p.status = '';
			break;
		}
		}

		// Reveals the parser attributed to Pokémon on the analysed side's active slots.
		if (this.initialized && !this.inert && cmd !== 'replace') {
			for (const e of events) {
				if (e.mon.side !== this.side || e.mon.activeSlot === null || e.mon.ident.endsWith('#illusion')) continue;
				const s = e.mon.activeSlot;
				if (e.type === 'ability' && e.ability !== 'illusion') this.onAbility(s, e.ability);
				else if (e.type === 'item' && e.item) this.onItem(s, e.item);
				else if (e.type === 'move' && cmd === 'move') this.onMove(s, e.move);
			}
		}
	}

	// ---- results ---------------------------------------------------------------------------------

	report(): IllusionReport {
		const slots: SlotReport[] = [0, 1].map(slot => {
			const mon = this.activeMon(this.side, slot);
			if (this.inert || !this.initialized || !mon) return { slot, shown: mon?.species, pZoroark: 0 };
			let z = 0;
			for (const h of this.hyps) if (h.phys[h.order[slot]!]!.isZ) z += h.w;
			return { slot, shown: mon.species, pZoroark: z };
		});
		let pBrought: number;
		if (this.zIndex < 0) pBrought = 0;
		else if (this.inert || !this.initialized) pBrought = 2 / 3;
		else pBrought = this.hyps.filter(h => h.phys.some(p => p.isZ)).reduce((s, h) => s + h.w, 0);
		return {
			zoroark: this.zIndex >= 0 ? this.preview[this.zIndex] : undefined,
			pBrought,
			slots,
			hypotheses: this.hyps.length,
			warnings: [...this.warnings],
		};
	}

	/** Probability that a past or current stint (numbered by switch-in) was Zoroark. */
	stintProbability(id: number): number {
		let z = 0;
		for (const h of this.hyps) if (h.stintZ.get(id)) z += h.w;
		return z;
	}

	get currentStints(): number[] { return [...this.slotStint]; }
}
