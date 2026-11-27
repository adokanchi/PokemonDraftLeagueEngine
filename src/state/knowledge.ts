/**
 * What has been learned about a team's hidden sets: carries over between games of a Bo3
 * (teams are locked for the whole set), and is the hard evidence the belief engine starts from.
 */
import type { KnownBattleState, SideId } from './types.js';

export interface PokemonKnowledge {
	/** Species as entered on the team (pre-Mega). */
	species: string;
	/** Revealed moves (ids). */
	moves: string[];
	/** Team-sheet ability, if revealed. */
	ability?: string;
	/** Team-sheet item, if revealed. */
	item?: string;
	/** Known to NOT have these (from the user, or inferred). */
	notMoves: string[];
	notItems: string[];
	notAbilities: string[];
	/** Exact stats learned some other way (e.g. "Primarina is 32 HP / 32 Def Bold"), optional. */
	statNotes?: string;
}

export type TeamKnowledge = Record<string, PokemonKnowledge>;

const uniq = (xs: string[]) => [...new Set(xs)];

function empty(species: string): PokemonKnowledge {
	return { species, moves: [], notMoves: [], notItems: [], notAbilities: [] };
}

/** Extract what a finished (or in-progress) game revealed about one side. */
export function knowledgeFromState(state: KnownBattleState, side: SideId): TeamKnowledge {
	const out: TeamKnowledge = {};
	for (const mon of state.sides[side].pokemon) {
		if (!mon.seen || mon.ident.endsWith('#illusion')) continue;
		const k = (out[mon.teamSpecies] ??= empty(mon.teamSpecies));
		k.moves = uniq([...k.moves, ...Object.keys(mon.moves)]);
		if (mon.baseAbility && mon.baseAbility !== 'illusion') k.ability ??= mon.baseAbility;
		if (mon.baseAbility === 'illusion') k.ability = 'illusion';
		if (mon.item.original !== undefined && mon.item.original !== '') k.item ??= mon.item.original;
	}
	return out;
}

/** Combine knowledge (e.g. game 1 + game 2). Later facts don't overwrite earlier ones. */
export function mergeKnowledge(...parts: TeamKnowledge[]): TeamKnowledge {
	const out: TeamKnowledge = {};
	for (const part of parts) {
		for (const [species, k] of Object.entries(part)) {
			const o = (out[species] ??= empty(species));
			o.moves = uniq([...o.moves, ...k.moves]);
			o.ability ??= k.ability;
			o.item ??= k.item;
			o.notMoves = uniq([...o.notMoves, ...k.notMoves]);
			o.notItems = uniq([...o.notItems, ...k.notItems]);
			o.notAbilities = uniq([...o.notAbilities, ...k.notAbilities]);
			o.statNotes ??= k.statNotes;
		}
	}
	return out;
}

/**
 * Hard inferences that follow from the rules alone:
 *  - Item clause: an item known on one Pokémon is excluded for all its teammates.
 *  - Four known moves: every other move is excluded (represented by `moves.length === 4`).
 */
export function applyRuleInferences(k: TeamKnowledge): TeamKnowledge {
	const out = mergeKnowledge(k);
	const knownItems = Object.values(out).filter(p => p.item).map(p => [p.species, p.item!] as const);
	for (const p of Object.values(out)) {
		const others = knownItems.filter(([s]) => s !== p.species).map(([, item]) => item);
		p.notItems = uniq([...p.notItems, ...others]);
	}
	return out;
}
