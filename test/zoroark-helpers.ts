import { Teams, type PokemonSet } from '../src/showdown.js';
import { createBattle, seedFromInt } from '../src/sim/battle.js';
import { randomTeam } from './helpers.js';

let zoroSets: PokemonSet[] | undefined;

/** Random-battle Zoroark / Zoroark-Hisui sets from Showdown's team generator. */
export function zoroarkSets(): PokemonSet[] {
	if (zoroSets) return zoroSets;
	const out: PokemonSet[] = [];
	for (let seed = 1; out.length < 12 && seed < 20000; seed++) {
		const team = Teams.generate('gen9championsrandomdoublesbattle', { seed: seedFromInt(seed * 7919) } as never) as PokemonSet[];
		for (const s of team) if (s.species.startsWith('Zoroark')) out.push(s);
	}
	zoroSets = out;
	return out;
}

/** A random team with a Zoroark swapped in at a random position (no species clash). */
export function teamWithZoroark(seed: number): PokemonSet[] {
	const team = randomTeam(seed).filter(s => !s.species.startsWith('Zoroark'));
	const sets = zoroarkSets();
	const z = sets[seed % sets.length]!;
	const pos = seed % 6;
	const out = [...team.slice(0, 6)];
	out[pos] = { ...z, name: z.species };
	return out.slice(0, 6);
}

export function zoroarkBattle(seed: number, keepLog = true) {
	const p1 = randomTeam(seed * 2 + 1);
	const p2 = teamWithZoroark(seed * 2 + 2);
	return { battle: createBattle({ p1: { name: 'Alice', team: p1 }, p2: { name: 'Bob', team: p2 }, seed, keepLog }), p1, p2 };
}
