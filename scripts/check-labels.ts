/**
 * Checks the replay choice labeller (src/data/positions.ts) against the simulator: plays random
 * battles, records what each side actually submitted, and compares with what labelLog reads back
 * from the spectator log. Reports coverage (slots labelled) and wrong labels (should be 0).
 *
 *   npm run check-labels            # 150 battles
 *   npm run check-labels -- 500
 */
import { legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng } from '../src/sim/play.js';
import { viewOfLog } from '../src/state/parser.js';
import { labelLog } from '../src/data/positions.js';
import { randomBattle } from '../test/helpers.js';
import { toID } from '../src/showdown.js';
let slots = 0, known = 0, wrong = 0, hidden = 0; const ex: string[] = []; const whys: Record<string, number> = {};
const N = Number(process.argv[2] ?? 150);
for (let seed = 1; seed <= N; seed++) {
	const b = randomBattle(seed, true); const rng = makeRng(seed);
	const truth: Record<string, { action: string; move?: string; target?: number; mega?: boolean; species?: string }[]> = {};
	while (!b.ended && b.turn < 40) for (const s of sidesNeedingChoice(b)) {
		const o = legalChoices(b, s); const c = o[Math.floor(rng() * o.length)]!;
		const side = b.sides[s]!;
		if (!side.activeRequest?.forceSwitch && !side.activeRequest?.teamPreview && b.turn > 0) {
			truth[`${b.turn}${side.id}`] = c.split(', ').map((part, slot) => {
				const m = /^move (\d+)(?: (-?\d))?( mega)?/.exec(part); const sw = /^switch (\d)/.exec(part);
				const mon = side.active[slot];
				if (m) return { action: 'move', move: mon?.moveSlots[Number(m[1]) - 1]?.id, target: m[2] ? Number(m[2]) : undefined, mega: !!m[3] };
				if (sw) return { action: 'switch', species: side.pokemon[Number(sw[1]) - 1]?.species.name };
				return { action: 'pass' };
			});
		}
		submit(b, s, c); if (b.ended) break;
	}
	if (b.sides.some(s => s.pokemon.some(p => p.baseSpecies.baseSpecies === 'Ditto'))) continue;
	const labels = labelLog(viewOfLog(b.log));
	for (const t of labels.turns) {
		const tr = truth[`${t.turn}${t.side}`]; if (!tr) continue;
		t.slots.forEach((l, slot) => {
			const want = tr[slot]; if (!l || !want || want.action === 'pass') return;
			slots++;
			if (l.action === 'unknown') { whys[l.why.split(' (')[0]!] = (whys[l.why.split(' (')[0]!] ?? 0) + 1; return; }
			known++;
			const ok = l.action === 'move' ? want.action === 'move' && toID(want.move ?? '') === l.move && (l.target === undefined || want.target === undefined || l.target === want.target) && !!l.mega === !!want.mega
				: want.action === 'switch' && want.species?.split('-')[0] === l.species.split('-')[0];
			// A Zoroark whose Illusion never broke looks like the Pokémon it copied: no log can show it.
			if (!ok && l.action === 'switch' && /^Zoroark/.test(want.species ?? '')) { hidden++; return; }
			if (!ok) { wrong++; if (ex.length < 12) ex.push(`seed ${seed} t${t.turn} ${t.side}${'ab'[slot]}: label ${JSON.stringify(l)} truth ${JSON.stringify(want)}`); }
		});
	}
}
console.log(`${slots} chosen slots in ${N} battles: ${(100 * known / slots).toFixed(1)}% labelled, ${wrong} wrong, ${hidden} switches into an unrevealed Zoroark`);
console.log('unlabelled:', whys);
if (ex.length) console.log(ex.join('\n'));
process.exit(wrong ? 1 : 0);
