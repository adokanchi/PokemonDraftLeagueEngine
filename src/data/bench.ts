/**
 * Benchmarking the engine on replays: rebuild a position from one player's point of view, ask the
 * engine what to do, and compare with what that player actually chose (src/data/positions.ts).
 *
 * A replay is a spectator's view, so the player's own sets aren't in it. They're filled in with
 * hindsight: everything that side revealed over the whole game, plus the prior for the rest (the
 * same guess the opponent would make at the end). The opponent is modelled from the log up to the
 * turn, as in a real game. Drafted Megas are public in draft league, so both sides' Mega Stones
 * are given up front.
 */
import { OpponentModel } from '../belief/sets.js';
import { legalChoices } from '../sim/battle.js';
import type { SetPrior } from './priors.js';
import { toID, type PokemonSet } from '../showdown.js';
import type { SideId } from '../state/types.js';
import type { SolveInput } from '../engine/solver.js';
import type { SlotLabel } from './positions.js';
import type { Battle } from '../showdown.js';
import { resolveFormat } from '../config.js';

const baseId = (species: string) => toID(resolveFormat().dex.species.get(species).baseSpecies || species);

const other = (s: SideId): SideId => (s === 'p1' ? 'p2' : 'p1');

/** Team species -> Mega Stone, for every Pokémon that Mega Evolved in the log. */
export function megasFromLog(lines: string[]): Record<SideId, Record<string, string>> {
	const out: Record<SideId, Record<string, string>> = { p1: {}, p2: {} };
	const speciesAt: Record<string, string> = {};
	for (const line of lines) {
		const p = line.split('|');
		if ((p[1] === 'switch' || p[1] === 'drag') && p[2]) speciesAt[p[2].replace(/^(p[12])[ab]:/, '$1:')] = p[3]!.split(',')[0]!.trim();
		if (p[1] === '-mega' && p[2] && p[4]) {
			const side = p[2].slice(0, 2) as SideId;
			const species = speciesAt[p[2].replace(/^(p[12])[ab]:/, '$1:')] ?? p[3]!;
			out[side][species] = p[4];
		}
	}
	return out;
}

/** Best guess at all six of a side's sets, from the whole game (preview order). */
export function hindsightTeam(lines: string[], side: SideId, opts: { prior?: SetPrior; megaStones?: Record<string, string>; seed?: number } = {}): PokemonSet[] {
	const model = new OpponentModel({ side, ownTeam: [], prior: opts.prior, megaStones: opts.megaStones, seed: opts.seed });
	for (const line of lines) model.feed(line);
	const out: PokemonSet[] = [];
	for (const species of model.state.sides[side].preview) {
		const set = model.posterior(species)[0]?.set;
		if (set) out.push({ ...set, name: species, species });
	}
	return out;
}

/**
 * The engine's input for `side`'s decision at the start of `turn`, or a reason it can't be built.
 */
export function benchInput(lines: string[], turn: number, side: SideId, opts: { prior?: SetPrior; samples?: number; keep?: number; seed?: number } = {}):
	{ input: SolveInput } | { skip: string } {
	const megas = megasFromLog(lines);
	const ownTeam = hindsightTeam(lines, side, { prior: opts.prior, megaStones: megas[side], seed: opts.seed });
	if (ownTeam.length < 4) return { skip: 'own team incomplete' };
	if (ownTeam.some(s => /^Zoroark/.test(s.species))) return { skip: 'own Zoroark (bring order unknown)' };
	const model = new OpponentModel({ side: other(side), ownTeam, megaStones: megas[other(side)], prior: opts.prior, seed: opts.seed });
	// The four brought: those that appeared in the game (in order), then the rest of the team.
	const full = new OpponentModel({ side, ownTeam: [], prior: opts.prior, seed: opts.seed });
	for (const line of lines) full.feed(line);
	let reached = false;
	for (const line of lines) {
		model.feed(line);
		if (line === `|turn|${turn}`) { reached = true; break; }
	}
	if (!reached) return { skip: 'turn not in log' };
	const seen = full.state.sides[side].pokemon.filter(m => m.seen).map(m => toID(m.teamSpecies));
	const myTeam: PokemonSet[] = [];
	for (const id of [...seen, ...ownTeam.map(s => toID(s.species))]) {
		const s = ownTeam.find(t => toID(t.species) === id);
		if (s && !myTeam.includes(s) && myTeam.length < 4) myTeam.push(s);
	}
	return { input: { state: model.state, me: side, myTeam, model, options: { samples: opts.samples ?? 6, keep: opts.keep ?? 12, seed: opts.seed } } };
}

/** One slot's part of a choice: `move:<id>` or `switch:<species>`, and the move's target. */
export interface SlotAction { key: string; kind: 'move' | 'switch' | 'other'; target?: number }

export function slotActions(battle: Battle, me: SideId, choice: string): SlotAction[] {
	const s = battle.sides[me === 'p1' ? 0 : 1]!;
	return choice.split(', ').map((part, slot) => {
		const m = /^move (\d)(?: (-?\d))?/.exec(part);
		if (m) return { key: `move:${s.active[slot]?.moveSlots[Number(m[1]) - 1]?.id ?? '?'}`, kind: 'move', target: m[2] ? Number(m[2]) : undefined };
		const sw = /^switch (\d)/.exec(part);
		if (sw) return { key: `switch:${baseId(s.pokemon[Number(sw[1]) - 1]?.species.name ?? '?')}`, kind: 'switch' };
		return { key: part, kind: 'other' };
	});
}

export function labelKey(l: SlotLabel): string | undefined {
	if (l.action === 'move') return `move:${l.move}`;
	if (l.action === 'switch') return `switch:${baseId(l.species)}`;
	return undefined;
}

/** Does the engine's slot action match the label? `action`: same move / a switch; `full`: also same target / same Pokémon. */
export function agreement(a: SlotAction, l: SlotLabel): { action: boolean; full: boolean } {
	if (l.action === 'move') {
		const action = a.key === `move:${l.move}`;
		return { action, full: action && (l.target === undefined || a.target === undefined || a.target === l.target) };
	}
	if (l.action === 'switch') {
		const action = a.kind === 'switch';
		return { action, full: action && a.key === `switch:${baseId(l.species)}` };
	}
	return { action: false, full: false };
}

/** Each slot's distinct legal actions in the rebuilt position. */
export function legalSlotActions(battle: Battle, me: SideId): SlotAction[][] {
	const legal = legalChoices(battle, me === 'p1' ? 0 : 1);
	const out: Map<string, SlotAction>[] = [];
	for (const c of legal) {
		const parts = c.split(', ');
		slotActions(battle, me, c).forEach((a, i) => { (out[i] ??= new Map()).set(parts[i]!, a); });
	}
	return out.map(m => [...m.values()]);
}
