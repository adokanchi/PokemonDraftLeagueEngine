/**
 * Does the opponent model learn their sets? Plays battles against opponents whose sets look like
 * real teams (spreads from the model's own templates), feeds the model the log up to turn
 * `--split`, then checks how often each later hit lands inside the damage range the model
 * predicts — with and without the damage evidence from the earlier turns.
 *
 *   npm run check-sets -- 60               # battles (default 40)
 *   npm run check-sets -- 60 --split 5     # learn from turns before 5 (default)
 */
import type { PokemonSet } from '../src/showdown.js';
import { createBattle, legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng } from '../src/sim/play.js';
import { BattleLogParser, viewOfLog } from '../src/state/parser.js';
import { OpponentModel } from '../src/belief/sets.js';
import { UniformPrior } from '../src/data/priors.js';
import { fits, HitRecorder, skipReason, type HitObservation } from '../src/belief/hits.js';
import { DamageCalc } from '../src/belief/damage.js';
import { resolveFormat } from '../src/config.js';
import { randomTeam } from '../test/helpers.js';

const args = process.argv.slice(2);
const flag = args.indexOf('--split');
const split = flag >= 0 ? Number(args[flag + 1]) : 5;
const n = Number(args.find((a, i) => /^\d+$/.test(a) && i !== flag + 1) ?? 40);
const format = resolveFormat();
const calc = new DamageCalc(format);
const prior = new UniformPrior(format);
const score = { prior: { p: 0, n: 0 }, evidence: { p: 0, n: 0 } };
// The model's internals, for scoring (not part of its public API).
type Internals = { onHit: unknown; teamForme(s: string): string; bestGuess(s: string): PokemonSet | undefined; makeCandidate(s: string): PokemonSet | undefined };

for (let seed = 1; seed <= n; seed++) {
	const ours = randomTeam(seed * 2 + 1);
	const gen = new OpponentModel({ side: 'p2', ownTeam: [], prior, poolSize: 1, seed: seed * 7 + 3 }) as unknown as Internals;
	const theirs = randomTeam(seed * 2 + 2).map(p => gen.makeCandidate(p.species)).filter((s): s is PokemonSet => !!s);
	if (theirs.some(s => /^Zoroark/.test(s.species)) || ours.some(s => /^Zoroark/.test(s.species))) continue;
	const b = createBattle({ p1: { name: 'Alice', team: ours }, p2: { name: 'Bob', team: theirs }, seed, keepLog: true });
	const rng = makeRng(seed);
	while (!b.ended && b.turn < 25) {
		for (const s of sidesNeedingChoice(b)) { const o = legalChoices(b, s); submit(b, s, o[Math.floor(rng() * o.length)]!); if (b.ended) break; }
	}
	const view = viewOfLog(b.log, 'p1');
	const cut = view.indexOf(`|turn|${split}`);
	if (cut < 0) continue;
	const models = {} as Record<keyof typeof score, OpponentModel>;
	for (const mode of ['prior', 'evidence'] as const) {
		const m = new OpponentModel({ side: 'p2', ownTeam: ours, prior, poolSize: 48, seed });
		if (mode === 'prior') (m as unknown as Internals).onHit = () => {};
		m.feedLog(view.slice(0, cut + 1).join('\n'));
		models[mode] = m;
	}
	const parser = new BattleLogParser({ perspective: 'p1' });
	const later: HitObservation[] = [];
	const rec = new HitRecorder(() => parser.state, o => { if (o.state.turn >= split) later.push(o); });
	for (const line of view) { rec.before(line); parser.feed(line); }
	rec.flush();
	const ourSet = (ident: string) => b.sides[0]!.pokemon.find(q => `p1: ${q.name}` === ident)?.set as PokemonSet | undefined;
	for (const o of later) {
		if (skipReason(o, format) || o.attacker.slice(0, 2) === o.defender.slice(0, 2)) continue;
		const ident = o.attacker.startsWith('p2') ? o.attacker : o.defender;
		const mon = o.state.sides.p2.pokemon.find(p => p.ident === ident);
		if (!mon) continue;
		for (const mode of ['prior', 'evidence'] as const) {
			const model = models[mode];
			const m = model as unknown as Internals;
			const post = model.posterior(m.teamForme(mon.teamSpecies)).slice(0, 12);
			const total = post.reduce((s, x) => s + x.p, 0);
			if (!total) continue;
			let p = 0;
			for (const { set, p: w } of post) {
				const setOf = (x: { ident: string; side: string; teamSpecies: string }) =>
					x.side === 'p1' ? ourSet(x.ident) : x.ident === ident ? set : m.bestGuess(m.teamForme(x.teamSpecies));
				try { if (fits(o, calc.range(o, setOf as never))) p += w; } catch { p += w; }
			}
			score[mode].p += p / total;
			score[mode].n++;
		}
	}
}
for (const [k, v] of Object.entries(score)) {
	console.log(`${k === 'prior' ? 'without damage evidence' : 'with damage evidence   '}: later hits inside the predicted range ${(100 * v.p / Math.max(1, v.n)).toFixed(1)}% (${v.n} hits)`);
}
