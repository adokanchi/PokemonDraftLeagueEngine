/**
 * Copy what a player knows onto Showdown's battle objects: one Pokémon, one side, the field.
 *
 * Shared by battle reconstruction (search starts from these battles) and by the damage model
 * (which rebuilds the field around each observed hit), so both see the same state: HP, status,
 * boosts, Mega and temporary formes, Transform, type changes, changed abilities, items, PP,
 * volatiles (Substitute, Taunt, Encore, Disable and its move, trapping, Leech Seed, Charge,
 * charging and Outrage-style locks, Choice lock, Unburden, Helping Hand, Roost...) and counters
 * (turns on the field, hits taken for Rage Fist, fainted allies for Supreme Overlord, whether
 * its last move failed for Stomping Tantrum).
 */
import { toID, type Battle, type Pokemon } from '../showdown.js';
import type { ResolvedFormat } from '../config.js';
import type { FieldState, KnownBattleState, MonState, SideState } from '../state/types.js';

type Side = Battle['sides'][number];
type Field = Battle['field'];

export interface RestoreEnv {
	battle: Battle;
	format: ResolvedFormat;
	/** Turn being played (decision point: the turn about to be chosen). */
	turn: number;
	/** Battle Pokémon behind a known ident (trapping sources, Transform targets, Leech Seed). */
	find: (ident: string | undefined) => Pokemon | undefined;
	/** In the middle of a turn (scoring a hit) rather than at its start: keep this turn's effects. */
	midTurn?: boolean;
}

/** Volatiles that are handled specially below, re-derived, or only make sense mid-move. */
const SKIP_VOLATILES = new Set(['choicelock', 'stall', 'protect', 'banefulbunker', 'spikyshield', 'kingsshield', 'silktrap',
	'burningbulwark', 'obstruct', 'endure', 'flinch', 'rage', 'bide', 'uproar', 'illusion', 'typechange', 'typeadd',
	'mustrecharge', 'transform', 'substitute', 'leechseed', 'partiallytrapped', 'trapped', 'twoturnmove', 'lockedmove',
	'disable', 'helpinghand', 'roost']);
/** Full durations, for effects whose remaining turns we work out from when they started. */
const VOLATILE_DURATIONS: Record<string, number> = { taunt: 3, encore: 3, disable: 4, yawn: 2, healblock: 5, embargo: 5, magnetrise: 5, throatchop: 2, telekinesis: 3, partiallytrapped: 5 };

function left(full: number, since: number, turn: number) {
	return Math.max(1, full - (turn - since));
}

/** Items: lost, swapped (Trick...), or still the set's own (undoing anything the rebuilt battle's start consumed). */
export function restoreItem(p: Pokemon, mon: MonState) {
	if (mon.item.current === '' && mon.item.lostVia) p.item = '' as never;
	else if (mon.item.swapped && mon.item.current) p.item = toID(mon.item.current) as never;
	else p.item = toID(p.set.item) as never;
	p.itemState = p.battle.initEffectState({ id: p.item, target: p } as never) as never;
}

/**
 * Copy a known active Pokémon's state onto the Showdown Pokémon in its slot. Call
 * `p.clearVolatile(false)` on every active Pokémon first (clearing one ends effects linked to
 * others, such as trapping), and `finishActives` after all of them.
 */
export function restoreActive(p: Pokemon, mon: MonState, env: RestoreEnv) {
	const { battle, format, turn } = env;
	const dex = format.dex;
	const stint = mon.stint;

	// Turn counters. Showdown counts a turn on the field at each end of turn, leads included.
	const inTurn = mon.switchedInTurn ?? 0;
	p.activeTurns = Math.max(0, turn - inTurn);
	// A Pokémon that came in during turn T first acts on turn T+1 (Fake Out, First Impression).
	p.activeMoveActions = Math.max(0, turn - (inTurn + 1));
	p.newlySwitched = !!env.midTurn && inTurn === turn;
	p.moveLastTurnResult = mon.failedTurn === turn - 1 ? false : mon.lastMoveTurn === turn - 1 ? true : undefined;

	// Formes: temporary ones (Stance Change, Hunger Switch...), then Transform.
	const cur = dex.species.get(mon.species);
	if (!mon.transformedInto && !cur.isMega && cur.name !== p.species.name && cur.baseSpecies === p.species.baseSpecies) p.formeChange(cur.name, null, false);
	if (mon.transformedInto) transformInto(p, mon.transformedInto, env);
	p.timesAttacked = stint?.timesAttacked ?? 0; // (after Transform, which copies its target's)

	p.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0, ...mon.boosts } as never;
	const types = mon.volatiles.typechange?.types;
	if (types?.length) p.setType(types as never);
	for (const t of mon.volatiles.typeadd?.types ?? []) p.addType(t);
	// Abilities changed in battle (Trace, Skill Swap, Mummy...): the revealed current one.
	// (Set directly: setAbility would run its start effect, e.g. an Intimidate the rebuilt battle never had.)
	const swapped = mon.abilityChanged && !mon.ability && mon.abilityFrom ? env.find(mon.abilityFrom) : undefined;
	const ability = swapped ? toID(swapped.set.ability) : mon.abilityChanged ? mon.ability : undefined;
	if (ability && ability !== 'illusion' && toID(p.ability) !== ability) {
		p.ability = ability as never;
		p.abilityState = battle.initEffectState({ id: ability, target: p } as never) as never;
	}

	// Moves: last move, moves used since coming in (Last Resort), a transformed Pokémon's 5 PP.
	if (mon.lastMove && p.moveSlots.some(m => m.id === mon.lastMove)) p.lastMove = dex.getActiveMove(mon.lastMove) as never;
	for (const slot of p.moveSlots) {
		const used = stint?.moves[slot.id] ?? 0;
		if (used) slot.used = true;
		if (p.transformed) slot.pp = Math.max(0, slot.maxpp - used);
	}

	const foe = (p.side.foe.active as Pokemon[]).find(f => f && !f.fainted) ?? undefined;
	for (const [v, info] of Object.entries(mon.volatiles)) {
		if (info.singleTurn && !env.midTurn) continue;
		switch (v) {
		case 'substitute':
			p.addVolatile('substitute');
			if (p.volatiles.substitute) p.volatiles.substitute.hp = Math.floor(p.maxhp / 4);
			continue;
		case 'leechseed':
			if (foe) p.addVolatile('leechseed', foe);
			continue;
		case 'partiallytrapped': {
			const source = env.find(info.source) ?? foe;
			if (!source) continue;
			p.addVolatile('partiallytrapped', source, info.move ? dex.getActiveMove(info.move) as never : undefined);
			if (p.volatiles.partiallytrapped) p.volatiles.partiallytrapped.duration = left(VOLATILE_DURATIONS.partiallytrapped!, info.since, turn);
			continue;
		}
		case 'trapped': {
			const source = env.find(info.source);
			if (source?.isActive) p.addVolatile('trapped', source, null, 'trapper');
			else if (!info.source) p.addVolatile('trapped');
			continue;
		}
		case 'twoturnmove': {
			// Charging Solar Beam etc.: locked into releasing it. (The log doesn't say at whom: assume foe slot a.)
			if (!info.move) continue;
			p.volatiles.twoturnmove = battle.initEffectState({ id: 'twoturnmove', target: p, move: info.move, duration: 1 } as never) as never;
			p.volatiles[info.move] = battle.initEffectState({ id: info.move, target: p, targetLoc: 1 } as never) as never;
			continue;
		}
		case 'lockedmove': {
			// Outrage etc. After its first turn the lock lasts one or two more turns; after the second, one.
			if (!info.move) continue;
			const trueDuration = (info.count ?? 1) <= 1 ? battle.random(1, 3) : 1;
			p.volatiles.lockedmove = battle.initEffectState({ id: 'lockedmove', target: p, move: info.move, duration: 1, trueDuration } as never) as never;
			continue;
		}
		case 'disable': {
			const move = info.move ?? mon.lastMove;
			if (!move) continue;
			p.volatiles.disable = battle.initEffectState({ id: 'disable', target: p, move, duration: left(VOLATILE_DURATIONS.disable!, info.since, turn) } as never) as never;
			continue;
		}
		case 'helpinghand':
			p.addVolatile('helpinghand');
			if (p.volatiles.helpinghand) p.volatiles.helpinghand.multiplier = 1.5 ** (info.count ?? 1);
			continue;
		case 'roost':
			p.addVolatile('roost');
			continue;
		}
		if (SKIP_VOLATILES.has(v)) continue;
		if (!dex.conditions.get(v).exists && !dex.moves.get(v).exists) continue;
		try { p.addVolatile(v, foe); } catch { continue; }
		const d = VOLATILE_DURATIONS[v];
		if (d && p.volatiles[v]) p.volatiles[v].duration = left(d, info.since, turn);
	}

	const item = p.getItem();
	// Choice lock: it used a move while holding the Choice item (not if it got the item afterwards, e.g. via Trick).
	if (item.isChoice && !p.ignoringItem() && mon.lastMove && !stint?.itemChangedSinceMove && p.moveSlots.some(m => m.id === mon.lastMove)) {
		p.volatiles.choicelock = battle.initEffectState({ id: 'choicelock', target: p, move: mon.lastMove } as never) as never;
	}
	const lastMove = mon.lastMove ? dex.moves.get(mon.lastMove) : undefined;
	if (lastMove?.stallingMove && mon.lastMoveTurn === turn - 1) p.addVolatile('stall');
	if (toID(p.ability) === 'unburden' && stint?.itemLost && !p.item) p.addVolatile('unburden');
	if (toID(p.ability) === 'supremeoverlord' && stint?.faintedAllies) p.abilityState.fallen = Math.min(5, stint.faintedAllies);
}

/**
 * After restoring every active Pokémon: put back boosts and items that ability start effects
 * (an Imposter copying Intimidate, say) may have disturbed in the rebuilt battle.
 */
export function finishActives(list: { p: Pokemon; mon: MonState }[]) {
	for (const { p, mon } of list) {
		p.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0, ...mon.boosts } as never;
		const had = p.item;
		restoreItem(p, mon);
		if (had && p.item !== had && mon.item.swapped) p.item = had;
	}
}

/** Transform into the named species: the Pokémon it copied, even if that one has since fainted or left. */
function transformInto(p: Pokemon, species: string, env: RestoreEnv) {
	const want = env.format.dex.species.get(species);
	const all = [...p.side.foe.active, ...p.side.foe.pokemon, ...p.side.active, ...p.side.pokemon].filter(x => x && x !== p) as Pokemon[];
	const target = all.find(x => x.species.name === want.name) ?? all.find(x => x.species.baseSpecies === want.baseSpecies);
	if (!target) return;
	// transformInto refuses fainted / substituted / transformed targets: lift those for the copy.
	const saved = { fainted: target.fainted, hp: target.hp, sub: target.volatiles.substitute, transformed: target.transformed };
	target.fainted = false;
	target.hp = Math.max(1, target.hp);
	delete target.volatiles.substitute;
	target.transformed = false;
	try { p.transformInto(target); } finally {
		target.fainted = saved.fainted;
		target.hp = saved.hp;
		if (saved.sub) target.volatiles.substitute = saved.sub;
		target.transformed = saved.transformed;
	}
}

/** Side conditions with their remaining turns, Mega used, a faint last turn (Retaliate). */
export function restoreSide(side: Side, known: SideState, env: RestoreEnv) {
	if (known.megaUsed) for (const p of side.pokemon) p.canMegaEvo = null;
	for (const c of Object.keys(side.sideConditions)) side.removeSideCondition(c);
	for (const [c, info] of Object.entries(known.conditions)) {
		for (let l = 0; l < (info.layers ?? 1); l++) side.addSideCondition(c, 'debug');
		const sc = side.sideConditions[c];
		if (sc?.duration) sc.duration = remaining(sc.duration, info.since, env.turn);
	}
	if (known.lastFaintTurn !== undefined && known.lastFaintTurn === env.turn - 1) side.faintedLastTurn = side.pokemon.find(p => p.fainted) ?? null;
}

/** Weather, terrain and rooms with their remaining turns. */
export function restoreField(field: Field, known: FieldState, env: RestoreEnv) {
	const turn = env.turn;
	if (known.weather) {
		if (field.weather !== known.weather) field.setWeather(known.weather, 'debug');
		if (field.weatherState.duration) field.weatherState.duration = remaining(5, known.weatherSince ?? 0, turn);
	} else if (field.weather) field.clearWeather();
	if (known.terrain) {
		if (field.terrain !== known.terrain) field.setTerrain(known.terrain, 'debug');
		if (field.terrainState.duration) field.terrainState.duration = remaining(5, known.terrainSince ?? 0, turn);
	} else if (field.terrain) field.clearTerrain();
	for (const pw of Object.keys(field.pseudoWeather)) if (!known.pseudoWeather[pw]) field.removePseudoWeather(pw);
	for (const [pw, info] of Object.entries(known.pseudoWeather)) {
		if (!field.pseudoWeather[pw]) field.addPseudoWeather(pw, 'debug');
		const ps = field.pseudoWeather[pw];
		if (ps?.duration) ps.duration = remaining(5, info.since, turn);
	}
}

/** Turns left for an effect that started on `since`, given its full duration. */
export function remaining(full: number, since: number, turn: number): number {
	// Started before turn 1 (lead abilities): no end-of-turn has passed until turn 1 ends.
	const elapsed = turn - Math.max(since, 1);
	return Math.max(1, full - elapsed);
}

export type { KnownBattleState };
