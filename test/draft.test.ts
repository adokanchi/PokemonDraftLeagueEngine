import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lookupSpecies, parseRoster, validateRoster, validateTeam } from '../src/draft/validator.js';
import { toTeam } from '../src/sim/battle.js';
import type { PokemonSet } from '../src/showdown.js';

const rosters = JSON.parse(readFileSync('examples/rosters.json', 'utf8'));
const rosterA = parseRoster(rosters.a.pokemon, rosters.a.coach);
const rosterB = parseRoster(rosters.b.pokemon, rosters.b.coach);
const teamA = () => toTeam(readFileSync('examples/team-a.txt', 'utf8'));
const teamB = () => toTeam(readFileSync('examples/team-b.txt', 'utf8'));
const withSet = (team: PokemonSet[], i: number, patch: Partial<PokemonSet>) =>
	team.map((s, j) => (j === i ? { ...s, ...patch } : s));
const problems = (r: { problems: string[] }) => r.problems.join('\n');

describe('species lookup', () => {
	it('understands spoken Mega names', () => {
		expect(lookupSpecies('Mega Garchomp Z').name).toBe('Garchomp-Mega-Z');
		expect(lookupSpecies('Mega Charizard Y').name).toBe('Charizard-Mega-Y');
		expect(lookupSpecies('mega kangaskhan').name).toBe('Kangaskhan-Mega');
	});
});

describe('roster rules', () => {
	it('accepts the example rosters', () => {
		expect(validateRoster(rosterA)).toEqual({ valid: true, problems: [] });
		expect(validateRoster(rosterB)).toEqual({ valid: true, problems: [] });
	});
	it('maps Megas to the forme used on a team and the required stone', () => {
		const floette = rosterB.entries.find(e => e.species.name === 'Floette-Mega')!;
		expect(floette.teamSpecies).toBe('Floette-Eternal');
		expect(floette.megaStone).toBe('Floettite');
		expect(rosterA.entries[0]!.megaStone).toBe('Garchompite Z');
	});
	it('rule 1: roster size 9–10', () => {
		expect(problems(validateRoster(parseRoster(rosters.a.pokemon.slice(0, 8))))).toMatch(/8 Pokémon/);
		expect(problems(validateRoster(parseRoster([...rosters.a.pokemon, 'Pelipper'])))).toMatch(/11 Pokémon/);
	});
	it('rule 2: 1–2 Megas', () => {
		const none = rosters.a.pokemon.map((n: string) => (n === 'Mega Garchomp Z' ? 'Garchomp' : n));
		expect(problems(validateRoster(parseRoster(none)))).toMatch(/0 Mega/);
		const three = [...rosters.b.pokemon];
		three[2] = 'Mega Gengar'; // Charizard Y + Floette + Gengar
		expect(problems(validateRoster(parseRoster(three)))).toMatch(/3 Mega/);
	});
	it('rule 4: one Pokémon per National Dex number', () => {
		const dup = [...rosters.b.pokemon.slice(0, 8), 'Charizard'];
		expect(problems(validateRoster(parseRoster(dup)))).toMatch(/share National Dex #6/);
		const slow = [...rosters.a.pokemon.slice(0, 8), 'Slowbro', 'Slowbro-Galar'];
		expect(problems(validateRoster(parseRoster(slow)))).toMatch(/Slowbro and Slowbro-Galar share/);
	});
	it('rejects unknown and in-battle formes', () => {
		const bad = [...rosters.a.pokemon.slice(0, 8), 'Aegislash-Blade', 'Notamon'];
		const p = problems(validateRoster(parseRoster(bad)));
		expect(p).toMatch(/Aegislash-Blade is an in-battle forme/);
		expect(p).toMatch(/Notamon is not a Pokémon/);
	});
});

describe('team rules', () => {
	it('accepts the example teams', () => {
		expect(validateTeam(teamA(), rosterA)).toEqual({ valid: true, problems: [] });
		expect(validateTeam(teamB(), rosterB)).toEqual({ valid: true, problems: [] });
	});
	it('rule 3: a drafted Mega must hold its own stone', () => {
		const t = withSet(teamA(), 0, { item: 'Garchompite' });
		expect(problems(validateTeam(t, rosterA))).toMatch(/must hold Garchompite Z/);
	});
	it('rule 3: a non-Mega cannot hold a Mega Stone', () => {
		const t = withSet(teamA(), 4, { species: 'Tyranitar', ability: 'Sand Stream', item: 'Tyranitarite', moves: ['Rock Slide'] });
		expect(problems(validateTeam(t, rosterA))).toMatch(/wasn't drafted as a Mega/);
	});
	it('team members must come from the roster', () => {
		const t = withSet(teamA(), 5, { species: 'Pelipper', ability: 'Drizzle', item: 'Damp Rock', moves: ['Hurricane'] });
		expect(problems(validateTeam(t, rosterA))).toMatch(/Pelipper is not on the roster/);
	});
	it("defers to Showdown's validator for stat points and item clause", () => {
		const over = withSet(teamA(), 1, { evs: { hp: 32, atk: 32, def: 32, spa: 0, spd: 0, spe: 0 } });
		expect(validateTeam(over, rosterA).valid).toBe(false);
		const dupItem = withSet(teamA(), 2, { item: 'Sitrus Berry' });
		expect(problems(validateTeam(dupItem, rosterA))).toMatch(/Sitrus Berry/);
	});
});
