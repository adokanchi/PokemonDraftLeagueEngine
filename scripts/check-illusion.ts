/**
 * Check Illusion inference against simulator truth: random battles where p2 has a Zoroark,
 * analysed from p1's side (with p1's team known). Reports wrong "certain" calls and calibration.
 *
 *   npm run check-illusion -- 200        # battles (default 100)
 */
import { legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng } from '../src/sim/play.js';
import { IllusionTracker } from '../src/belief/illusion.js';
import { UniformPrior } from '../src/data/priors.js';
import { viewOfLog } from '../src/state/parser.js';
import { zoroarkBattle } from '../test/zoroark-helpers.js';

const n = Number(process.argv[2] ?? 100);
const first = Number(process.argv[3] ?? 1);
const prior = new UniformPrior();
let samples = 0, wrongCertain = 0, certainZ = 0, certainReal = 0, disguisedSamples = 0, brier = 0, brierPrior = 0;
const wrong: string[] = [];
const warnings: string[] = [];
const bins = Array.from({ length: 10 }, () => ({ n: 0, z: 0 }));
for (let seed = first; seed < first + n; seed++) {
	const { battle, p1 } = zoroarkBattle(seed);
	const rng = makeRng(seed);
	let fed = 0;
	const tracker = new IllusionTracker({ side: 'p2', ownTeam: p1, prior });
	while (!battle.ended && battle.turn < 60) {
		const pending = sidesNeedingChoice(battle);
		if (pending.length && battle.turn > 0) {
			const view = viewOfLog(battle.log, 'p1');
			for (; fed < view.length; fed++) tracker.feed(view[fed]!);
			const rep = tracker.report();
			for (const s of rep.slots) {
				const truth = battle.sides[1]!.active[s.slot];
				if (!truth || truth.fainted || !s.shown) continue;
				const isZ = truth.baseSpecies.baseSpecies === 'Zoroark';
				const disguised = !!truth.illusion;
				samples++;
				if (disguised) disguisedSamples++;
				const p = s.pZoroark;
				bins[Math.min(9, Math.floor(p * 10))]!.n++;
				if (isZ) bins[Math.min(9, Math.floor(p * 10))]!.z++;
				brier += (p - (isZ ? 1 : 0)) ** 2;
				brierPrior += ((1 / 6) - (isZ ? 1 : 0)) ** 2;
				if (p > 0.999) { certainZ++; if (!isZ) { wrongCertain++; wrong.push(`seed ${seed} turn ${battle.turn} slot ${s.slot}: said Zoroark (${p.toFixed(4)}), was ${truth.species.name} shown as ${s.shown}`); } }
				if (p < 0.001) { certainReal++; if (isZ) { wrongCertain++; wrong.push(`seed ${seed} turn ${battle.turn} slot ${s.slot}: said real ${s.shown} (${p.toFixed(4)}), was Zoroark${disguised ? ' (disguised)' : ''}`); } }
			}
		}
		for (const side of pending) {
			const o = legalChoices(battle, side);
			submit(battle, side, o[Math.floor(rng() * o.length)]!);
			if (battle.ended) break;
		}
	}
	for (const w of tracker.report().warnings) warnings.push(`seed ${seed}: ${w}`);
}
console.log(`${n} battles, ${samples} slot checks (${disguisedSamples} disguised)`);
console.log(`certain calls: ${certainZ} Zoroark, ${certainReal} real; wrong: ${wrongCertain}`);
console.log(`Brier score ${(brier / samples).toFixed(4)} (constant 1/6 prior: ${(brierPrior / samples).toFixed(4)})`);
console.log('calibration (predicted bin: count, actual Zoroark rate):');
bins.forEach((b, i) => b.n && console.log(`  ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}: ${b.n}, ${(b.z / b.n).toFixed(3)}`));
if (wrong.length) console.log('WRONG:\n  ' + wrong.slice(0, 15).join('\n  '));
if (warnings.length) console.log(`warnings (${warnings.length}):\n  ` + warnings.slice(0, 10).join('\n  '));
process.exit(wrongCertain ? 1 : 0);
