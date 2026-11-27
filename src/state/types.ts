/**
 * Battle state as a player knows it: everything public in the battle log, plus (for the
 * player's own side) whatever the player's own team sheet tells them. Nothing hidden.
 */

export type SideId = 'p1' | 'p2';
export type BoostId = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';

export interface Since {
	/** Turn number when the effect started (0 = before turn 1, e.g. on lead switch-in). */
	since: number;
}

/** A volatile effect on a Pokémon, with whatever detail the log gives about it. */
export interface VolatileInfo extends Since {
	/** The move involved: the disabled move, the trapping move, the move being charged or locked into. */
	move?: string;
	/** ident of the Pokémon that caused it (trapping, Helping Hand). */
	source?: string;
	/** Types after a type change (Protean, Soak, Mimicry, ...). */
	types?: string[];
	/** How many times it has applied (turns of an Outrage-style lock; stacked Helping Hands). */
	count?: number;
	/** Lasts only until the end of the turn (Helping Hand, Roost, Protect, ...). */
	singleTurn?: boolean;
	/** Lasts until the Pokémon's next move (Glaive Rush, Destiny Bond, ...). */
	singleMove?: boolean;
}

/** Things that reset when a Pokémon switches out. */
export interface StintState {
	/** Hits taken since switching in (Rage Fist; Champions resets this on switching). */
	timesAttacked: number;
	/** Moves used since switching in, with uses (Last Resort; a transformed Pokémon's 5 PP). */
	moves: Record<string, number>;
	/** Its item changed (gained, lost or swapped) after its last move: any Choice lock no longer holds. */
	itemChangedSinceMove?: boolean;
	/** It lost its item during this stint (Unburden). */
	itemLost?: boolean;
	/** Fainted allies when it came in (Supreme Overlord). */
	faintedAllies: number;
}

export interface ItemKnowledge {
	/** Item it is holding now, if known. `''` = known to hold nothing. `undefined` = unknown. */
	current?: string;
	/**
	 * Item it brought to the battle (team sheet item), if known. Survives consumption/removal and
	 * is what carries over to later games of a Bo3.
	 */
	original?: string;
	/** Set once something may have swapped items (Trick, Switcheroo, Thief, Bestow, Symbiosis...). */
	swapped: boolean;
	/** How the current item stopped being held, if it did. */
	lostVia?: 'consumed' | 'removed' | 'popped' | 'used';
	/** The item it lost most recently. */
	lostItem?: string;
}

export interface MonState {
	/** "p1: Nickname" (position-free identity). */
	ident: string;
	side: SideId;
	name: string;
	/** Current species/forme (e.g. "Garchomp-Mega-Z" after Mega Evolving). */
	species: string;
	/** Forme it returns to when switched out (changes only on permanent forme changes, e.g. Mega). */
	permanentSpecies?: string;
	/** Species as entered on the team (pre-Mega forme). */
	teamSpecies: string;
	level: number;
	gender: string;
	/** HP as shown. In spectator/opponent views maxHp is 100 (a percentage). */
	hp: number;
	maxHp: number;
	/**
	 * Champions shows opponents' HP as floor(percent). At exactly 20% or 50% Showdown adds a hint:
	 * 'g' = above 50%, 'y' = at/below 50% (or above 20% when showing 20), 'r' = at/below 20%.
	 */
	hpColor?: 'g' | 'y' | 'r';
	status: '' | 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox';
	statusSince?: number;
	boosts: Partial<Record<BoostId, number>>;
	/** Volatile effects by id (substitute, confusion, taunt, encore, leechseed, ...). */
	volatiles: Record<string, VolatileInfo>;
	/** Counters since it last switched in (while it is active). */
	stint?: StintState;
	/** Hit counter it comes back with if Revival Blessing revives it. */
	revivedHits?: number;
	fainted: boolean;
	/** 0-based active slot, or null if in the back. */
	activeSlot: number | null;
	/** Has this Pokémon been sent out this game? (i.e. we know it was brought) */
	seen: boolean;
	megaEvolved: boolean;
	/** Species it is transformed into (Transform/Imposter), while active. */
	transformedInto?: string;
	/** Revealed moves (by id) with how many times each was used. */
	moves: Record<string, { uses: number }>;
	/** Last move it used itself (not called by another move) since switching in, and on which turn. */
	lastMove?: string;
	lastMoveTurn?: number;
	/** Turn on which its action last failed (missed, had no effect, or it couldn't move): Stomping Tantrum. */
	failedTurn?: number;
	/** Ability it was revealed to have (current). */
	ability?: string;
	/** Base (team sheet) ability, when we can tell it apart from a changed one. */
	baseAbility?: string;
	/** Its ability has been changed this battle (Skill Swap, Trace, Mummy, ...): `ability` may not be its own. */
	abilityChanged?: boolean;
	/** Skill Swap between allies hides the abilities: it now has this Pokémon's (ident) ability. */
	abilityFrom?: string;
	item: ItemKnowledge;
	/** Turn this Pokémon last switched in. */
	switchedInTurn?: number;
}

export interface SideState {
	id: SideId;
	name: string;
	/** Species shown at team preview (the six brought to the match). */
	preview: string[];
	/** Pokémon known on this side (seen in battle, or from our own team sheet). */
	pokemon: MonState[];
	/** ident of the Pokémon in each active slot. */
	active: (string | null)[];
	/** Side conditions by id (tailwind, reflect, lightscreen, auroraveil, spikes...). */
	conditions: Record<string, Since & { layers?: number }>;
	megaUsed: boolean;
	/** Number of Pokémon brought (4 in bring-6-pick-4). */
	teamSize?: number;
	/** Turn on which one of its Pokémon last fainted (Retaliate). */
	lastFaintTurn?: number;
}

export interface FieldState {
	weather?: string;
	weatherSince?: number;
	terrain?: string;
	terrainSince?: number;
	/** trickroom, gravity, magicroom, wonderroom, ... */
	pseudoWeather: Record<string, Since>;
}

export interface KnownBattleState {
	/** Whose point of view (whose hidden info is known). Undefined = pure spectator. */
	perspective?: SideId;
	gameType: string;
	turn: number;
	sides: Record<SideId, SideState>;
	field: FieldState;
	ended: boolean;
	winner?: string;
}
