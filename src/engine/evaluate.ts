/**
 * Hand-written position score in [-1, 1] from one side's point of view (+1 = won).
 * A stand-in until a learned value network replaces it; the weights are deliberately simple.
 */
import type { Battle, Pokemon } from '../showdown.js';

export interface EvalWeights {
	alive: number;
	hp: number;
	boost: number;
	speedBoost: number;
	status: Record<string, number>;
	tailwind: number;
	screen: number;
	trickRoom: number;
	scale: number;
}

export const DEFAULT_WEIGHTS: EvalWeights = {
	alive: 0.6,
	hp: 0.4,
	boost: 0.05,
	speedBoost: 0.04,
	status: { par: -0.12, brn: -0.1, slp: -0.15, frz: -0.2, psn: -0.06, tox: -0.08 },
	tailwind: 0.15,
	screen: 0.06,
	trickRoom: 0.12,
	scale: 1.6,
};

function monScore(p: Pokemon, w: EvalWeights): number {
	if (p.fainted || p.hp <= 0) return 0;
	let s = w.alive + w.hp * (p.hp / p.maxhp);
	s += w.status[p.status] ?? 0;
	if (p.isActive) {
		const b = p.boosts;
		const offense = Math.max(b.atk, b.spa);
		s += w.boost * Math.max(-3, Math.min(3, offense));
		s += w.boost * 0.5 * Math.max(-3, Math.min(3, (b.def + b.spd) / 2));
		s += w.speedBoost * Math.max(-3, Math.min(3, b.spe));
	}
	return s;
}

function sideScore(battle: Battle, i: number, w: EvalWeights): number {
	const side = battle.sides[i]!;
	let s = 0;
	for (const p of side.pokemon) s += monScore(p, w);
	if (side.sideConditions.tailwind) s += w.tailwind;
	for (const sc of ['reflect', 'lightscreen', 'auroraveil']) if (side.sideConditions[sc]) s += w.screen;
	return s;
}

function avgSpeed(battle: Battle, i: number): number {
	const alive = battle.sides[i]!.pokemon.filter(p => !p.fainted && p.hp > 0);
	return alive.length ? alive.reduce((a, p) => a + p.storedStats.spe, 0) / alive.length : 0;
}

export function evaluate(battle: Battle, side: 0 | 1, w: EvalWeights = DEFAULT_WEIGHTS): number {
	if (battle.ended) {
		if (!battle.winner) return 0;
		return battle.winner === battle.sides[side]!.name ? 1 : -1;
	}
	let diff = sideScore(battle, side, w) - sideScore(battle, 1 - side, w);
	if (battle.field.pseudoWeather.trickroom) {
		const mine = avgSpeed(battle, side), theirs = avgSpeed(battle, 1 - side);
		diff += mine < theirs ? w.trickRoom : mine > theirs ? -w.trickRoom : 0;
	}
	return Math.tanh(diff / w.scale);
}
