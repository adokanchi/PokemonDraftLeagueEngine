import { describe, expect, it } from 'vitest';
import type { Battle } from '../src/showdown.js';
import {
	cloneBattle, isAccepted, legalChoices, sideRequest, sidesNeedingChoice, submit, targetContext, type SideIndex,
} from '../src/sim/battle.js';
import { teamPreviewChoices, type Request } from '../src/sim/choices.js';
import { makeRng, playOut, RandomPolicy } from '../src/sim/play.js';
import { randomBattle } from './helpers.js';

/** Every syntactically possible choice string for one slot (superset of what is legal). */
function bruteSlotCandidates(req: Request): string[] {
	const out = ['pass'];
	for (let k = 1; k <= req.side.pokemon.length; k++) out.push(`switch ${k}`);
	if (!req.forceSwitch) {
		for (let m = 1; m <= 4; m++) {
			for (const t of ['', ' 1', ' 2', ' -1', ' -2']) {
				out.push(`move ${m}${t}`, `move ${m}${t} mega`);
			}
		}
	}
	return out;
}

/**
 * Brute-force the set of joint choices Showdown accepts, then drop redundant variants the
 * enumerator intentionally omits (a target on a move that takes none; aiming at a fainted slot).
 */
function acceptedChoices(battle: Battle, side: SideIndex): Set<string> {
	const req = sideRequest(battle, side)!;
	const ctx = targetContext(battle, side);
	const nSlots = req.forceSwitch?.length ?? req.active!.length;
	const slot = bruteSlotCandidates(req);
	let joint = [''];
	for (let i = 0; i < nSlots; i++) joint = joint.flatMap(p => slot.map(c => (p ? `${p}, ${c}` : c)));
	const accepted = new Set<string>();
	for (const c of joint) {
		if (!isAccepted(battle, side, c)) continue;
		const parts = c.split(', ');
		let redundant = false;
		parts.forEach((p, i) => {
			const m = /^move (\d)( -?\d)?( mega)?$/.exec(p);
			if (!m) return;
			const move = req.active![i]!.moves[Number(m[1]) - 1]!;
			const needsTarget = ['normal', 'any', 'adjacentAlly', 'adjacentAllyOrSelf', 'adjacentFoe'].includes(move.target ?? '');
			if (m[2] && !needsTarget) redundant = true;
			if (m[2] && needsTarget) {
				const loc = Number(m[2]);
				const isAlive = (l: number) => (l > 0 ? ctx.foeAlive[l - 1] : ctx.selfAlive[-l - 1]) === true;
				const self = -(i + 1);
				const ally = i === 0 ? -2 : -1;
				const valid = move.target === 'adjacentFoe' ? [1, 2] :
					move.target === 'adjacentAlly' ? [ally] :
					move.target === 'adjacentAllyOrSelf' ? [self, ally] : [1, 2, ally];
				// Dead targets are redundant unless no valid target is alive at all.
				if (!isAlive(loc) && valid.some(isAlive)) redundant = true;
				// With no valid target alive, the enumerator keeps exactly one representative.
				if (!valid.some(isAlive) && loc !== valid[0]) redundant = true;
			}
		});
		if (!redundant) accepted.add(c);
	}
	return accepted;
}

describe('legal choice enumeration', () => {
	it('team preview offers 90 bring-4 options, all accepted', () => {
		const battle = randomBattle(1);
		const req = sideRequest(battle, 0)!;
		expect(req.teamPreview).toBe(true);
		const opts = teamPreviewChoices(req);
		expect(opts).toHaveLength(90);
		for (const o of opts) expect(isAccepted(battle, 0, o)).toBe(true);
	});

	it('every enumerated choice is accepted by Showdown, across random battles', () => {
		let checked = 0;
		for (let seed = 1; seed <= 25; seed++) {
			const battle = randomBattle(seed);
			const rng = makeRng(seed);
			while (!battle.ended && battle.turn < 60) {
				for (const side of sidesNeedingChoice(battle)) {
					const opts = legalChoices(battle, side);
					expect(opts.length).toBeGreaterThan(0);
					for (const o of opts) {
						const ok = isAccepted(battle, side, o);
						if (!ok) throw new Error(`seed ${seed} turn ${battle.turn}: rejected "${o}"`);
						checked++;
					}
					submit(battle, side, opts[Math.floor(rng() * opts.length)]!);
					if (battle.ended) break;
				}
			}
		}
		expect(checked).toBeGreaterThan(1000);
	});

	it('enumeration is complete: matches brute force (minus redundant variants)', () => {
		let compared = 0;
		for (let seed = 101; seed <= 108; seed++) {
			const battle = randomBattle(seed);
			const rng = makeRng(seed);
			while (!battle.ended && battle.turn < 40) {
				for (const side of sidesNeedingChoice(battle)) {
					const req = sideRequest(battle, side)!;
					const opts = legalChoices(battle, side);
					if (!req.teamPreview && !req.active?.some(a => a.maybeTrapped)) {
						const brute = acceptedChoices(battle, side);
						const mine = new Set(opts);
						const missing = [...brute].filter(c => !mine.has(c));
						const extra = [...mine].filter(c => !brute.has(c));
						if (missing.length || extra.length) {
							const info = battle.sides[side]!.active.map(p => `${p.name}${p.fainted ? ' (fnt)' : ''}`);
							throw new Error(`seed ${seed} turn ${battle.turn} side ${side}: missing ${missing.slice(0, 5)} ` +
								`extra ${extra.slice(0, 5)}\nactive: ${info}\nrequest: ${JSON.stringify(req.active ?? req.forceSwitch)}`);
						}
						compared++;
					}
					submit(battle, side, opts[Math.floor(rng() * opts.length)]!);
					if (battle.ended) break;
				}
			}
		}
		expect(compared).toBeGreaterThan(50);
	});
});

describe('battle harness', () => {
	it('random battles run to completion', () => {
		for (let seed = 200; seed < 210; seed++) {
			const battle = randomBattle(seed);
			const rng = makeRng(seed);
			const res = playOut(battle, [new RandomPolicy(rng), new RandomPolicy(rng)]);
			expect(battle.ended).toBe(true);
			expect(res.turns).toBeGreaterThan(0);
		}
	});

	it('clones are independent and replay identically', () => {
		const battle = randomBattle(300);
		const rng = makeRng(1);
		// advance a few turns
		while (battle.turn < 3 && !battle.ended) {
			for (const side of sidesNeedingChoice(battle)) {
				const o = legalChoices(battle, side);
				submit(battle, side, o[Math.floor(rng() * o.length)]!);
			}
		}
		const a = cloneBattle(battle);
		const b = cloneBattle(battle);
		const play = (x: Battle) => playOut(x, [new RandomPolicy(makeRng(9)), new RandomPolicy(makeRng(10))]);
		const ra = play(a);
		const rb = play(b);
		expect(ra).toEqual(rb);
		expect(battle.ended).toBe(false); // original untouched
	});

	it('copies never touch the original (log, HP, PRNG), even after many copy-and-step cycles', () => {
		const battle = randomBattle(301, true);
		const rng = makeRng(2);
		while (battle.turn < 3 && !battle.ended) {
			for (const side of sidesNeedingChoice(battle)) {
				const o = legalChoices(battle, side);
				submit(battle, side, o[Math.floor(rng() * o.length)]!);
			}
		}
		const before = JSON.stringify(battle.toJSON());
		const logLen = battle.log.length;
		for (let i = 0; i < 300; i++) {
			const c = cloneBattle(battle);
			const start = c.turn;
			while (!c.ended && c.turn === start) {
				for (const side of sidesNeedingChoice(c)) {
					const o = legalChoices(c, side);
					submit(c, side, o[Math.floor(rng() * o.length)]!);
				}
			}
		}
		expect(battle.log.length).toBe(logLen);
		expect(JSON.stringify(battle.toJSON())).toBe(before);
	});
});
