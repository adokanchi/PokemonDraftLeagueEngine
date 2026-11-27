/**
 * Rebuild a simulator battle from what a player knows, plus a full guess ("determinization")
 * of the opponent's hidden sets. Search runs on these battles.
 *
 * The battle is created with both teams in an order that puts the right Pokémon in the active
 * slots, started, and then patched to match the known state: HP, status, boosts, Mega, items,
 * faints, PP, volatiles (Substitute, Taunt, Encore, Choice lock, ...), weather/terrain/rooms and
 * side conditions with their remaining turns. Unknowable details (exact remaining turns of a
 * 5-or-8-turn effect, sleep counters) use the most common value.
 */
import { toID, type Battle, type PokemonSet } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';
import { createBattle } from '../sim/battle.js';
import type { KnownBattleState, MonState, SideId } from '../state/types.js';

export interface ReconstructInput {
	state: KnownBattleState;
	/** The four each side brought, as full sets (ours known; theirs a sample). */
	teams: Record<SideId, PokemonSet[]>;
	format?: ResolvedFormat;
	seed?: number;
}

/** Volatiles that only make sense mid-move or are re-derived elsewhere. */
const SKIP_VOLATILES = new Set(['lockedmove', 'twoturnmove', 'choicelock', 'stall', 'protect', 'banefulbunker', 'spikyshield', 'kingsshield',
	'silktrap', 'burningbulwark', 'obstruct', 'endure', 'helpinghand', 'flinch', 'roost', 'charge', 'rage', 'bide', 'uproar', 'illusion']);
const VOLATILE_DURATIONS: Record<string, number> = { taunt: 3, encore: 3, disable: 4, yawn: 2, healblock: 5, embargo: 5, magnetrise: 5, throatchop: 2, telekinesis: 3 };

function teamForme(format: ResolvedFormat, name: string): string {
	const sp = format.dex.species.get(name);
	if (typeof sp.battleOnly === 'string') return sp.battleOnly;
	if (Array.isArray(sp.battleOnly)) return sp.battleOnly[0]!;
	return sp.isMega ? sp.baseSpecies : sp.name;
}

/** Which set is this known Pokémon? (by team forme, so Megas / in-battle formes match their set) */
function matchSet(format: ResolvedFormat, mon: MonState, sets: PokemonSet[], used: Set<number>): number {
	const want = teamForme(format, mon.teamSpecies);
	const shown = teamForme(format, mon.species);
	return sets.findIndex((s, i) => !used.has(i) && [want, shown].includes(teamForme(format, s.species)));
}

/** Turns left for an effect that started on `since`, given its full duration. */
function remaining(full: number, since: number, turn: number): number {
	// Started before turn 1 (lead abilities): no end-of-turn has passed until turn 1 ends.
	const elapsed = turn - Math.max(since, 1);
	return Math.max(1, full - elapsed);
}

export interface Reconstructed {
	battle: Battle;
	/** For each side, the known MonState behind each battle Pokémon (null = unseen). */
	mapping: Record<SideId, (MonState | null)[]>;
}

export function reconstructBattle(input: ReconstructInput): Reconstructed {
	const format = input.format ?? resolveFormat();
	const { state } = input;
	const order: Record<SideId, PokemonSet[]> = { p1: [], p2: [] };
	const mapping: Record<SideId, (MonState | null)[]> = { p1: [], p2: [] };

	for (const id of ['p1', 'p2'] as const) {
		const side = state.sides[id];
		const sets = input.teams[id];
		if (sets.length < 1) throw new Error(`No team for ${id}`);
		const used = new Set<number>();
		const known = side.pokemon.filter(m => m.seen && !m.ident.endsWith('#illusion'));
		const placed: { set: PokemonSet; mon: MonState | null }[] = [];
		const take = (mon: MonState | null) => {
			let i = mon ? matchSet(format, mon, sets, used) : sets.findIndex((_, j) => !used.has(j));
			if (i < 0) i = sets.findIndex((_, j) => !used.has(j));
			if (i < 0) return;
			used.add(i);
			placed.push({ set: sets[i]!, mon });
		};
		// Active slots first (Showdown leads = first two), then everything else.
		for (const slot of [0, 1]) {
			const mon = known.find(m => m.ident === side.active[slot]);
			if (mon) take(mon);
			else {
				const spare = known.find(m => m.fainted && !placed.some(p => p.mon === m));
				take(spare ?? null);
			}
		}
		for (const m of known) if (!placed.some(p => p.mon === m)) take(m);
		while (placed.length < Math.min(4, sets.length)) take(null);
		order[id] = placed.map(p => p.set);
		mapping[id] = placed.map(p => p.mon);
	}

	const battle = createBattle({
		format,
		p1: { name: state.sides.p1.name || 'p1', team: order.p1 },
		p2: { name: state.sides.p2.name || 'p2', team: order.p2 },
		seed: input.seed ?? 1,
	});
	const teamChoice = (n: number) => `team ${Array.from({ length: n }, (_, i) => i + 1).join('')}`;
	battle.choose('p1', teamChoice(order.p1.length));
	battle.choose('p2', teamChoice(order.p2.length));

	const dex = format.dex;
	const turn = Math.max(1, state.turn);

	// Pass 1, both sides: Mega Evolution first, since a Mega's ability can act on entry
	// (Intimidate) and would disturb boosts patched afterwards.
	for (const id of ['p1', 'p2'] as const) {
		const side = battle.sides[id === 'p1' ? 0 : 1]!;
		side.pokemon.forEach((p, i) => {
			const mon = mapping[id][i];
			const shown = mon && dex.species.get(mon.species);
			if (shown?.isMega && p.species.name !== shown.name) p.formeChange(shown.name, p.getItem(), true);
		});
	}

	for (const id of ['p1', 'p2'] as const) {
		const side = battle.sides[id === 'p1' ? 0 : 1]!;
		const known = state.sides[id];
		const foe = battle.sides[id === 'p1' ? 1 : 0]!;
		side.pokemon.forEach((p, i) => {
			const mon = mapping[id][i];
			if (!mon) return;
			if (mon.fainted) {
				p.hp = 0;
				p.fainted = true;
				p.isActive = false;
				p.status = '' as never;
				side.pokemonLeft = Math.max(0, side.pokemonLeft - 1);
				side.totalFainted++;
				return;
			}
			// HP: exact when we have it, else the middle of the shown percentage band.
			const hp = mon.maxHp === p.maxhp ? mon.hp : Math.max(1, Math.round(((mon.hp + 0.5) / 100) * p.maxhp));
			p.hp = Math.min(p.maxhp, hp);
			p.status = '' as never;
			if (mon.status) {
				p.setStatus(mon.status, p, null, true);
				if (mon.status === 'slp') p.statusState.time = 2;
			}
			// Items: lost, or swapped by Trick etc.
			if (mon.item.current === '' && mon.item.lostVia) p.item = '' as never;
			else if (mon.item.swapped && mon.item.current) p.item = toID(mon.item.current) as never;
			// PP used.
			for (const [moveId, m] of Object.entries(mon.moves)) {
				const slot = p.moveSlots.find(s => s.id === moveId);
				if (slot) slot.pp = Math.max(0, slot.pp - m.uses);
			}
			if (p.isActive) {
				p.clearVolatile(false); // (also resets boosts and turn counters, so those come after)
				// A Pokémon that came in during turn T first acts on turn T+1 (Fake Out, First Impression).
				const inTurn = mon.switchedInTurn ?? 0;
				p.activeTurns = Math.max(0, inTurn === 0 ? turn - 1 : turn - inTurn);
				p.activeMoveActions = Math.max(0, turn - (inTurn + 1));

				p.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0, ...mon.boosts } as never;
				// Temporary formes (Hunger Switch, Stance Change, ...) and Transform.
				const cur = dex.species.get(mon.species);
				if (!cur.isMega && cur.name !== p.species.name && cur.baseSpecies === p.species.baseSpecies) p.formeChange(cur.name, null, false);
				if (mon.transformedInto) {
					const into = dex.species.get(mon.transformedInto);
					const target = foe.active.find(f => f && (f.species.name === into.name || f.species.baseSpecies === into.baseSpecies));
					if (target) p.transformInto(target);
				}
				if (mon.lastMove && p.moveSlots.some(m => m.id === toID(mon.lastMove))) p.lastMove = dex.getActiveMove(mon.lastMove) as never;
				const foeActive = foe.active.find(f => f && !f.fainted) ?? null;
				for (const v of Object.keys(mon.volatiles)) {
					if (['typechange', 'mustrecharge', 'transform'].includes(v)) continue;
					if (v === 'substitute') {
						p.addVolatile('substitute');
						if (p.volatiles.substitute) p.volatiles.substitute.hp = Math.floor(p.maxhp / 4);
						continue;
					}
					if (v === 'leechseed' && foeActive) { p.addVolatile('leechseed', foeActive); continue; }
					if (SKIP_VOLATILES.has(v)) continue;
					if (dex.conditions.get(v).exists || dex.moves.get(v).exists) {
						try { p.addVolatile(v, foeActive ?? undefined); } catch { continue; }
						const d = VOLATILE_DURATIONS[v];
						if (d && p.volatiles[v]) p.volatiles[v].duration = Math.max(1, d - (turn - mon.volatiles[v]!.since));
					}
				}
				const item = p.getItem();
				if (item.isChoice && mon.lastMove && (mon.lastMoveTurn ?? -1) >= (mon.switchedInTurn ?? 0)) {
					// (addVolatile('choicelock') needs a move in progress; build the state directly.)
					p.volatiles.choicelock = battle.initEffectState({ id: 'choicelock', target: p, move: toID(mon.lastMove) } as never) as never;
				}
				const lastMove = mon.lastMove ? dex.moves.get(mon.lastMove) : undefined;
				if (lastMove?.stallingMove && mon.lastMoveTurn === turn - 1) p.addVolatile('stall');
			}
		});
		if (known.megaUsed) for (const p of side.pokemon) p.canMegaEvo = null;
		// Side conditions.
		for (const c of Object.keys(side.sideConditions)) side.removeSideCondition(c);
		for (const [c, info] of Object.entries(known.conditions)) {
			for (let l = 0; l < (info.layers ?? 1); l++) side.addSideCondition(c, 'debug');
			const sc = side.sideConditions[c];
			if (sc?.duration) sc.duration = remaining(sc.duration, info.since, turn);
		}
	}

	// Field.
	const field = battle.field;
	if (state.field.weather) {
		if (field.weather !== state.field.weather) field.setWeather(state.field.weather, 'debug');
		if (field.weatherState.duration) field.weatherState.duration = remaining(5, state.field.weatherSince ?? 0, turn);
	} else if (field.weather) field.clearWeather();
	if (state.field.terrain) {
		if (field.terrain !== state.field.terrain) field.setTerrain(state.field.terrain, 'debug');
		if (field.terrainState.duration) field.terrainState.duration = remaining(5, state.field.terrainSince ?? 0, turn);
	} else if (field.terrain) field.clearTerrain();
	for (const pw of Object.keys(field.pseudoWeather)) if (!state.field.pseudoWeather[pw]) field.removePseudoWeather(pw);
	for (const [pw, info] of Object.entries(state.field.pseudoWeather)) {
		if (!field.pseudoWeather[pw]) field.addPseudoWeather(pw, 'debug');
		const ps = field.pseudoWeather[pw];
		if (ps?.duration) ps.duration = remaining(5, info.since, turn);
	}

	battle.turn = turn;
	refreshMoveRestrictions(battle);
	battle.log.splice(0);
	(battle as unknown as { sentLogPos: number }).sentLogPos = 0;
	if (input.seed !== undefined) battle.resetRNG(`${input.seed % 65536},${(input.seed >> 3) % 65536},7,11` as never);
	battle.makeRequest('move');
	return { battle, mapping };
}

/**
 * Recompute disabled moves and trapping for the active Pokémon, as Showdown does at the end of
 * each turn (Battle.endTurn) before building requests. Needed after patching volatiles/counters.
 */
function refreshMoveRestrictions(battle: Battle) {
	for (const side of battle.sides) {
		for (const pokemon of side.active) {
			if (!pokemon || pokemon.fainted) continue;
			pokemon.maybeDisabled = false;
			pokemon.maybeLocked = false;
			for (const moveSlot of pokemon.moveSlots) { moveSlot.disabled = false; moveSlot.disabledSource = ''; }
			battle.runEvent('DisableMove', pokemon);
			for (const moveSlot of pokemon.moveSlots) {
				const activeMove = battle.dex.getActiveMove(moveSlot.id);
				battle.singleEvent('DisableMove', activeMove, null, pokemon);
				if (activeMove.flags['cantusetwice'] && pokemon.lastMove?.id === moveSlot.id) pokemon.disableMove(pokemon.lastMove.id);
			}
			pokemon.trapped = pokemon.maybeTrapped = false;
			battle.runEvent('TrapPokemon', pokemon);
			if (!pokemon.knownType || battle.dex.getImmunity('trapped', pokemon)) battle.runEvent('MaybeTrapPokemon', pokemon);
		}
	}
}
