/** Compare a battle rebuilt from p1's knowledge (+ true opponent sets) with the real one. */
import type { Battle, PokemonSet } from '../src/showdown.js';
import { legalChoices } from '../src/sim/battle.js';
import { reconstructBattle, withZoroarkAs } from '../src/engine/reconstruct.js';
import { parseBattleLog, viewOfLog } from '../src/state/parser.js';

/** Bookkeeping volatiles with no effect on play from here (or re-created when needed). */
const IGNORED_VOLATILES = new Set(['stall', 'trapper', 'illusion']);

const forme = (p: { species: { name: string; battleOnly?: unknown; baseSpecies: string; isMega?: boolean } }) => p.species.name;

/** Choice strings with switch indices replaced by species, so different team orders compare. */
function normalize(battle: Battle, side: 0 | 1, choices: string[]): Set<string> {
	const mons = battle.sides[side]!.pokemon;
	return new Set(choices.map(c => c.replace(/switch (\d)/g, (_, i) => `switch ${mons[Number(i) - 1]!.set.species}`)));
}

export function compareReconstruction(real: Battle): string[] {
	const out: string[] = [];
	let state = parseBattleLog(viewOfLog(real.log, 'p1').join('\n'), { perspective: 'p1' });
	// A disguised opposing Zoroark: rebuild as the solver does when it guesses the disguise right.
	for (const [slot, p] of real.sides[1]!.active.entries()) {
		const ident = state.sides.p2.active[slot];
		if (p?.illusion && ident) state = withZoroarkAs(state, 'p2', ident, p.species.name);
	}
	const teams = {
		p1: real.sides[0]!.pokemon.map(p => p.set as PokemonSet),
		p2: real.sides[1]!.pokemon.map(p => p.set as PokemonSet),
	};
	const { battle } = reconstructBattle({ state, teams, seed: 5 });
	const t = `turn ${real.turn}`;
	for (const [i, side] of real.sides.entries()) {
		const rs = battle.sides[i]!;
		for (const slot of [0, 1]) {
			const a = side.active[slot];
			const b = rs.active[slot];
			if (!a || a.fainted) continue;
			if (!b) { out.push(`${t} ${side.id}${slot}: missing active`); continue; }
			if (forme(a) !== forme(b)) { out.push(`${t} ${side.id}${slot}: species ${forme(b)} vs ${forme(a)}`); continue; }
			const tol = i === 0 ? 0 : Math.ceil(a.maxhp / 100) + 1;
			if (Math.abs(a.hp - b.hp) > tol) out.push(`${t} ${side.id} ${a.name}: hp ${b.hp} vs ${a.hp}`);
			if (a.status !== b.status) out.push(`${t} ${side.id} ${a.name}: status ${b.status} vs ${a.status}`);
			for (const [k, v] of Object.entries(a.boosts)) if ((b.boosts as Record<string, number>)[k] !== v) out.push(`${t} ${side.id} ${a.name}: boost ${k} ${(b.boosts as Record<string, number>)[k]} vs ${v}`);
			if ((a.item || '') !== (b.item || '')) out.push(`${t} ${side.id} ${a.name}: item ${b.item} vs ${a.item}`);
			if (a.ability !== b.ability) out.push(`${t} ${side.id} ${a.name}: ability ${b.ability} vs ${a.ability}`);
			if (a.getTypes().join('/') !== b.getTypes().join('/')) out.push(`${t} ${side.id} ${a.name}: types ${b.getTypes()} vs ${a.getTypes()}`);
			if (a.activeTurns !== b.activeTurns) out.push(`${t} ${side.id} ${a.name}: activeTurns ${b.activeTurns} vs ${a.activeTurns}`);
			if (a.timesAttacked !== b.timesAttacked) out.push(`${t} ${side.id} ${a.name}: timesAttacked ${b.timesAttacked} vs ${a.timesAttacked}`);
			if ((a.moveLastTurnResult === false) !== (b.moveLastTurnResult === false)) out.push(`${t} ${side.id} ${a.name}: lastTurnFailed ${b.moveLastTurnResult} vs ${a.moveLastTurnResult}`);
			const vols = (p: typeof a) => Object.keys(p.volatiles).filter(v => !IGNORED_VOLATILES.has(v)).sort().join(',');
			if (vols(a) !== vols(b)) out.push(`${t} ${side.id} ${a.name}: volatiles ${vols(b)} vs ${vols(a)}`);
		}
		for (const p of side.pokemon) {
			const q = rs.pokemon.find(x => x.set.species === p.set.species);
			if (q && p.fainted !== q.fainted && (p.isActive || p.previouslySwitchedIn)) out.push(`${t} ${side.id} ${p.name}: fainted ${q.fainted} vs ${p.fainted}`);
		}
		const sc = Object.keys(side.sideConditions).sort().join(','), rsc = Object.keys(rs.sideConditions).sort().join(',');
		if (sc !== rsc) out.push(`${t} ${side.id}: side ${rsc} vs ${sc}`);
	}
	if ((real.field.weather || '') !== (battle.field.weather || '')) out.push(`${t}: weather ${battle.field.weather} vs ${real.field.weather}`);
	if ((real.field.terrain || '') !== (battle.field.terrain || '')) out.push(`${t}: terrain ${battle.field.terrain} vs ${real.field.terrain}`);
	const pw = Object.keys(real.field.pseudoWeather).sort().join(','), rpw = Object.keys(battle.field.pseudoWeather).sort().join(',');
	if (pw !== rpw) out.push(`${t}: rooms ${rpw} vs ${pw}`);
	for (const side of [0, 1] as const) {
		const a = normalize(real, side, legalChoices(real, side));
		const b = normalize(battle, side, legalChoices(battle, side));
		const missing = [...a].filter(c => !b.has(c)), extra = [...b].filter(c => !a.has(c));
		if (missing.length || extra.length) out.push(`${t} p${side + 1} choices: missing ${missing.slice(0, 3)} extra ${extra.slice(0, 3)}`);
	}
	return out;
}
