import { expect, it as test } from 'vitest';
import { legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng } from '../src/sim/play.js';
import { viewOfLog } from '../src/state/parser.js';
import { labelLog } from '../src/data/positions.js';
import { randomBattle } from './helpers.js';
import { toID } from '../src/showdown.js';

test('replay choice labels match what was submitted', () => {
	let slots = 0, known = 0, wrong = 0;
	for (let seed = 1; seed <= 25; seed++) {
		const b = randomBattle(seed, true); const rng = makeRng(seed);
		const truth: Record<string, ({ move?: string; target?: number; switchTo?: string } | null)[]> = {};
		while (!b.ended && b.turn < 40) for (const s of sidesNeedingChoice(b)) {
			const c = (o => o[Math.floor(rng() * o.length)]!)(legalChoices(b, s));
			const side = b.sides[s]!;
			if (!side.activeRequest?.forceSwitch && !side.activeRequest?.teamPreview && b.turn > 0) {
				truth[`${b.turn}${side.id}`] = c.split(', ').map((part, slot) => {
					const m = /^move (\d+)(?: (-?\d))?/.exec(part); const sw = /^switch (\d)/.exec(part);
					if (m) return { move: side.active[slot]?.moveSlots[Number(m[1]) - 1]?.id, target: m[2] ? Number(m[2]) : undefined };
					if (sw) return { switchTo: side.pokemon[Number(sw[1]) - 1]?.species.name };
					return null;
				});
			}
			submit(b, s, c); if (b.ended) break;
		}
		if (b.sides.some(s => s.pokemon.some(p => ['Zoroark', 'Ditto'].includes(p.baseSpecies.baseSpecies)))) continue;
		const labels = labelLog(viewOfLog(b.log));
		expect(labels.winner).toBeTruthy();
		for (const t of labels.turns) t.slots.forEach((l, slot) => {
			const want = truth[`${t.turn}${t.side}`]?.[slot];
			if (!l || !want) return;
			slots++;
			if (l.action === 'unknown') return;
			known++;
			const ok = l.action === 'move' ? toID(want.move ?? '') === l.move && (l.target === undefined || want.target === undefined || l.target === want.target)
				: want.switchTo?.split('-')[0] === l.species.split('-')[0];
			if (!ok) wrong++;
		});
	}
	expect(wrong).toBe(0);
	expect(known / slots).toBeGreaterThan(0.8);
});

test('Ally Switch, Illusion, failed moves, locked moves and confusion self-hits', () => {
	const log = `|player|p1|A|
|player|p2|B|
|switch|p1a: end of the horizon|Lucario, L50, M|100/100
|switch|p1b: anime swordsman|Gholdengo, L50|100/100
|switch|p2a: Sneasler|Sneasler, L50, F|100/100
|switch|p2b: Arcanine|Arcanine, L50, M|100/100
|turn|1
|
|switch|p2a: Mawile|Mawile, L50, F|100/100
|move|p1a: end of the horizon|Protect|p1a: end of the horizon
|move|p1b: anime swordsman|Protect|p1b: anime swordsman
|move|p2b: Arcanine|Protect|p2b: Arcanine
|
|upkeep
|turn|2
|
|move|p1b: anime swordsman|Ally Switch|p1b: anime swordsman
|swap|p1b: anime swordsman|0|[from] move: Ally Switch
|move|p2a: Mawile|Sucker Punch||[still]
|-fail|p2a: Mawile
|move|p1a: anime swordsman|Shadow Ball|p2a: Mawile
|-damage|p2a: Mawile|0 fnt
|replace|p2a: Zoroark|Zoroark-Hisui, L50, F
|-end|p2a: Zoroark|Illusion
|faint|p2a: Zoroark
|move|p1b: end of the horizon|Aura Sphere|p2b: Arcanine
|-damage|p2b: Arcanine|1/100
|-activate|p2b: Arcanine|confusion
|-damage|p2b: Arcanine|0 fnt|[from] confusion
|faint|p2b: Arcanine
|
|upkeep
|turn|3
|
|move|p1b: end of the horizon|Electro Shot|p2a: Sneasler|[from] lockedmove
|move|p1a: anime swordsman|Make It Rain|p2a: Sneasler
|
|upkeep
|win|A`;
	const g = labelLog(log);
	const turn = (t: number, side: string) => g.turns.find(x => x.turn === t && x.side === side)!.slots;
	// The switch into "Mawile" was Zoroark (its Illusion broke on turn 2).
	expect(turn(1, 'p2')[0]).toEqual({ action: 'switch', species: 'Zoroark-Hisui', name: 'Zoroark' });
	// A foe fainted earlier in the turn, so Aura Sphere may have been retargeted: move known, target not.
	expect(turn(2, 'p1')).toEqual([{ action: 'move', move: 'aurasphere' }, { action: 'move', move: 'allyswitch' }]);
	expect(turn(2, 'p2')).toEqual([{ action: 'move', move: 'suckerpunch' }, { action: 'unknown', why: "couldn't move (confusion)" }]);
	expect(turn(3, 'p1')[1]).toEqual({ action: 'unknown', why: 'locked into a move' });
	expect(turn(3, 'p1')[0]).toMatchObject({ action: 'move', move: 'makeitrain' });
});

test('replay positions rebuild with the labelled choices legal', async () => {
	const { benchInput, legalSlotActions, agreement } = await import('../src/data/bench.js');
	const { solveTurn } = await import('../src/engine/solver.js');
	let checked = 0, legal = 0;
	for (let seed = 1; seed <= 6; seed++) {
		const b = randomBattle(seed, true); const rng = makeRng(seed);
		while (!b.ended && b.turn < 30) for (const s of sidesNeedingChoice(b)) { const o = legalChoices(b, s); submit(b, s, o[Math.floor(rng() * o.length)]!); if (b.ended) break; }
		const lines = viewOfLog(b.log);
		const labels = labelLog(lines);
		const t = labels.turns.find(x => x.turn === 2 && x.slots.some(l => l && l.action !== 'unknown'));
		if (!t) continue;
		const setup = benchInput(lines, t.turn, t.side, { samples: 1, keep: 4, seed });
		if ('skip' in setup) continue;
		const ref = solveTurn(setup.input).reference;
		const acts = legalSlotActions(ref, t.side);
		t.slots.forEach((l, i) => {
			if (!l || l.action === 'unknown') return;
			checked++;
			if (acts[i]?.some(a => agreement(a, l).full)) legal++;
		});
	}
	expect(checked).toBeGreaterThan(3);
	expect(legal).toBe(checked);
}, 120_000);

test('training examples encode the labelled choices against their own tokens', async () => {
	const { gameExamples } = await import('../src/nn/examples.js');
	const { Vocab, MON_INTS, SWITCH_BASE } = await import('../src/nn/features.js');
	const vocab = new Vocab();
	let checked = 0;
	for (let seed = 1; seed <= 8; seed++) {
		const b = randomBattle(seed, true); const rng = makeRng(seed);
		while (!b.ended && b.turn < 30) for (const s of sidesNeedingChoice(b)) { const o = legalChoices(b, s); submit(b, s, o[Math.floor(rng() * o.length)]!); if (b.ended) break; }
		const log = viewOfLog(b.log).join('\n');
		const labels = labelLog(log);
		for (const e of gameExamples(`sim-${seed}`, log, vocab)) {
			const t = labels.turns.find(x => x.turn === e.turn && x.side === e.side)!;
			expect(e.labels[6]).toBe(labels.winner === e.side ? 1 : -1);
			for (const slot of [0, 1]) {
				const l = t.slots[slot]; const a = e.labels[slot * 3]!;
				if (a < 0 || !l) continue;
				checked++;
				const token = [...Array(6).keys()].find(i => e.features.ints[i * MON_INTS.length + 8] === 2 + slot)!;
				if (a >= SWITCH_BASE) {
					if (l.action !== 'switch') throw new Error(`switch encoded for ${JSON.stringify(l)}`);
					const sp = vocab.species[e.features.ints[(a - SWITCH_BASE) * MON_INTS.length]!]!;
					expect(sp.startsWith(toID(l.species).slice(0, 4))).toBe(true);
				} else {
					expect(l.action).toBe('move');
					expect(vocab.moves[e.features.ints[token * MON_INTS.length + 3 + a]!]).toBe(l.action === 'move' ? l.move : '');
				}
			}
		}
	}
	expect(checked).toBeGreaterThan(100);
}, 120_000);
