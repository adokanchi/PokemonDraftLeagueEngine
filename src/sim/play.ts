/** Policies and a game loop for bot-vs-bot battles (benchmarks, tests, later: self-play). */
import type { Battle } from '../showdown.js';
import { legalChoices, sidesNeedingChoice, submit, type SideIndex } from './battle.js';

export interface Policy {
	choose(battle: Battle, side: SideIndex, options: string[]): string;
}

/** Small fast deterministic PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
	let t = seed >>> 0;
	return () => {
		t = (t + 0x6d2b79f5) >>> 0;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

export class RandomPolicy implements Policy {
	constructor(private rng: () => number = Math.random) {}
	choose(_battle: Battle, _side: SideIndex, options: string[]): string {
		return options[Math.floor(this.rng() * options.length)]!;
	}
}

export interface PlayResult {
	winner: string | undefined;
	turns: number;
	decisions: number;
}

/** Play until the battle ends (or maxTurns). Throws if a policy picks an option Showdown rejects. */
export function playOut(battle: Battle, policies: [Policy, Policy], maxTurns = 300): PlayResult {
	let decisions = 0;
	while (!battle.ended && battle.turn <= maxTurns) {
		const pending = sidesNeedingChoice(battle);
		if (!pending.length) throw new Error(`Battle stuck at turn ${battle.turn}: no side has a request`);
		for (const side of pending) {
			const options = legalChoices(battle, side);
			if (!options.length) throw new Error(`No legal choices for side ${side} at turn ${battle.turn}`);
			const choice = policies[side]!.choose(battle, side, options);
			if (!submit(battle, side, choice)) {
				throw new Error(`Showdown rejected "${choice}" for side ${side} at turn ${battle.turn}`);
			}
			decisions++;
			if (battle.ended) break;
		}
	}
	return { winner: battle.winner || undefined, turns: battle.turn, decisions };
}
