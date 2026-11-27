import { Teams, type PokemonSet } from '../src/showdown.js';
import { createBattle, seedFromInt } from '../src/sim/battle.js';

/** Seeded random Champions doubles team (not necessarily VGC-legal; fine for exercising the simulator). */
export function randomTeam(seed: number): PokemonSet[] {
	return Teams.generate('gen9championsrandomdoublesbattle', { seed: seedFromInt(seed) } as never) as PokemonSet[];
}

export function randomBattle(seed: number, keepLog = false) {
	return createBattle({
		p1: { name: 'Alice', team: randomTeam(seed * 2 + 1) },
		p2: { name: 'Bob', team: randomTeam(seed * 2 + 2) },
		seed,
		keepLog,
	});
}
