/**
 * How well does the damage model explain real hits when it knows the true sets? Plays random
 * battles, turns each one's log into hit observations (the same pipeline the opponent model
 * uses), and checks every hit against Showdown's damage formula.
 *
 *   npm run check-damage -- 150            # battles (default 60)
 *   npm run check-damage -- 150 --misses   # also list the hits it can't explain
 *   npm run check-damage -- 300 1001       # battles, first seed
 */
import type { PokemonSet } from '../src/showdown.js';
import { legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng } from '../src/sim/play.js';
import { BattleLogParser, viewOfLog } from '../src/state/parser.js';
import { DamageCalc } from '../src/belief/damage.js';
import { fits, HitRecorder, skipReason, type HitObservation } from '../src/belief/hits.js';
import { resolveFormat } from '../src/config.js';
import { randomBattle } from '../test/helpers.js';

const n = Number(process.argv[2] ?? 60);
const first = Number(process.argv.find((a, i) => i > 2 && /^\d+$/.test(a)) ?? 1);
const showMisses = process.argv.includes('--misses');
const format = resolveFormat();
const calc = new DamageCalc(format);
let total = 0, ok = 0, capped = 0, multi = 0, multiOk = 0;
const skipped: Record<string, number> = {};
const missByMove: Record<string, number> = {};
const misses: string[] = [];
const t0 = performance.now();
let calcMs = 0;
for (let seed = first; seed < first + n; seed++) {
	const b = randomBattle(seed, true);
	const rng = makeRng(seed);
	while (!b.ended && b.turn < 40) {
		for (const s of sidesNeedingChoice(b)) { const o = legalChoices(b, s); submit(b, s, o[Math.floor(rng() * o.length)]!); if (b.ended) break; }
	}
	// (Disguised Zoroark make the log name the wrong Pokémon; the Illusion tracker handles those.)
	if (b.sides.some(s => s.pokemon.some(p => p.baseSpecies.baseSpecies === 'Zoroark'))) continue;
	const sets: Record<string, PokemonSet> = {};
	for (const s of b.sides) for (const p of s.pokemon) sets[`${s.id}: ${p.name}`] = p.set as PokemonSet;
	const parser = new BattleLogParser({ perspective: 'p1' });
	const observations: HitObservation[] = [];
	const rec = new HitRecorder(() => parser.state, o => observations.push(o));
	for (const line of viewOfLog(b.log, 'p1')) { rec.before(line); parser.feed(line); }
	rec.flush();
	for (const o of observations) {
		const why = skipReason(o, format);
		if (why) { skipped[why] = (skipped[why] ?? 0) + 1; continue; }
		const t1 = performance.now();
		const r = calc.range(o, m => sets[m.ident]);
		calcMs += performance.now() - t1;
		const isMulti = o.hit > 1 || !!format.dex.moves.get(o.move).multihit;
		total++;
		if (o.atLeast) capped++;
		if (isMulti) multi++;
		if (fits(o, r)) { ok++; if (isMulti) multiOk++; continue; }
		missByMove[o.move] = (missByMove[o.move] ?? 0) + 1;
		const A = o.state.sides[o.attacker.slice(0, 2) as 'p1'].pokemon.find(p => p.ident === o.attacker)!;
		const D = o.state.sides[o.defender.slice(0, 2) as 'p1'].pokemon.find(p => p.ident === o.defender)!;
		const sa = sets[o.attacker]!, sd = sets[o.defender]!;
		const unit = o.exact ? ' HP' : '%';
		const scale = o.exact ? 1 : 100 / r.maxHp;
		misses.push(`seed ${seed} t${o.state.turn}: ${A.species} [${sa.ability}/${sa.item}] ${o.move}${o.hit > 1 ? ` (hit ${o.hit})` : ''}${o.crit ? ' crit' : ''} -> ${D.species} [${sd.ability}/${sd.item}] lost ${o.lost}${unit}${o.atLeast ? ' (at least)' : ''}; model ${r.immune ? 'immune' : `${(r.min * scale).toFixed(1)}-${(r.max * scale).toFixed(1)}${unit}`}`);
	}
}
console.log(`hits checked: ${total} (${multi} from multi-hit moves, ${capped} capped/KO), explained ${ok} (${(100 * ok / total).toFixed(1)}%); multi-hit ${(100 * multiOk / Math.max(1, multi)).toFixed(1)}%`);
console.log(`skipped:`, skipped);
console.log(`calc: ${(calcMs / Math.max(1, total)).toFixed(3)} ms per hit; total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log('misses by move:', Object.entries(missByMove).sort((a, b) => b[1] - a[1]).slice(0, 15));
if (showMisses) console.log(misses.join('\n'));
