import { describe, expect, it } from 'vitest';
import type { PokemonSet } from '../src/showdown.js';
import { createBattle, legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng, playOut, RandomPolicy } from '../src/sim/play.js';
import { BattleLogParser, viewOfLog } from '../src/state/parser.js';
import { DamageCalc } from '../src/belief/damage.js';
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
		expect(bad / checks, examples.join('\n')).toBeLessThan(0.1);
	});
});

describe('damage model', () => {
	it("Showdown's damage formula explains nearly all observed hits with the true sets", () => {
		const calc = new DamageCalc();
		let n = 0, ok = 0;
		for (let seed = 1; seed <= 15; seed++) {
			const b = advance(seed, 30);
			const sets: Record<string, PokemonSet> = {};
			for (const s of b.sides) for (const p of s.pokemon) sets[`${s.id}: ${p.name}`] = p.set as PokemonSet;
			const parser = new BattleLogParser();
			let mv: { ident: string; side: string; move: string; spread: boolean; crit: Set<string>; snap: string } | null = null;
			const active = (pos: string) => {
				const m = /^(p[12])([ab]):/.exec(pos);
				if (!m) return undefined;
				const sd = parser.state.sides[m[1] as 'p1'];
				return sd.pokemon.find(x => x.ident === sd.active['ab'.indexOf(m[2]!)]);
			};
			for (const line of viewOfLog(b.log)) {
				const parts = line.slice(1).split('|');
				if (parts[0] === 'move') { const u = active(parts[1]!); mv = u && !line.includes('[from]') ? { ident: u.ident, side: u.side, move: parts[2]!, spread: line.includes('[spread]'), crit: new Set(), snap: JSON.stringify(parser.state) } : null; }
				if (parts[0] === '-crit' && mv) mv.crit.add(parts[1]!);
				const target = parts[0] === '-damage' && !line.includes('[from]') && mv ? active(parts[1]!) : undefined;
				const before = target?.hp ?? 0;
				parser.feed(line);
				if (!target || !mv || target.ident === mv.ident || target.maxHp !== 100) continue;
				const snap = JSON.parse(mv.snap);
				const A = snap.sides[mv.side].pokemon.find((x: { ident: string }) => x.ident === mv!.ident);
				const D = snap.sides[target.side].pokemon.find((x: { ident: string }) => x.ident === target.ident);
				const sa = sets[mv.ident], sd = sets[target.ident];
				if (!A || !D || !sa || !sd || /Ditto|Zoroark/.test(sa.species + sd.species)) continue;
				const r = calc.range({ set: sa, species: A.species, boosts: A.boosts, hpFraction: A.hp / A.maxHp },
					{ set: sd, species: D.species, boosts: D.boosts, hpFraction: before / 100, sideConditions: Object.keys(snap.sides[target.side].conditions) },
					mv.move, { crit: mv.crit.has(parts[1]!), spread: mv.spread, weather: snap.field.weather, terrain: snap.field.terrain });
				if (r.immune) continue;
				n++;
				const lost = before - target.hp, lo = 100 * r.min / r.maxHp - 1.5, hi = 100 * r.max / r.maxHp + 1.5;
				if (target.hp === 0 ? hi >= lost : lost >= lo && lost <= hi) ok++;
			}
		}
		expect(n).toBeGreaterThan(200);
		expect(ok / n).toBeGreaterThan(0.9);
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
