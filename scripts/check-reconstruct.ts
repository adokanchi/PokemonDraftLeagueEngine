/**
 * Check battle reconstruction against simulator truth: rebuild each decision point of random
 * battles from p1's knowledge plus the true opponent sets, and list every difference.
 *
 *   npm run check-reconstruct -- 100      # battles (default 60)
 *   npm run check-reconstruct -- 100 --zoroark   # we have a Zoroark (--both: in odd seeds they do too)
 */
import { legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng } from '../src/sim/play.js';
import { createBattle } from '../src/sim/battle.js';
import { randomBattle, randomTeam } from '../test/helpers.js';
import { teamWithZoroark } from '../test/zoroark-helpers.js';
import { compareReconstruction } from '../test/reconstruct-check.js';

const n = Number(process.argv[2] ?? 60);
const verbose = process.argv.includes('--verbose');
const zoroark = process.argv.includes('--zoroark');
let checks = 0, bad = 0;
const kinds: Record<string, number> = {};
const examples: Record<string, string[]> = {};
for (let seed = 1; seed <= n; seed++) {
	const b = zoroark
		? createBattle({ p1: { name: 'Alice', team: teamWithZoroark(seed * 2 + 1) }, p2: { name: 'Bob', team: process.argv.includes('--both') && seed % 2 ? teamWithZoroark(seed * 2 + 2) : randomTeam(seed * 2 + 2) }, seed, keepLog: true })
		: randomBattle(seed, true);
	const rng = makeRng(seed);
	let ownOrder: string[] | undefined;
	while (!b.ended && b.turn < 40) {
		// (Right after team preview, the party is in the order it was brought.)
		if (zoroark && !ownOrder && b.turn >= 1) ownOrder = b.sides[0]!.pokemon.slice(0, 4).map(p => p.set.species);
		const pend = sidesNeedingChoice(b);
		if (pend.length === 2 && b.turn > 0 && !b.sides[0]!.activeRequest?.forceSwitch && !b.sides[1]!.activeRequest?.forceSwitch) {
			checks++;
			let problems: string[];
			try { problems = compareReconstruction(b, { ownOrder }); } catch (e) { problems = [`turn ${b.turn}: crash ${(e as Error).message.split('\n')[0]}`]; }
			if (problems.length) {
				bad++;
				const seen = new Set<string>();
				for (const p of problems) {
					const kind = /: (missing active|species|hp|status|boost|item|ability|types|activeTurns|timesAttacked|lastTurnFailed|volatiles|fainted|side|weather|terrain|rooms|crash)|choices/.exec(p)?.[1] ?? (p.includes('choices') ? 'choices' : 'other');
					if (seen.has(kind)) continue;
					seen.add(kind);
					kinds[kind] = (kinds[kind] ?? 0) + 1;
					(examples[kind] ??= []).push(`seed ${seed} ${p}`);
				}
			}
		}
		for (const s of pend) { const o = legalChoices(b, s); submit(b, s, o[Math.floor(rng() * o.length)]!); if (b.ended) break; }
	}
}
console.log(`${checks} decision points, ${bad} with any difference (${(100 * bad / checks).toFixed(1)}%)`);
for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
	console.log(`\n${k}: ${v} (${(100 * v / checks).toFixed(1)}%)`);
	for (const e of examples[k]!.slice(0, verbose ? 1000 : 6)) console.log('   ', e);
}
