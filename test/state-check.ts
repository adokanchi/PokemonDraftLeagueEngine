/**
 * Ground-truth checker: compares the parser's KnownBattleState against the simulator's real
 * state. Used by the parser tests (and handy for debugging new protocol cases).
 */
import type { Battle } from '../src/showdown.js';
import { toID } from '../src/showdown.js';
import { parseBattleLog } from '../src/state/parser.js';
import type { SideId } from '../src/state/types.js';

export interface Mismatch { kind: string; detail: string }

/** How many side-checks were skipped because an Illusion user had been on the field. */
export let skippedIllusionSides = 0;

export function checkAgainstTruth(battle: Battle, perspective?: SideId): Mismatch[] {
	const out: Mismatch[] = [];
	const add = (kind: string, detail: string) => out.push({ kind, detail });
	const state = parseBattleLog(battle.log.join('\n'), { perspective });
	const t = `turn ${battle.turn}`;

	if (state.turn !== battle.turn) add('turn', `${state.turn} vs ${battle.turn}`);
	const w = battle.field.weather || undefined;
	if ((state.field.weather ?? undefined) !== w) add('weather', `${t}: ${state.field.weather} vs ${w}`);
	const terr = battle.field.terrain || undefined;
	if ((state.field.terrain ?? undefined) !== terr) add('terrain', `${t}: ${state.field.terrain} vs ${terr}`);
	const pw = Object.keys(battle.field.pseudoWeather).sort().join(',');
	const ppw = Object.keys(state.field.pseudoWeather).sort().join(',');
	if (pw !== ppw) add('pseudoweather', `${t}: ${ppw} vs ${pw}`);

	for (const side of battle.sides) {
		const ps = state.sides[side.id as SideId];
		// While an Illusion is unbroken the log is (by design) misleading about two Pokémon.
		const disguised = new Set<string>();
		for (const p of side.pokemon) {
			if (p.illusion) { disguised.add(p.fullname); disguised.add(p.illusion.fullname); }
		}
		const sc = Object.keys(side.sideConditions).sort().join(',');
		const psc = Object.keys(ps.conditions).sort().join(',');
		if (sc !== psc) add('sideconditions', `${t} ${side.id}: ${psc} vs ${sc}`);
		if (ps.megaUsed !== !!side.pokemon.some(p => p.baseSpecies.isMega)) add('megaused', `${t} ${side.id}`);

		// Once an Illusion user has been out, earlier unbroken disguises make per-Pokémon
		// attribution on that side inherently ambiguous: skip those checks.
		const illusionSide = side.pokemon.some(p => toID(p.set.ability) === 'illusion' && (p.isActive || p.previouslySwitchedIn > 0));
		if (illusionSide) { skippedIllusionSides++; continue; }

		for (const p of side.pokemon) {
			if (disguised.has(p.fullname)) continue;
			const seen = p.isActive || p.previouslySwitchedIn > 0;
			const m = ps.pokemon.find(x => x.ident === p.fullname);
			if (!seen) {
				if (m?.seen) add('seen', `${t} ${p.fullname} parsed as seen but never switched in`);
				continue;
			}
			if (!m) { add('missing', `${t} ${p.fullname}`); continue; }
			const illusion = p.ability === 'illusion' || p.baseAbility === 'illusion';
			const who = `${t} ${p.fullname}`;
			if (m.fainted !== p.fainted) add('fainted', `${who}: ${m.fainted} vs ${p.fainted}`);
			if (p.fainted) continue;
			const slot = p.isActive ? p.position : null;
			if (!illusion && m.activeSlot !== slot) add('activeslot', `${who}: ${m.activeSlot} vs ${slot}`);
			if (!illusion && toID(m.species) !== p.species.id) add('species', `${who}: ${m.species} vs ${p.species.name}`);
			if ((m.status || '') !== (p.status || '')) add('status', `${who}: ${m.status} vs ${p.status}`);
			if (perspective === side.id) {
				if (m.hp !== p.hp || m.maxHp !== p.maxhp) add('hp-exact', `${who}: ${m.hp}/${m.maxHp} vs ${p.hp}/${p.maxhp}`);
			} else {
				const pct = Math.floor((100 * p.hp) / p.maxhp) || 1; // Champions: floor, min 1
				if (!illusion && (m.hp !== pct || m.maxHp !== 100)) add('hp-pct', `${who}: ${m.hp}/${m.maxHp} vs ${pct}%`);
			}
			if (p.isActive && !illusion) {
				for (const [stat, v] of Object.entries(p.boosts)) {
					if ((m.boosts[stat as never] ?? 0) !== v) add('boosts', `${who} ${stat}: ${m.boosts[stat as never] ?? 0} vs ${v}`);
				}
			}
			if (illusion || p.transformed) continue;
			const realMoves = new Set([...p.baseMoveSlots, ...p.moveSlots].map(s => s.id));
			for (const mv of Object.keys(m.moves)) if (!realMoves.has(mv as never)) add('moves', `${who}: revealed ${mv}, has ${[...realMoves]}`);
			const setAbility = toID(p.set.ability);
			if (m.baseAbility && m.baseAbility !== setAbility && m.baseAbility !== p.baseAbility) {
				add('baseability', `${who}: ${m.baseAbility} vs set ${setAbility} / now ${p.baseAbility}`);
			}
			const setItem = toID(p.set.item);
			if (m.item.original !== undefined && m.item.original !== setItem) add('item-original', `${who}: ${m.item.original} vs ${setItem}`);
			if (m.item.current !== undefined && m.item.current !== (p.item || '')) add('item-current', `${who}: ${m.item.current} vs ${p.item || '(none)'}`);
		}
	}
	return out;
}
