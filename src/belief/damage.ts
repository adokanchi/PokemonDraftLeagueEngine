/**
 * Damage ranges from Showdown's own damage formula (Champions mod included), for inference:
 * "if their Kingambit had this set, how much would my Earthquake have done?"
 *
 * Uses one scratch battle and swaps fresh Pokémon objects into it per calculation, with the
 * damage roll forced to its minimum and maximum.
 */
import { Pokemon, type Battle, type PokemonSet } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';
import { createBattle } from '../sim/battle.js';
import type { BoostId } from '../state/types.js';

export interface CombatantState {
	set: PokemonSet;
	/** Current species/forme if different from the set (Mega etc.). */
	species?: string;
	boosts?: Partial<Record<BoostId, number>>;
	/** HP before the hit, as a fraction of max (Multiscale, Sturdy-style effects, etc.). */
	hpFraction?: number;
	status?: string;
	/** Current item if it differs from the set ('' = none). */
	item?: string;
	/** Active side conditions on this Pokémon's side (reflect, lightscreen, auroraveil, ...). */
	sideConditions?: string[];
}

export interface DamageContext {
	crit: boolean;
	/** Hit more than one target (spread reduction). */
	spread: boolean;
	weather?: string;
	terrain?: string;
}

export interface DamageRange {
	min: number;
	max: number;
	maxHp: number;
	/** The move can't hit this target (immunity). */
	immune: boolean;
}

const noop = () => {};

export class DamageCalc {
	private battle: Battle;
	private format: ResolvedFormat;

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
	}

	private place(sideIndex: 0 | 1, c: CombatantState) {
		const battle = this.battle;
		const side = battle.sides[sideIndex]!;
		const p = new Pokemon(c.set as never, side);
		p.position = 0;
		p.isActive = true;
		p.isStarted = true;
		side.pokemon[0] = p;
		side.active[0] = p;
		if (c.species) {
			const sp = this.format.dex.species.get(c.species);
			if (sp.exists && sp.name !== p.species.name) p.formeChange(sp.name, p.getItem(), sp.isMega);
		}
		if (c.item !== undefined) p.item = c.item as never;
		p.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0, ...c.boosts } as never;
		p.hp = Math.max(1, Math.round((c.hpFraction ?? 1) * p.maxhp));
		if (c.status) p.status = c.status as never;
		for (const k of Object.keys(side.sideConditions)) delete side.sideConditions[k];
		for (const sc of c.sideConditions ?? []) {
			if (['reflect', 'lightscreen', 'auroraveil'].includes(sc)) {
				side.sideConditions[sc] = battle.initEffectState({ id: sc, target: side, duration: 5 } as never) as never;
			}
		}
		return p;
	}

	/** Min/max damage of one hit, or `immune`. */
	range(attacker: CombatantState, defender: CombatantState, moveName: string, ctx: DamageContext): DamageRange {
		const battle = this.battle;
		const field = battle.field;
		field.weather = (ctx.weather ?? '') as never;
		field.weatherState = battle.initEffectState({ id: ctx.weather ?? '' } as never) as never;
		field.terrain = (ctx.terrain ?? '') as never;
		field.terrainState = battle.initEffectState({ id: ctx.terrain ?? '' } as never) as never;
		const a = this.place(0, attacker);
		const d = this.place(1, defender);
		const roll = (mode: 'min' | 'max') => {
			const move = battle.dex.getActiveMove(moveName);
			move.willCrit = ctx.crit;
			move.spreadHit = ctx.spread;
			battle.activeMove = move;
			battle.activePokemon = a;
			battle.activeTarget = d;
			// Type/power changes applied when a move is used (Weather Ball, -ate abilities, Aura Wheel...).
			battle.singleEvent('ModifyType', move, null, a, d, move, move);
			battle.runEvent('ModifyType', a, d, move, move);
			battle.singleEvent('ModifyMove', move, null, a, d, move, move);
			battle.runEvent('ModifyMove', a, d, move, move);
			const orig = battle.randomizer;
			battle.randomizer = ((base: number) => (mode === 'min' ? Math.floor((base * 85) / 100) : base)) as never;
			try {
				return battle.actions.getDamage(a, d, move, true);
			} finally {
				battle.randomizer = orig;
				battle.activeMove = null;
			}
		};
		const lo = roll('min');
		const hi = roll('max');
		if (lo === false || hi === false) return { min: 0, max: 0, maxHp: d.maxhp, immune: true };
		return { min: Number(lo ?? 0), max: Number(hi ?? 0), maxHp: d.maxhp, immune: false };
	}
}
