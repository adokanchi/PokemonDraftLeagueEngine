/**
 * Turning a position into numbers for the neural network.
 *
 * A position is one player's view at the start of a turn (the parser's state at `|turn|N`) plus
 * that player's own sets. It becomes:
 *  - 12 Pokémon tokens, own six then the opponent's six, each in team preview order, with
 *    MON_INTS ids (species, item, ability, 4 moves, status, position) and MON_FLOATS numbers;
 *  - GLOBAL_FLOATS numbers about the field, from the player's side first.
 * Ids index into the Vocab (0 = empty, 1 = unknown). Floats are in [-1, 1].
 *
 * The opponent's tokens hold only what's been revealed. The player's own tokens hold the full
 * sets, with flags saying which parts have been revealed to the opponent so far.
 *
 * The same featurize() serves training (own sets guessed with hindsight from a replay) and play
 * (own sets known), so the layout here is the contract with the Python side (layout.json).
 */
import { toID, type PokemonSet } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';
import type { KnownBattleState, MonState, SideId } from '../state/types.js';

export const UNKNOWN = 1;
export const NOTHING = 2; // item: known to hold nothing

export class Vocab {
	readonly species: string[];
	readonly moves: string[];
	readonly items: string[];
	readonly abilities: string[];
	private index: Record<'species' | 'moves' | 'items' | 'abilities', Map<string, number>>;

	constructor(format: ResolvedFormat = resolveFormat()) {
		const dex = format.dex;
		const ids = <T extends { id: string; exists: boolean }>(all: readonly T[]) => [...new Set(all.filter(x => x.exists).map(x => x.id))].sort();
		this.species = ['', '?', ...ids(dex.species.all())];
		this.moves = ['', '?', ...ids(dex.moves.all())];
		this.items = ['', '?', '(none)', ...ids(dex.items.all())];
		this.abilities = ['', '?', ...ids(dex.abilities.all())];
		const map = (l: string[]) => new Map(l.map((x, i) => [x, i] as const).filter(([x]) => x));
		this.index = { species: map(this.species), moves: map(this.moves), items: map(this.items), abilities: map(this.abilities) };
	}

	id(kind: 'species' | 'moves' | 'items' | 'abilities', name: string | undefined): number {
		if (name === undefined) return UNKNOWN;
		return this.index[kind].get(toID(name)) ?? UNKNOWN;
	}

	toJSON() { return { species: this.species, moves: this.moves, items: this.items, abilities: this.abilities }; }

	/**
	 * What each species and move is, for models that describe them by their properties rather than
	 * by id alone (so a new regulation's Pokémon aren't strangers). Rows follow the vocab order.
	 */
	properties(format: ResolvedFormat = resolveFormat()) {
		const dex = format.dex;
		const types = dex.types.all().filter(t => t.exists).map(t => t.id).sort();
		const typeId = (t: string | undefined) => (t ? types.indexOf(toID(t)) + 1 : 0);
		const targets = ['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf', 'self', 'allAdjacentFoes', 'allAdjacent', 'allySide', 'foeSide', 'all', 'allies', 'randomNormal', 'scripted', 'allyTeam'];
		const flags = ['contact', 'protect', 'sound', 'punch', 'bite', 'bullet', 'pulse', 'slicing', 'wind', 'powder', 'heal', 'recharge', 'charge'];
		const species = this.species.map(id => {
			const sp = id && id !== '?' ? dex.species.get(id) : undefined;
			if (!sp?.exists) return null;
			const b = sp.baseStats;
			return [typeId(sp.types[0]), typeId(sp.types[1]), b.hp, b.atk, b.def, b.spa, b.spd, b.spe, sp.weightkg, sp.isMega ? 1 : 0];
		});
		const moves = this.moves.map(id => {
			const m = id && id !== '?' ? dex.moves.get(id) : undefined;
			if (!m?.exists) return null;
			return [typeId(m.type), ['Physical', 'Special', 'Status'].indexOf(m.category), m.basePower, m.accuracy === true ? 101 : m.accuracy, m.priority,
				targets.indexOf(m.target), m.pp, ...flags.map(f => (m.flags as Record<string, number>)[f] ? 1 : 0)];
		});
		return {
			types,
			species: { columns: ['type1', 'type2', 'hp', 'atk', 'def', 'spa', 'spd', 'spe', 'weightkg', 'mega'], rows: species },
			moves: { columns: ['type', 'category', 'power', 'accuracy', 'priority', 'target', 'pp', ...flags], rows: moves, targets },
		};
	}
}

export const STATUSES = ['', 'brn', 'par', 'slp', 'frz', 'psn', 'tox'] as const;
export const BOOSTS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const;
/** Volatiles with their own feature; `perish`, `protosynthesis`, `quarkdrive` match by prefix. The last is "anything else". */
export const VOLATILES = [
	'substitute', 'confusion', 'taunt', 'encore', 'disable', 'leechseed', 'yawn', 'perish', 'focusenergy', 'saltcure',
	'curse', 'torment', 'healblock', 'throatchop', 'partiallytrapped', 'trapped', 'lockedmove', 'twoturnmove', 'charge',
	'glaiverush', 'flashfire', 'noretreat', 'transform', 'typechange', 'protosynthesis', 'quarkdrive', 'stockpile', 'other',
] as const;
export const WEATHERS = ['sunnyday', 'raindance', 'sandstorm', 'snowscape', 'desolateland', 'primordialsea', 'deltastream'] as const;
export const TERRAINS = ['electricterrain', 'grassyterrain', 'mistyterrain', 'psychicterrain'] as const;
export const PSEUDO = ['trickroom', 'gravity', 'magicroom', 'wonderroom'] as const;
/** Side conditions; the first TIMED have a duration feature, spikes/toxicspikes count layers. */
export const CONDITIONS = ['tailwind', 'reflect', 'lightscreen', 'auroraveil', 'safeguard', 'mist', 'spikes', 'toxicspikes', 'stealthrock', 'stickyweb'] as const;
const TIMED = 6;

export const MON_INTS = ['species', 'item', 'ability', 'move1', 'move2', 'move3', 'move4', 'status', 'position'] as const;
/** position: 0 not known to be brought, 1 in the back, 2 active slot a, 3 active slot b, 4 fainted. */
export const MON_FLOATS = [
	'hp', ...BOOSTS.map(b => `boost_${b}`), 'mega_evolved', 'can_mega', 'item_revealed', 'item_lost', 'ability_revealed',
	'move1_revealed', 'move2_revealed', 'move3_revealed', 'move4_revealed',
	'last_move1', 'last_move2', 'last_move3', 'last_move4', 'turns_in', 'times_hit', 'status_turns',
	...VOLATILES.map(v => `vol_${v}`),
] as const;
export const GLOBAL_FLOATS = [
	'turn', ...WEATHERS.map(w => `weather_${w}`), 'weather_turns', ...TERRAINS.map(t => `terrain_${t}`), 'terrain_turns',
	...PSEUDO.map(p => `${p}`), ...PSEUDO.map(p => `${p}_turns`),
	...(['me', 'foe'] as const).flatMap(s => [...CONDITIONS.map(c => `${s}_${c}`), ...CONDITIONS.slice(0, TIMED).map(c => `${s}_${c}_turns`), `${s}_mega_used`, `${s}_remaining`]),
] as const;
export const TOKENS = 12;

export interface Features {
	/** TOKENS × MON_INTS */
	ints: Int16Array;
	/** TOKENS × MON_FLOATS, then GLOBAL_FLOATS */
	floats: Float32Array;
	/** For each own active slot (a, b): the token's move order, to turn a chosen move into an index. */
	ownMoves: string[][];
	/** Own preview order (team species), for switch targets. */
	ownSpecies: string[];
}

export interface FeaturizeInput {
	state: KnownBattleState;
	me: SideId;
	/** Our sets, in our preview order. Their move order is the order of the move ids. */
	ownSets: PokemonSet[];
	/** Our Pokémon known to be brought (team species ids). Default: those seen so far. */
	ownBrought?: Set<string>;
	/** Team species -> Mega Stone, per side (drafted Megas are public). */
	megaStones?: Partial<Record<SideId, Record<string, string>>>;
	vocab: Vocab;
	/** Order for the opponent's revealed moves (default: as revealed). */
	shuffle?: (moves: string[]) => string[];
}

const clamp = (x: number) => Math.max(-1, Math.min(1, x));
const age = (turn: number, since: number | undefined) => (since === undefined ? 0 : clamp((turn - since) / 5));

function findMon(side: KnownBattleState['sides'][SideId], species: string, used: Set<MonState>): MonState | undefined {
	const id = toID(species);
	return side.pokemon.find(m => !used.has(m) && toID(m.teamSpecies) === id)
		?? side.pokemon.find(m => !used.has(m) && (toID(m.teamSpecies).startsWith(id) || id.startsWith(toID(m.teamSpecies))));
}

export function featurize(input: FeaturizeInput): Features {
	const { state, me, vocab } = input;
	const foe: SideId = me === 'p1' ? 'p2' : 'p1';
	const ints = new Int16Array(TOKENS * MON_INTS.length);
	const floats = new Float32Array(TOKENS * MON_FLOATS.length + GLOBAL_FLOATS.length);
	const ownMoves: string[][] = [[], []];
	const t = state.turn;
	const ownSpecies = input.ownSets.map(s => s.species);

	const fill = (token: number, side: SideId, species: string, mon: MonState | undefined, set: PokemonSet | undefined) => {
		const I = token * MON_INTS.length, F = token * MON_FLOATS.length;
		const s = state.sides[side];
		const own = side === me;
		ints[I] = vocab.id('species', mon?.species ?? species);
		// Item: what it holds now if known; own sets fill in the rest.
		const cur = mon?.item.current;
		const item = cur !== undefined ? cur : own ? set?.item ?? undefined : undefined;
		ints[I + 1] = item === '' ? NOTHING : vocab.id('items', item);
		const ability = mon?.ability ?? (own ? set?.ability : undefined);
		ints[I + 2] = vocab.id('abilities', ability);
		let moves: string[];
		if (own && set) moves = set.moves.map(toID).slice(0, 4);
		else {
			const revealed = Object.keys(mon?.moves ?? {}).slice(0, 4);
			moves = input.shuffle ? input.shuffle(revealed) : revealed;
		}
		for (let k = 0; k < 4; k++) ints[I + 3 + k] = moves[k] ? vocab.id('moves', moves[k]) : own ? 0 : UNKNOWN;
		ints[I + 7] = STATUSES.indexOf(mon?.status ?? '');
		const brought = own ? (input.ownBrought?.has(toID(species)) ?? !!mon?.seen) : !!mon?.seen;
		ints[I + 8] = mon?.fainted ? 4 : mon?.activeSlot === 0 ? 2 : mon?.activeSlot === 1 ? 3 : brought ? 1 : 0;
		if (own && mon?.activeSlot != null) ownMoves[mon.activeSlot] = moves;

		let f = F;
		floats[f++] = mon ? (mon.fainted ? 0 : mon.hp / (mon.maxHp || 100)) : 1;
		for (const b of BOOSTS) floats[f++] = (mon?.boosts[b] ?? 0) / 6;
		floats[f++] = mon?.megaEvolved ? 1 : 0;
		floats[f++] = input.megaStones?.[side]?.[species] && !s.megaUsed ? 1 : 0;
		floats[f++] = cur !== undefined || mon?.item.original !== undefined ? 1 : 0;
		floats[f++] = cur === '' ? 1 : 0;
		floats[f++] = mon?.ability ? 1 : 0;
		for (let k = 0; k < 4; k++) floats[f++] = moves[k] && mon?.moves[moves[k]!] ? 1 : 0;
		const last = mon?.lastMove ? moves.indexOf(toID(mon.lastMove)) : -1;
		for (let k = 0; k < 4; k++) floats[f++] = last === k ? 1 : 0;
		floats[f++] = mon?.activeSlot != null ? age(t, mon.switchedInTurn) : 0;
		floats[f++] = clamp((mon?.stint?.timesAttacked ?? 0) / 6);
		floats[f++] = mon?.status ? age(t, mon.statusSince) : 0;
		for (const k of Object.keys(mon?.volatiles ?? {})) {
			let v = VOLATILES.findIndex(x => k === x || k.startsWith(x));
			if (v < 0) v = VOLATILES.length - 1;
			floats[f + v] = 1;
		}
	};

	for (const [k, side] of ([me, foe] as const).entries()) {
		const s = state.sides[side];
		const preview = side === me ? ownSpecies : s.preview;
		const used = new Set<MonState>();
		for (let i = 0; i < 6; i++) {
			const species = preview[i];
			if (!species) continue;
			const mon = findMon(s, species, used);
			if (mon) used.add(mon);
			fill(k * 6 + i, side, species, mon, side === me ? input.ownSets[i] : undefined);
		}
	}

	let g = TOKENS * MON_FLOATS.length;
	const field = state.field;
	floats[g++] = Math.min(1, t / 20);
	for (const w of WEATHERS) floats[g++] = field.weather === w ? 1 : 0;
	floats[g++] = field.weather ? age(t, field.weatherSince) : 0;
	for (const x of TERRAINS) floats[g++] = field.terrain === x ? 1 : 0;
	floats[g++] = field.terrain ? age(t, field.terrainSince) : 0;
	for (const p of PSEUDO) floats[g++] = field.pseudoWeather[p] ? 1 : 0;
	for (const p of PSEUDO) floats[g++] = field.pseudoWeather[p] ? age(t, field.pseudoWeather[p]!.since) : 0;
	for (const side of [me, foe]) {
		const s = state.sides[side];
		for (const c of CONDITIONS) {
			const cond = s.conditions[c];
			floats[g++] = !cond ? 0 : c === 'spikes' ? (cond.layers ?? 1) / 3 : c === 'toxicspikes' ? (cond.layers ?? 1) / 2 : 1;
		}
		for (const c of CONDITIONS.slice(0, TIMED)) floats[g++] = s.conditions[c] ? age(t, s.conditions[c]!.since) : 0;
		floats[g++] = s.megaUsed ? 1 : 0;
		const fainted = s.pokemon.filter(m => m.fainted).length;
		floats[g++] = Math.max(0, (s.teamSize ?? 4) - fainted) / 4;
	}
	return { ints, floats, ownMoves, ownSpecies };
}

/** Label codes per active slot: action, target, mega. */
export const ACTION_UNKNOWN = -1;
/** action: 0–3 move index in the token's moves, 4–9 switch to own team index 0–5, -1 unknown. */
export const SWITCH_BASE = 4;
/** target: 0 none needed, 1 foe a, 2 foe b, 3 ally, 4 self, -1 the move needed one but the log didn't show it. */
export const TARGET_UNKNOWN = -1;

export function layout(vocab: Vocab) {
	return {
		version: 1,
		tokens: TOKENS,
		mon_ints: MON_INTS, mon_floats: MON_FLOATS, global_floats: GLOBAL_FLOATS,
		vocab_sizes: { species: vocab.species.length, moves: vocab.moves.length, items: vocab.items.length, abilities: vocab.abilities.length },
		statuses: STATUSES, volatiles: VOLATILES,
		labels: ['action_a', 'target_a', 'mega_a', 'action_b', 'target_b', 'mega_b', 'result'],
		label_codes: {
			action: '-1 unknown/none, 0-3 move index in the token\'s moves, 4-9 switch to own team index 0-5',
			target: '-1 needed but not shown, 0 none needed, 1 foe a, 2 foe b, 3 ally, 4 self',
			result: '+1 this side won, -1 lost',
		},
		meta: ['game', 'turn', 'side', 'rating', 'held_out'],
		floats_scale: 'stored as int8: value = stored / 127',
	};
}
