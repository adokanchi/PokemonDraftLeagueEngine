/**
 * League draft rules, checked on top of Showdown's own validator for the format.
 *
 *  1. Each roster has 9–10 Pokémon.
 *  2. Each roster has 1–2 Mega Evolutions.
 *  3. A Pokémon drafted as a Mega must hold its Mega Stone; one not drafted as a Mega can't hold any Mega Stone.
 *  4. No two roster entries share a National Dex number.
 *  + The six brought must come from the roster and pass Showdown's validator for the format
 *    (moves, abilities, items, stat points, item clause, species clause, ...).
 */
import { Dex, TeamValidator, type PokemonSet, type Species } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';

export interface LeagueRules {
	rosterSize: { min: number; max: number };
	megas: { min: number; max: number };
	teamSize: number;
}

export const DEFAULT_LEAGUE_RULES: LeagueRules = {
	rosterSize: { min: 9, max: 10 },
	megas: { min: 1, max: 2 },
	teamSize: 6,
};

export interface RosterEntry {
	/** Name as written in the roster, e.g. "Garchomp-Mega-Z", "Mega Charizard Y", "Slowbro-Galar". */
	input: string;
	species: Species;
	/** Drafted as a Mega: the Mega forme. */
	isMega: boolean;
	/** For Mega entries, the stone it must hold. */
	megaStone?: string;
	/** The species the Pokémon is entered as on a team (base forme for Megas). */
	teamSpecies: string;
}

export interface Roster {
	coach?: string;
	entries: RosterEntry[];
}

export interface ValidationResult {
	valid: boolean;
	problems: string[];
}

/** Accepts Showdown names ("Garchomp-Mega-Z") and spoken forms ("Mega Garchomp Z"). */
export function lookupSpecies(name: string, format: ResolvedFormat = resolveFormat()): Species {
	const dex = format.dex;
	let species = dex.species.get(name);
	if (!species.exists) {
		const m = /^mega\s+(.+?)(?:\s+([XYZ]))?$/i.exec(name.trim());
		if (m) species = dex.species.get(`${m[1]}-Mega${m[2] ? `-${m[2].toUpperCase()}` : ''}`);
	}
	return species;
}

function speciesLegalityProblem(species: Species, format: ResolvedFormat): string | null {
	const ruleTable = Dex.formats.getRuleTable(Dex.formats.get(format.formatId));
	if (!species.exists) return 'is not a Pokémon';
	if (species.battleOnly && !species.isMega) return `is an in-battle forme (draft ${typeof species.battleOnly === 'string' ? species.battleOnly : species.baseSpecies} instead)`;
	if (species.isNonstandard) return `is not available in ${format.formatId}`;
	if (ruleTable.isBannedSpecies(species)) return `is banned in ${format.formatId}`;
	if (species.isMega) {
		const stone = format.dex.items.get(species.requiredItem ?? '');
		if (!stone.exists || stone.isNonstandard) return `has no legal Mega Stone in ${format.formatId}`;
	}
	return null;
}

/** The forme a Mega is entered as on a team (Floette-Mega -> Floette-Eternal, Charizard-Mega-Y -> Charizard). */
export function megaBaseForme(species: Species): string {
	return typeof species.battleOnly === 'string' ? species.battleOnly : species.baseSpecies;
}

export function parseRoster(names: string[], coach?: string, format: ResolvedFormat = resolveFormat()): Roster {
	return {
		coach,
		entries: names.map(input => {
			const species = lookupSpecies(input, format);
			const isMega = !!species.isMega;
			return {
				input,
				species,
				isMega,
				megaStone: isMega ? species.requiredItem : undefined,
				teamSpecies: isMega ? megaBaseForme(species) : species.name,
			};
		}),
	};
}

export function validateRoster(
	roster: Roster, rules: LeagueRules = DEFAULT_LEAGUE_RULES, format: ResolvedFormat = resolveFormat(),
): ValidationResult {
	const problems: string[] = [];
	const n = roster.entries.length;
	if (n < rules.rosterSize.min || n > rules.rosterSize.max) {
		problems.push(`Roster has ${n} Pokémon; it must have ${rules.rosterSize.min}–${rules.rosterSize.max}.`);
	}
	const megas = roster.entries.filter(e => e.isMega).length;
	if (megas < rules.megas.min || megas > rules.megas.max) {
		problems.push(`Roster has ${megas} Mega Evolutions; it must have ${rules.megas.min}–${rules.megas.max}.`);
	}
	const byNum = new Map<number, string[]>();
	for (const e of roster.entries) {
		const p = speciesLegalityProblem(e.species, format);
		if (p) problems.push(`${e.input} ${p}.`);
		if (!e.species.exists) continue;
		byNum.set(e.species.num, [...(byNum.get(e.species.num) ?? []), e.species.name]);
	}
	for (const [num, names] of byNum) {
		if (names.length > 1) problems.push(`${names.join(' and ')} share National Dex #${num}; only one is allowed.`);
	}
	return { valid: problems.length === 0, problems };
}

/** Match a team set to its roster entry (by base forme for Megas, exact forme otherwise). */
export function rosterEntryFor(set: PokemonSet, roster: Roster, format: ResolvedFormat = resolveFormat()): RosterEntry | undefined {
	const species = format.dex.species.get(set.species);
	const teamName = species.isMega ? megaBaseForme(species) : species.name;
	return roster.entries.find(e => e.teamSpecies === teamName);
}

export function validateTeam(
	team: PokemonSet[], roster: Roster, rules: LeagueRules = DEFAULT_LEAGUE_RULES, format: ResolvedFormat = resolveFormat(),
): ValidationResult {
	const problems: string[] = [];
	if (team.length !== rules.teamSize) problems.push(`Team has ${team.length} Pokémon; it must have ${rules.teamSize}.`);
	for (const set of team) {
		const entry = rosterEntryFor(set, roster, format);
		const name = set.name || set.species;
		if (!entry) {
			problems.push(`${name} is not on the roster.`);
			continue;
		}
		const item = format.dex.items.get(set.item);
		if (entry.isMega) {
			if (item.name !== entry.megaStone) {
				problems.push(`${name} was drafted as ${entry.species.name}, so it must hold ${entry.megaStone} (has ${set.item || 'no item'}).`);
			}
		} else if (item.megaStone) {
			problems.push(`${name} wasn't drafted as a Mega, so it can't hold ${item.name}.`);
		}
	}
	// Showdown's validator mutates sets, so give it a copy. Megas are entered as base forme + stone.
	const copy = team.map(s => {
		const sp = format.dex.species.get(s.species);
		return { ...structuredClone(s), species: sp.isMega ? megaBaseForme(sp) : s.species };
	});
	const showdownProblems = TeamValidator.get(format.formatId).validateTeam(copy as never) ?? [];
	problems.push(...showdownProblems);
	return { valid: problems.length === 0, problems };
}
