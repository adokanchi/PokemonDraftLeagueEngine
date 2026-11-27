/**
 * Thin in-process harness around Showdown's Battle: create, clone, inspect requests, submit
 * choices, enumerate legal choices. Search code works on these Battle objects directly.
 */
import { Battle, Teams, type PokemonSet } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';
import { enumerateChoices, type Request, type TargetContext } from './choices.js';

export type SideIndex = 0 | 1;

export interface PlayerSpec {
	name: string;
	/** Team as Showdown sets, or as an export/packed team string. */
	team: PokemonSet[] | string;
}

export interface CreateBattleOptions {
	format?: ResolvedFormat;
	p1: PlayerSpec;
	p2: PlayerSpec;
	/** Integer seed for reproducible battles (random if omitted). */
	seed?: number;
	/** Keep the protocol log (battle.log). Off by default for speed. */
	keepLog?: boolean;
}

export function seedFromInt(n: number): `${number},${string}` {
	const a = (n >>> 0) % 65536;
	const b = ((n >>> 16) ^ 0x5a5a) % 65536;
	const c = (Math.imul(n, 7) + 1) >>> 0 & 0xffff;
	const d = (Math.imul(n, 31) + 3) >>> 0 & 0xffff;
	return `${a},${b},${c},${d}`;
}

export function toTeam(team: PokemonSet[] | string): PokemonSet[] {
	if (typeof team !== 'string') return team;
	const sets = Teams.import(team);
	if (!sets) throw new Error('Could not parse team');
	return sets as PokemonSet[];
}

const noop = () => {};

export function createBattle(opts: CreateBattleOptions): Battle {
	const format = opts.format ?? resolveFormat();
	const battle = new Battle({
		formatid: format.formatId as never,
		seed: opts.seed === undefined ? undefined : seedFromInt(opts.seed),
		send: opts.keepLog ? undefined : noop,
		p1: { name: opts.p1.name, team: toTeam(opts.p1.team) as never },
		p2: { name: opts.p2.name, team: toTeam(opts.p2.team) as never },
	} as never);
	return battle;
}

/**
 * Deep copy of a battle (independent PRNG state included).
 *
 * Showdown's serializer hands back the *same* log array (state.log = battle.log), so a naive
 * fromJSON(toJSON()) copy appends to the original's log. Copies start with an empty log unless
 * `keepLog` is set (search never needs it).
 */
export function cloneBattle(battle: Battle, opts: { keepLog?: boolean } = {}): Battle {
	const state = battle.toJSON();
	state.log = opts.keepLog ? [...battle.log] : [];
	const copy = Battle.fromJSON(state);
	(copy as unknown as { send: unknown }).send = noop;
	return copy;
}

export function sideRequest(battle: Battle, side: SideIndex): Request | null {
	const s = battle.sides[side]!;
	if (!s.activeRequest || s.activeRequest.wait || s.isChoiceDone()) return null;
	return s.activeRequest as unknown as Request;
}

export function targetContext(battle: Battle, side: SideIndex): TargetContext {
	const s = battle.sides[side]!;
	const foe = s.foe;
	const alive = (p: { fainted: boolean } | null | undefined) => !!p && !p.fainted;
	return {
		foeAlive: foe.active.map(alive),
		selfAlive: s.active.map(alive),
	};
}

/**
 * Legal choice strings for a side right now (empty if it has nothing to choose).
 *
 * Uses the simulator's true state, which can be more than the player knows: a Pokémon trapped
 * by an unrevealed Shadow Tag/Arena Trap/Magnet Pull shows up in Showdown's request only as
 * `maybeTrapped`. Inside search every battle is a fully specified sample, so the truth is right;
 * what the *player* knows is the belief engine's job.
 */
export function legalChoices(battle: Battle, side: SideIndex): string[] {
	let req = sideRequest(battle, side);
	if (req?.active) {
		const active = battle.sides[side]!.active;
		// Copy: never mutate Showdown's stored request.
		req = { ...req, active: req.active.map((a, i) => (active[i]?.trapped ? { ...a, trapped: true } : a)) };
	}
	return enumerateChoices(req, targetContext(battle, side));
}

/** Does Showdown accept this choice? Leaves the battle unchanged. */
export function isAccepted(battle: Battle, side: SideIndex, choice: string): boolean {
	const s = battle.sides[side]!;
	const ok = s.choose(choice) && s.isChoiceDone();
	s.clearChoice();
	return ok;
}

/** Submit a choice; the turn runs once both sides have chosen. Returns false if Showdown rejects it. */
export function submit(battle: Battle, side: SideIndex, choice: string): boolean {
	const ok = battle.choose(battle.sides[side]!.id, choice);
	if (!ok) battle.sides[side]!.clearChoice();
	return ok;
}

export function sidesNeedingChoice(battle: Battle): SideIndex[] {
	return ([0, 1] as const).filter(i => sideRequest(battle, i) !== null);
}
