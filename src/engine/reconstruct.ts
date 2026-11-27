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
import { finishActives, restoreActive, restoreField, restoreItem, restoreSide, type RestoreEnv } from './restore.js';

export interface ReconstructInput {
	state: KnownBattleState;
	/** The four each side brought, as full sets (ours known; theirs a sample). */
	teams: Record<SideId, PokemonSet[]>;
	format?: ResolvedFormat;
	seed?: number;
}

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

export interface Reconstructed {
	battle: Battle;
	/** For each side, the known MonState behind each battle Pokémon (null = unseen). */
	mapping: Record<SideId, (MonState | null)[]>;
}

export function reconstructBattle(input: ReconstructInput): Reconstructed {
	const built = build(input);
	// Our own Zoroark: the log shows its disguise, but we know our exact HP. If an active
	// Pokémon's HP only fits our Zoroark, rebuild with the Zoroark in that slot.
	const state = input.state;
	const mine = state.perspective;
	if (mine && input.teams[mine].some(s => /^Zoroark/.test(s.species))) {
		const side = built.battle.sides[mine === 'p1' ? 0 : 1]!;
		const zoroark = side.pokemon.find(p => p.baseSpecies.baseSpecies === 'Zoroark');
		let fixed: KnownBattleState | undefined;
		side.active.forEach((p, slot) => {
			const mon = state.sides[mine].pokemon.find(m => m.ident === state.sides[mine].active[slot]);
			if (!p || !mon || !zoroark || p === zoroark || mon.maxHp === 100 || mon.maxHp === p.maxhp || mon.maxHp !== zoroark.maxhp) return;
			fixed ??= structuredClone(state);
			const m = fixed.sides[mine].pokemon.find(x => x.ident === mon.ident)!;
			m.species = m.teamSpecies = m.permanentSpecies = zoroark.species.name;
		});
		if (fixed) return build({ ...input, state: fixed });
	}
	return built;
}

/** The state with the Pokémon shown as `ident` actually being a disguised Zoroark (a determinization). */
export function withZoroarkAs(state: KnownBattleState, side: SideId, ident: string, zoroarkSpecies: string): KnownBattleState {
	const out = structuredClone(state);
	const mon = out.sides[side].pokemon.find(p => p.ident === ident);
	if (mon) { mon.species = zoroarkSpecies; mon.teamSpecies = zoroarkSpecies; mon.permanentSpecies = zoroarkSpecies; }
	return out;
}

function build(input: ReconstructInput): Reconstructed {
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

	type BattlePokemon = Battle['sides'][number]['pokemon'][number];
	const byIdent = new Map<string, BattlePokemon>();
	for (const id of ['p1', 'p2'] as const) {
		battle.sides[id === 'p1' ? 0 : 1]!.pokemon.forEach((p, i) => { const mon = mapping[id][i]; if (mon) byIdent.set(mon.ident, p); });
	}
	const env: RestoreEnv = { battle, format, turn, find: ident => (ident ? byIdent.get(ident) : undefined) };
	// Pass 2: faints, HP, status, items, PP for everyone; then the active Pokémon's volatile state
	// (once all HP etc. is in place, since Transform copies from its target).
	const actives: { p: BattlePokemon; mon: MonState }[] = [];
	for (const id of ['p1', 'p2'] as const) {
		const side = battle.sides[id === 'p1' ? 0 : 1]!;
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
			restoreItem(p, mon);
			// PP used.
			for (const [moveId, m] of Object.entries(mon.moves)) {
				const slot = p.baseMoveSlots.find(s => s.id === moveId);
				if (slot) slot.pp = Math.max(0, slot.pp - m.uses);
			}
			if (p.isActive) actives.push({ p, mon });
		});
	}
	for (const { p } of actives) p.clearVolatile(false); // (also resets boosts, types and counters; restored next)
	for (const { p, mon } of actives) restoreActive(p, mon, env);
	finishActives(actives);
	for (const id of ['p1', 'p2'] as const) restoreSide(battle.sides[id === 'p1' ? 0 : 1]!, state.sides[id], env);
	restoreField(battle.field, state.field, env);

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
