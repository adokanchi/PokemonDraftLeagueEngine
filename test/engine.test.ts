import { describe, expect, it } from 'vitest';
import type { PokemonSet } from '../src/showdown.js';
import { createBattle, legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng, playOut, RandomPolicy } from '../src/sim/play.js';
import { BattleLogParser, parseBattleLog, viewOfLog } from '../src/state/parser.js';
import { DamageCalc } from '../src/belief/damage.js';
import { fits, HitRecorder, skipReason, type HitObservation } from '../src/belief/hits.js';
import { resolveFormat } from '../src/config.js';
import { OpponentModel } from '../src/belief/sets.js';
import { UniformPrior } from '../src/data/priors.js';
import { solveTurn } from '../src/engine/solver.js';
import { SolverBot, translateChoice } from '../src/engine/bots.js';
import { randomBattle, randomTeam } from './helpers.js';
import { compareReconstruction } from './reconstruct-check.js';

const prior = new UniformPrior();

function advance(seed: number, turns: number) {
	const b = randomBattle(seed, true);
	const rng = makeRng(seed);
	while (!b.ended && b.turn < turns) {
		for (const s of sidesNeedingChoice(b)) {
			const o = legalChoices(b, s);
			submit(b, s, o[Math.floor(rng() * o.length)]!);
			if (b.ended) break;
		}
	}
	return b;
}

describe('rebuilding battles from what a player knows', () => {
	it('matches the real battle (actives, HP, status, boosts, field, legal moves) at most decision points', () => {
		let checks = 0, bad = 0;
		const examples: string[] = [];
		for (let seed = 1; seed <= 25; seed++) {
			const b = randomBattle(seed, true);
			const rng = makeRng(seed);
			while (!b.ended && b.turn < 30) {
				const pend = sidesNeedingChoice(b);
				if (pend.length === 2 && b.turn > 0 && !b.sides[0]!.activeRequest?.forceSwitch && !b.sides[1]!.activeRequest?.forceSwitch) {
					checks++;
					const problems = compareReconstruction(b);
					if (problems.length) { bad++; if (examples.length < 5) examples.push(`seed ${seed}: ${problems[0]}`); }
				}
				for (const s of pend) { const o = legalChoices(b, s); submit(b, s, o[Math.floor(rng() * o.length)]!); if (b.ended) break; }
			}
		}
		expect(checks).toBeGreaterThan(150);
		expect(bad / checks, examples.join("\n")).toBeLessThan(0.02);
	});
});

describe('damage model', () => {
	it("Showdown's damage formula, run on the whole field, explains every observed hit with the true sets", () => {
		const format = resolveFormat();
		const calc = new DamageCalc(format);
		let n = 0, ok = 0, wrongOk = 0, multi = 0;
		for (let seed = 1; seed <= 15; seed++) {
			const b = advance(seed, 30);
			if (b.sides.some(s => s.pokemon.some(p => p.baseSpecies.baseSpecies === 'Zoroark'))) continue;
			const sets: Record<string, PokemonSet> = {};
			for (const s of b.sides) for (const p of s.pokemon) sets[`${s.id}: ${p.name}`] = p.set as PokemonSet;
			const parser = new BattleLogParser({ perspective: 'p1' });
			const hits: HitObservation[] = [];
			const rec = new HitRecorder(() => parser.state, o => hits.push(o));
			for (const line of viewOfLog(b.log, 'p1')) { rec.before(line); parser.feed(line); }
			rec.flush();
			for (const o of hits) {
				if (skipReason(o, format)) continue;
				n++;
				if (o.hit > 1) multi++;
				if (fits(o, calc.range(o, m => sets[m.ident]))) ok++;
				// The same hit with a different defensive spread mostly doesn't fit: the evidence is informative.
				if (!o.atLeast) {
					const wrong = (m: { ident: string }) => m.ident === o.defender ? { ...sets[m.ident]!, nature: 'Hasty', evs: { hp: 0, atk: 32, def: 0, spa: 32, spd: 0, spe: 2 } } : sets[m.ident];
					if (fits(o, calc.range(o, wrong as never))) wrongOk++;
				}
			}
		}
		expect(n).toBeGreaterThan(200);
		expect(multi).toBeGreaterThan(5);
		expect(ok / n).toBeGreaterThan(0.99);
		expect(wrongOk / n).toBeLessThan(0.5);
	});

	it('handles resist berries, Focus Sash and multi-hit moves', () => {
		const calc = new DamageCalc();
		const mk = (species: string, item: string, ability: string, moves: string[], evs: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>> = {}) => ({
			name: species, species, item, ability, moves, nature: 'Adamant', gender: '', level: 50,
			evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...evs }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
		}) as PokemonSet;
		const state = parseBattleLog(['|player|p1|A|', '|player|p2|B|', '|gametype|doubles', '|start',
			'|switch|p1a: Garchomp|Garchomp, L50|100/100', '|switch|p2a: Kingambit|Kingambit, L50|100/100', '|turn|1'].join('\n'));
		const spec = { state, attacker: 'p1: Garchomp', defender: 'p2: Kingambit', move: 'Earthquake', crit: false, spread: false, hit: 1 };
		const chomp = mk('Garchomp', '', 'Rough Skin', ['Earthquake', 'Scale Shot'], { atk: 32 });
		const plain = calc.range(spec, m => (m.side === 'p1' ? chomp : mk('Kingambit', '', 'Defiant', ['Kowtow Cleave'])));
		const berry = calc.range({ ...spec, itemsBefore: { 'p2: Kingambit': 'Shuca Berry' } }, m => (m.side === 'p1' ? chomp : mk('Kingambit', '', 'Defiant', ['Kowtow Cleave'])));
		// The berry halves both ends of the range (it used to be eaten during the min roll only).
		expect(berry.max).toBeLessThanOrEqual(Math.ceil(plain.max / 2) + 1);
		expect(berry.min).toBeLessThanOrEqual(Math.ceil(plain.min / 2) + 1);
		// Triple Axel's later hits hit harder.
		const axel = mk('Weavile', '', 'Pressure', ['Triple Axel'], { atk: 32 });
		const s2 = parseBattleLog(['|player|p1|A|', '|player|p2|B|', '|gametype|doubles', '|start',
			'|switch|p1a: Weavile|Weavile, L50|100/100', '|switch|p2a: Kingambit|Kingambit, L50|100/100', '|turn|1'].join('\n'));
		const h1 = calc.range({ state: s2, attacker: 'p1: Weavile', defender: 'p2: Kingambit', move: 'Triple Axel', crit: false, spread: false, hit: 1 }, m => (m.side === 'p1' ? axel : mk('Kingambit', '', 'Defiant', ['Kowtow Cleave'])));
		const h3 = calc.range({ state: s2, attacker: 'p1: Weavile', defender: 'p2: Kingambit', move: 'Triple Axel', crit: false, spread: false, hit: 3 }, m => (m.side === 'p1' ? axel : mk('Kingambit', '', 'Defiant', ['Kowtow Cleave'])));
		expect(h3.min).toBeGreaterThan(h1.max * 2);
	});
});

describe('opponent model', () => {
	it('candidate sets keep every revealed fact, and sampled teams obey item clause', () => {
		for (const seed of [3, 7, 11]) {
			const b = advance(seed, 8);
			const model = new OpponentModel({ side: 'p2', ownTeam: randomTeam(seed * 2 + 1), prior, poolSize: 16 });
			model.feedLog(viewOfLog(b.log, 'p1').join('\n'));
			for (const [species, f] of Object.entries(model.factsSummary())) {
				for (const { set } of model.posterior(species)) {
					for (const m of f.moves) expect(set.moves).toContain(m);
					if (f.ability) expect(set.ability).toBe(f.ability);
					if (f.item) expect(set.item).toBe(f.item);
				}
			}
			// (Random-battle teams ignore item clause, so an item revealed on two of them is allowed.)
			const factItems = Object.values(model.factsSummary()).map(f => f.item).filter(Boolean);
			for (let i = 0; i < 10; i++) {
				const { sets } = model.sampleTeam();
				const items = sets.map(s => s.item).filter(it => it && !factItems.includes(it));
				expect(new Set(items).size).toBe(items.length);
				expect(sets.length).toBeLessThanOrEqual(4);
			}
		}
	});
});

describe('one-turn solver', () => {
	it('returns a mixed strategy over legal options', () => {
		const b = advance(7, 3);
		const model = new OpponentModel({ side: 'p2', ownTeam: randomTeam(15), prior, poolSize: 16 });
		model.feedLog(viewOfLog(b.log, 'p1').join('\n'));
		const res = solveTurn({ state: model.state, me: 'p1', myTeam: b.sides[0]!.pokemon.map(p => p.set as PokemonSet), model, options: { samples: 2, keep: 5, perSlot: 3, replies: 2, iterations: 500 } });
		const total = res.options.reduce((s, o) => s + o.p, 0);
		expect(total).toBeCloseTo(1, 5);
		const legal = new Set(legalChoices(b, 0));
		for (const o of res.options) expect(legal.has(translateChoice(res.reference, b, 0, o.choice))).toBe(true);
		expect(res.value).toBeGreaterThanOrEqual(-1);
		expect(res.value).toBeLessThanOrEqual(1);
	});

	it('beats a random player', () => {
		let wins = 0;
		for (let g = 0; g < 4; g++) {
			const bot = new SolverBot({ solve: { samples: 1, keep: 4, perSlot: 2, replies: 2, iterations: 300 }, prior, seed: g + 1 });
			const side = g % 2;
			const battle = createBattle({ p1: { name: 'A', team: randomTeam(500 + g) }, p2: { name: 'B', team: randomTeam(600 + g) }, seed: g + 1, keepLog: true });
			const res = playOut(battle, side === 0 ? [bot, new RandomPolicy(makeRng(g))] : [new RandomPolicy(makeRng(g)), bot], 80);
			if (res.winner === (side === 0 ? 'A' : 'B')) wins++;
		}
		expect(wins).toBeGreaterThanOrEqual(3);
	});
});
