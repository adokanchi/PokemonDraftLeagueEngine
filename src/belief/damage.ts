/**
 * Damage ranges from Showdown's own damage formula (Champions mod included), for inference:
 * "if their Kingambit had this set, how much would my Earthquake have done?"
 *
 * The calculation runs in a scratch battle holding the whole field at the moment of the hit:
 * both sides' active Pokémon with their known state (HP, status, boosts, Mega, type changes,
 * volatiles like Helping Hand and Charge, hit counters for Rage Fist), side conditions and the
 * field, fainted counts (Last Respects, Supreme Overlord), and who still has to move this turn
 * (Payback, Analytic, Bolt Beak). Allies matter too: Friend Guard, auras, Power Spot, Battery.
 * The damage roll is forced to its minimum and maximum.
 */
import { Pokemon, toID, type Battle, type PokemonSet } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';
import { createBattle } from '../sim/battle.js';
import { finishActives, restoreActive, restoreField, restoreItem, restoreSide, type RestoreEnv } from '../engine/restore.js';
import type { KnownBattleState, MonState, SideId } from '../state/types.js';

/** One hit, as the log showed it, with the context the damage formula needs. */
export interface HitSpec {
	/** What was known just before this hit landed. */
	state: KnownBattleState;
	attacker: string;
	defender: string;
	move: string;
	crit: boolean;
	/** The move had more than one target (spread reduction). */
	spread: boolean;
	/** Which hit of a multi-hit move this is (Triple Axel's power, Parental Bond's weaker second hit). */
	hit: number;
	/** Items held going into this hit that the state already shows as gone (a resist berry or Focus Sash used by it). */
	itemsBefore?: Record<string, string>;
	/** Pokémon that still had a move to make later this turn (Payback, Analytic, Bolt Beak, Fishious Rend). */
	yetToMove?: string[];
	/** Earlier hits this turn, attacker → defender with HP lost (Revenge, Avalanche, Assurance). */
	earlierHits?: { by: string; on: string }[];
	/** Pokémon whose stats were lowered earlier this turn (Lash Out). */
	loweredThisTurn?: string[];
	/** A chance-based power boost happened, as the log announced (Fickle Beam's double power). */
	lucky?: boolean;
}

export interface DamageRange {
	min: number;
	max: number;
	maxHp: number;
	/** The move can't hit this target (immunity). */
	immune: boolean;
}

type BattlePokemon = Battle['sides'][number]['pokemon'][number];
const noop = () => {};

export class DamageCalc {
	private battle: Battle;
	private format: ResolvedFormat;
	private fillers: BattlePokemon[][];

	constructor(format: ResolvedFormat = resolveFormat()) {
		this.format = format;
		const filler: PokemonSet = {
			name: 'Filler', species: 'Furret', item: '', ability: 'Run Away', moves: ['Tackle'], nature: 'Hardy', gender: '',
			evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, level: 50,
		} as PokemonSet;
		this.battle = createBattle({ format, p1: { name: 'A', team: [filler, filler] }, p2: { name: 'B', team: [filler, filler] }, seed: 1 });
		this.battle.choose('p1', 'team 12');
		this.battle.choose('p2', 'team 12');
		(this.battle as unknown as { send: unknown }).send = noop;
		this.fillers = this.battle.sides.map(s => [...s.pokemon]);
	}

	/**
	 * Min/max damage of one hit. `setOf` gives the set to use for each Pokémon on the field (ours
	 * known; theirs the guess being scored, or a best guess for its partner).
	 */
	range(spec: HitSpec, setOf: (mon: MonState) => PokemonSet | undefined): DamageRange {
		const battle = this.battle;
		const dex = this.format.dex;
		const { state } = spec;
		const turn = Math.max(1, state.turn);
		const placed = new Map<string, BattlePokemon>();
		const known: { p: BattlePokemon; mon: MonState }[] = [];
		try {
			// The field: every active Pokémon we have a set for.
			for (const [i, id] of (['p1', 'p2'] as SideId[]).entries()) {
				const side = battle.sides[i]!;
				const ks = state.sides[id];
				for (const slot of [0, 1]) {
					const mon = ks.pokemon.find(p => p.ident === ks.active[slot]);
					const set = mon && !mon.fainted ? setOf(mon) : undefined;
					let p: BattlePokemon;
					if (mon && set) {
						p = new Pokemon(set as never, side);
						const shown = dex.species.get(mon.species);
						if (shown.isMega && shown.name !== p.species.name) p.formeChange(shown.name, p.getItem(), true);
						const hp = mon.maxHp === p.maxhp ? mon.hp : Math.max(1, Math.round(((mon.hp + 0.5) / 100) * p.maxhp));
						p.hp = Math.min(p.maxhp, hp);
						if (mon.status) p.status = mon.status as never;
						restoreItem(p, mon);
						const before = spec.itemsBefore?.[mon.ident];
						if (before) p.item = toID(before) as never;
						placed.set(mon.ident, p);
						known.push({ p, mon });
					} else {
						p = this.fillers[i]![slot]!;
						p.hp = 0;
						p.fainted = true;
					}
					p.position = slot;
					p.isActive = !p.fainted;
					p.isStarted = true;
					side.pokemon[slot] = p;
					side.active[slot] = p;
				}
				side.totalFainted = ks.pokemon.filter(m => m.fainted && !m.ident.endsWith('#illusion')).length;
			}
			const a = placed.get(spec.attacker);
			const d = placed.get(spec.defender);
			if (!a || !d) throw new Error('attacker or defender not on the field');

			const env: RestoreEnv = { battle, format: this.format, turn, find: id => (id ? placed.get(id) : undefined), midTurn: true };
			for (const { p } of known) p.clearVolatile(false);
			for (const { p, mon } of known) restoreActive(p, mon, env);
			finishActives(known);
			for (const { p, mon } of known) { const b = spec.itemsBefore?.[mon.ident]; if (b) p.item = toID(b) as never; }
			for (const [i, id] of (['p1', 'p2'] as SideId[]).entries()) restoreSide(battle.sides[i]!, state.sides[id], env);
			restoreField(battle.field, state.field, env);

			// This turn so far: who still has to move, who has been hit by whom, lowered stats.
			for (const id of spec.yetToMove ?? []) {
				const p = placed.get(id);
				if (p) battle.queue.list.push({ choice: 'move', pokemon: p, moveid: 'tackle', order: 200, priority: 0, speed: p.getStat('spe') } as never);
			}
			for (const h of spec.earlierHits ?? []) {
				const on = placed.get(h.on), by = placed.get(h.by);
				if (!on || !by) continue;
				on.attackedBy.push({ source: by, damage: 1, move: 'tackle', thisTurn: true, slot: by.getSlot(), damageValue: 1 } as never);
				on.hurtThisTurn = 1;
			}
			for (const id of spec.loweredThisTurn ?? []) { const p = placed.get(id); if (p) p.statsLoweredThisTurn = true; }

			// Items a hit can use up (resist berries): reset between the two rolls.
			const keep = [a, d].map(p => ({ p, item: p.item, itemState: p.itemState, lastItem: p.lastItem, ate: p.ateBerry, used: p.usedItemThisTurn }));
			const roll = (mode: 'min' | 'max') => {
				for (const k of keep) Object.assign(k.p, { item: k.item, itemState: { ...k.itemState }, lastItem: k.lastItem, ateBerry: k.ate, usedItemThisTurn: k.used });
				const move = dex.getActiveMove(spec.move);
				move.willCrit = spec.crit;
				move.spreadHit = spec.spread;
				move.hit = spec.hit;
				if (spec.hit > 1 && toID(a.ability) === 'parentalbond' && !move.multihit) move.multihitType = 'parentalbond';
				battle.activeMove = move;
				battle.activePokemon = a;
				battle.activeTarget = d;
				// Type/power changes applied when a move is used (Weather Ball, -ate abilities, Electrify, Aura Wheel...).
				battle.singleEvent('ModifyType', move, null, a, d, move, move);
				battle.runEvent('ModifyType', a, d, move, move);
				battle.singleEvent('ModifyMove', move, null, a, d, move, move);
				battle.runEvent('ModifyMove', a, d, move, move);
				const orig = battle.randomizer, chance = battle.randomChance;
				battle.randomizer = ((base: number) => (mode === 'min' ? Math.floor((base * 85) / 100) : base)) as never;
				battle.randomChance = (() => !!spec.lucky) as never;
				try {
					return battle.actions.getDamage(a, d, move, true);
				} finally {
					battle.randomizer = orig;
					battle.randomChance = chance;
				}
			};
			const lo = roll('min');
			const hi = roll('max');
			if (lo === false || hi === false || lo === undefined || hi === undefined) return { min: 0, max: 0, maxHp: d.maxhp, immune: true };
			return { min: Number(lo), max: Number(hi), maxHp: d.maxhp, immune: false };
		} finally {
			battle.activeMove = null;
			battle.queue.list.length = 0;
			// Messages from items/abilities accumulate in the scratch log; Showdown throws after 1000 lines.
			battle.log.splice(0);
			(battle as unknown as { sentLogPos: number }).sentLogPos = 0;
			(battle as unknown as { eventDepth: number }).eventDepth = 0;
			for (const [i, side] of battle.sides.entries()) {
				for (const slot of [0, 1]) {
					const f = this.fillers[i]![slot]!;
					f.hp = f.maxhp; f.fainted = false;
					side.pokemon[slot] = f; side.active[slot] = f;
				}
				side.totalFainted = 0;
			}
		}
	}
}
