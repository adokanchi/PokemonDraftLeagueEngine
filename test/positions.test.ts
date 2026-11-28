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
	expect(turn(2, 'p1')).toEqual([{ action: 'move', move: 'aurasphere', target: 2 }, { action: 'move', move: 'allyswitch' }]);
	expect(turn(2, 'p2')).toEqual([{ action: 'move', move: 'suckerpunch' }, { action: 'unknown', why: "couldn't move (confusion)" }]);
	expect(turn(3, 'p1')[1]).toEqual({ action: 'unknown', why: 'locked into a move' });
	expect(turn(3, 'p1')[0]).toMatchObject({ action: 'move', move: 'makeitrain' });
});
