/**
 * Training examples from one replay: every turn, from each side's point of view, the features
 * (features.ts) with what that side chose (data/positions.ts) and who won.
 *
 * The side's own sets come from hindsight (data/bench.ts), with each set's move order shuffled
 * per game, so a move's slot says nothing about when it was revealed. Sides with a Zoroark of
 * their own are skipped for now: the log shows its disguise, and the bring order that would
 * resolve it isn't in a replay.
 */
import { BattleLogParser } from '../state/parser.js';
import { labelLog, type SlotLabel, type TurnLabel } from '../data/positions.js';
import { hindsightTeam, megasFromLog } from '../data/bench.js';
import type { SetPrior } from '../data/priors.js';
import { makeRng } from '../sim/play.js';
import { resolveFormat } from '../config.js';
import { toID, type PokemonSet } from '../showdown.js';
import type { SideId } from '../state/types.js';
import { ACTION_UNKNOWN, featurize, SWITCH_BASE, TARGET_UNKNOWN, type Features, type Vocab } from './features.js';

const TARGETED = new Set(['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf']);

export interface Example {
	turn: number;
	side: SideId;
	features: Features;
	/** action_a, target_a, mega_a, action_b, target_b, mega_b, result */
	labels: Int8Array;
}

function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

function shuffled<T>(xs: T[], rng: () => number): T[] {
	const a = [...xs];
	for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
	return a;
}

export function encodeSlot(l: SlotLabel | null | undefined, slot: number, f: Features): [action: number, target: number, mega: number] {
	if (!l || l.action === 'unknown') return [ACTION_UNKNOWN, 0, 0];
	const dex = resolveFormat().dex;
	if (l.action === 'switch') {
		const want = dex.species.get(l.species);
		let i = f.ownSpecies.findIndex(s => toID(s) === want.id);
		if (i < 0) i = f.ownSpecies.findIndex(s => dex.species.get(s).baseSpecies === want.baseSpecies);
		return [i < 0 ? ACTION_UNKNOWN : SWITCH_BASE + i, 0, 0];
	}
	const idx = (f.ownMoves[slot] ?? []).indexOf(l.move);
	if (idx < 0) return [ACTION_UNKNOWN, 0, 0];
	let target = 0;
	if (TARGETED.has(dex.moves.get(l.move).target)) {
		target = l.target === undefined ? TARGET_UNKNOWN : l.target > 0 ? l.target : -l.target - 1 === slot ? 4 : 3;
	}
	return [idx, target, l.mega ? 1 : 0];
}

export function gameExamples(id: string, log: string, vocab: Vocab, opts: { prior?: SetPrior } = {}): Example[] {
	const lines = log.split('\n');
	const labels = labelLog(lines);
	if (!labels.winner) return [];
	const megas = megasFromLog(lines);
	const byTurn = new Map<string, TurnLabel>(labels.turns.map(t => [`${t.turn}${t.side}`, t]));
	// Hindsight: own sets, and which of them were brought (seen at any point).
	const end = new BattleLogParser();
	for (const l of lines) end.feed(l);
	const own: Partial<Record<SideId, { sets: PokemonSet[]; brought: Set<string> }>> = {};
	for (const side of ['p1', 'p2'] as const) {
		const sets = hindsightTeam(lines, side, { prior: opts.prior, megaStones: megas[side] });
		if (sets.length < 4 || sets.some(s => /^Zoroark/.test(s.species))) continue;
		const rng = makeRng(hash(`${id}:${side}`));
		own[side] = {
			sets: sets.map(s => ({ ...s, moves: shuffled(s.moves, rng) })),
			brought: new Set(end.state.sides[side].pokemon.filter(m => m.seen).map(m => toID(m.teamSpecies))),
		};
	}
	const out: Example[] = [];
	const parser = new BattleLogParser();
	const rng = makeRng(hash(id));
	for (const line of lines) {
		parser.feed(line);
		if (!line.startsWith('|turn|')) continue;
		const turn = parser.state.turn;
		for (const side of ['p1', 'p2'] as const) {
			const o = own[side];
			const t = byTurn.get(`${turn}${side}`);
			if (!o || !t) continue;
			const features = featurize({ state: parser.state, me: side, ownSets: o.sets, ownBrought: o.brought, megaStones: megas, vocab, shuffle: m => shuffled(m, rng) });
			const a = encodeSlot(t.slots[0], 0, features), b = encodeSlot(t.slots[1], 1, features);
			out.push({ turn, side, features, labels: Int8Array.from([...a, ...b, labels.winner === side ? 1 : -1]) });
		}
	}
	return out;
}
