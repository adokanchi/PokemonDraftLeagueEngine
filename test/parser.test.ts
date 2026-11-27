import { describe, expect, it } from 'vitest';
import { legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng } from '../src/sim/play.js';
import { extractLog, parseBattleLog } from '../src/state/parser.js';
import { applyRuleInferences, knowledgeFromState, mergeKnowledge } from '../src/state/knowledge.js';
import { randomBattle } from './helpers.js';
import { checkAgainstTruth } from './state-check.js';

describe('log parser vs simulator truth', () => {
	it('matches the real battle state at every turn (spectator and both player views)', () => {
		let checks = 0;
		const problems: string[] = [];
		for (let seed = 1; seed <= 40; seed++) {
			const battle = randomBattle(seed, true);
			const rng = makeRng(seed);
			while (!battle.ended && battle.turn < 60) {
				const pending = sidesNeedingChoice(battle);
				if (pending.length === 2 && !battle.sides[0]!.activeRequest?.teamPreview) {
					for (const persp of [undefined, 'p1', 'p2'] as const) {
						checks++;
						for (const m of checkAgainstTruth(battle, persp)) problems.push(`seed ${seed} ${persp ?? 'spectator'} ${m.kind}: ${m.detail}`);
					}
				}
				for (const side of pending) {
					const o = legalChoices(battle, side);
					submit(battle, side, o[Math.floor(rng() * o.length)]!);
					if (battle.ended) break;
				}
			}
		}
		expect(problems.slice(0, 10)).toEqual([]);
		expect(checks).toBeGreaterThan(500);
	});
});

const header = [
	'|player|p1|Alice|', '|player|p2|Bob|', '|gametype|doubles',
	'|clearpoke', '|poke|p1|Garchomp, L50, M|', '|poke|p1|Zoroark-Hisui, L50, M|', '|poke|p1|Incineroar, L50, M|',
	'|poke|p2|Kingambit, L50, M|', '|poke|p2|Farigiraf, L50, F|', '|poke|p2|Sneasler, L50, F|',
	'|teampreview|4', '|teamsize|p1|4', '|teamsize|p2|4', '|start',
];

describe('protocol cases', () => {
	it('records team preview, Mega Evolution and the Champions HP color hint', () => {
		const st = parseBattleLog([
			...header,
			'|switch|p1a: Garchomp|Garchomp, L50, M|100/100',
			'|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
			'|turn|1',
			'|detailschange|p1a: Garchomp|Garchomp-Mega-Z, L50, M',
			'|-mega|p1a: Garchomp|Garchomp|Garchompite Z',
			'|move|p1a: Garchomp|Earthquake|p2a: Kingambit|[spread] p2a',
			'|-damage|p2a: Kingambit|50/100g',
			'|-enditem|p2a: Kingambit|Chople Berry|[eat]',
			'|turn|2',
		].join('\n'));
		expect(st.sides.p1.preview).toEqual(['Garchomp', 'Zoroark-Hisui', 'Incineroar']);
		const chomp = st.sides.p1.pokemon[0]!;
		expect(chomp.species).toBe('Garchomp-Mega-Z');
		expect(chomp.teamSpecies).toBe('Garchomp');
		expect(chomp.item.original).toBe('garchompitez');
		expect(st.sides.p1.megaUsed).toBe(true);
		const gambit = st.sides.p2.pokemon[0]!;
		expect(gambit.hp).toBe(50);
		expect(gambit.hpColor).toBe('g'); // above 50%
		expect(gambit.item).toMatchObject({ original: 'chopleberry', current: '', lostVia: 'consumed' });
	});

	it('handles an Illusion user disguised as an active ally with the same name', () => {
		const st = parseBattleLog([
			...header,
			'|switch|p1a: Garchomp|Garchomp, L50, M|100/100',
			'|switch|p1b: Garchomp|Garchomp, L50, M|100/100', // Zoroark-Hisui pretending
			'|turn|1',
			'|move|p1b: Garchomp|Bitter Malice|p2a: Kingambit',
			'|-damage|p1b: Garchomp|60/100',
			'|replace|p1b: Zoroark|Zoroark-Hisui, L50, M',
			'|-end|p1b: Zoroark|Illusion',
			'|turn|2',
		].join('\n'));
		const p1 = st.sides.p1.pokemon;
		const chomp = p1.find(p => p.ident === 'p1: Garchomp')!;
		const zor = p1.find(p => p.ident === 'p1: Zoroark')!;
		expect(chomp.activeSlot).toBe(0);
		expect(chomp.moves).toEqual({});
		expect(zor.activeSlot).toBe(1);
		expect(zor.moves).toEqual({ bittermalice: { uses: 1 } });
		expect(zor.hp).toBe(60);
		expect(zor.baseAbility).toBe('illusion');
	});

	it('handles Skill Swap reveals, including hidden ally swaps', () => {
		const st = parseBattleLog([
			...header,
			'|switch|p1a: Incineroar|Incineroar, L50, M|100/100',
			'|switch|p1b: Garchomp|Garchomp, L50, M|100/100',
			'|switch|p2a: Farigiraf|Farigiraf, L50, F|100/100',
			'|turn|1',
			'|-activate|p2a: Farigiraf|move: Skill Swap|Intimidate|Armor Tail|[of] p1a: Incineroar',
			'|-activate|p1a: Incineroar|move: Skill Swap|||[of] p1b: Garchomp',
			'|turn|2',
		].join('\n'));
		const [inc, chomp] = st.sides.p1.pokemon;
		const fari = st.sides.p2.pokemon[0]!;
		expect(fari.baseAbility).toBe('armortail');
		expect(fari.ability).toBe('intimidate');
		expect(inc!.baseAbility).toBe('intimidate');
		expect(inc!.abilityChanged).toBe(true);
		expect(chomp!.baseAbility).toBeUndefined();
	});

	it('stops at the requested turn', () => {
		const log = [...header, '|switch|p1a: Garchomp|Garchomp, L50, M|100/100', '|turn|1',
			'|-damage|p1a: Garchomp|40/100', '|turn|2', '|-damage|p1a: Garchomp|10/100', '|turn|3'].join('\n');
		expect(parseBattleLog(log, { stopAtTurn: 2 }).sides.p1.pokemon[0]!.hp).toBe(40);
		expect(parseBattleLog(log).sides.p1.pokemon[0]!.hp).toBe(10);
	});

	it('extracts logs from replay JSON and saved replay HTML', () => {
		const log = '|turn|1\n|turn|2';
		expect(extractLog(JSON.stringify({ log }))).toBe(log);
		expect(extractLog(`<html><script type="text/plain" class="battle-log-data">${log}</script></html>`)).toBe(log);
		expect(extractLog(log)).toBe(log);
	});
});

describe('team knowledge (Bo3 carry-over)', () => {
	it('collects reveals, merges games, and applies item clause', () => {
		const game1 = parseBattleLog([
			...header,
			'|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
			'|turn|1',
			'|move|p2a: Kingambit|Sucker Punch|p1a: Garchomp',
			'|-enditem|p2a: Kingambit|Chople Berry|[eat]',
		].join('\n'));
		const game2 = parseBattleLog([
			...header,
			'|switch|p2a: Farigiraf|Farigiraf, L50, F|100/100',
			'|turn|1',
			'|move|p2a: Farigiraf|Trick Room|p2a: Farigiraf',
			'|-ability|p2a: Farigiraf|Armor Tail',
		].join('\n'));
		const k = applyRuleInferences(mergeKnowledge(knowledgeFromState(game1, 'p2'), knowledgeFromState(game2, 'p2')));
		expect(k.Kingambit).toMatchObject({ moves: ['suckerpunch'], item: 'chopleberry' });
		expect(k.Farigiraf).toMatchObject({ moves: ['trickroom'], ability: 'armortail' });
		expect(k.Farigiraf!.notItems).toContain('chopleberry');
	});
});
