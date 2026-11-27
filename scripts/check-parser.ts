/**
 * Deep check of the log parser against the simulator's true state over many random battles
 * (the test suite runs a smaller version of this).
 *
 *   npm run check-parser -- 1000        # battles (default 200)
 *   npm run check-parser -- 1000 5001   # battles, first seed
 */
import { legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng } from '../src/sim/play.js';
import { randomBattle } from '../test/helpers.js';
import { checkAgainstTruth } from '../test/state-check.js';

const n = Number(process.argv[2] ?? 200);
const first = Number(process.argv[3] ?? 1);
const counts: Record<string, number> = {};
const examples: Record<string, string[]> = {};
let checks = 0;
for (let seed = first; seed < first + n; seed++) {
	const battle = randomBattle(seed, true);
	const rng = makeRng(seed);
	while (!battle.ended && battle.turn < 80) {
		const pending = sidesNeedingChoice(battle);
		if (pending.length === 2 && !battle.sides[0]!.activeRequest?.teamPreview) {
			for (const persp of [undefined, 'p1', 'p2'] as const) {
				checks++;
				for (const m of checkAgainstTruth(battle, persp)) {
					counts[m.kind] = (counts[m.kind] ?? 0) + 1;
					const ex = (examples[m.kind] ??= []);
					if (ex.length < 4) ex.push(`seed ${seed} ${persp ?? 'spectator'} ${m.detail}`);
				}
			}
		}
		for (const side of pending) {
			const o = legalChoices(battle, side);
			submit(battle, side, o[Math.floor(rng() * o.length)]!);
			if (battle.ended) break;
		}
	}
}
console.log(`${n} battles, ${checks} state checks, mismatches:`, Object.keys(counts).length ? counts : 'none');
for (const [k, v] of Object.entries(examples)) console.log(`${k}\n  ${v.join('\n  ')}`);
process.exit(Object.keys(counts).length ? 1 : 0);
