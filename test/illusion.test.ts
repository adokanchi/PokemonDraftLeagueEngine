import { describe, expect, it } from 'vitest';
import type { PokemonSet } from '../src/showdown.js';
import { IllusionTracker } from '../src/belief/illusion.js';
import { UniformPrior, UsagePrior, type SetPrior } from '../src/data/priors.js';
import { legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng } from '../src/sim/play.js';
import { viewOfLog } from '../src/state/parser.js';
import { zoroarkBattle } from './zoroark-helpers.js';

const prior = new UniformPrior();

const set = (species: string, ability: string, item: string, moves: string[], nature: string, spe: number): PokemonSet => ({
	name: species, species, item, ability, moves, nature, gender: '', level: 50,
	evs: { hp: 32, atk: 0, def: 0, spa: 0, spd: 0, spe }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
} as PokemonSet);

const ownTeam = [
	set('Sneasler', 'Poison Touch', 'Focus Sash', ['Close Combat', 'Fake Out', 'Dire Claw', 'Protect'], 'Jolly', 32),
	set('Incineroar', 'Blaze', 'Sitrus Berry', ['Fake Out', 'Will-O-Wisp', 'Toxic', 'Thunder Wave'], 'Careful', 0),
	set('Garchomp', 'Rough Skin', 'Life Orb', ['Earthquake', 'Rock Slide', 'Dragon Claw', 'Protect'], 'Jolly', 32),
	set('Farigiraf', 'Armor Tail', 'Mental Herb', ['Trick Room', 'Psychic', 'Hyper Voice', 'Protect'], 'Quiet', 0),
];

const PREVIEW = ['Whimsicott', 'Zoroark-Hisui', 'Torkoal', 'Tyranitar', 'Farigiraf', 'Kingambit'];

function start(p2Leads: [string, string], extra: string[] = []): string[] {
	return [
		'|player|p1|Me|', '|player|p2|Them|', '|gametype|doubles', '|clearpoke',
		...ownTeam.map(s => `|poke|p1|${s.species}, L50|`),
		...PREVIEW.map(s => `|poke|p2|${s}, L50|`),
		'|teampreview|4', '|teamsize|p1|4', '|teamsize|p2|4', '|start',
		'|switch|p1a: Sneasler|Sneasler, L50|100/100',
		'|switch|p1b: Incineroar|Incineroar, L50|100/100',
		`|switch|p2a: ${p2Leads[0]}|${p2Leads[0]}, L50|100/100`,
		`|switch|p2b: ${p2Leads[1]}|${p2Leads[1]}, L50|100/100`,
		...extra,
	];
}

function track(lines: string[], p: SetPrior = prior) {
	const t = new IllusionTracker({ side: 'p2', ownTeam, prior: p });
	t.feedLog(lines.join('\n'));
	return t;
}

const pz = (t: IllusionTracker, slot: number) => t.report().slots[slot]!.pZoroark;

/** A move both species can learn, so the move itself isn't evidence. */
function sharedMove(a: string, b: string): string {
	const options = ['Protect', 'Facade', 'Snarl', 'Hyper Voice', 'Taunt', 'Will-O-Wisp', 'Foul Play', 'Body Slam', 'Endure', 'Substitute'];
	return options.find(m => prior.canLearn(a, m) && prior.canLearn(b, m) && m !== 'Protect' && m !== 'Endure')!;
}

describe('Illusion inference', () => {
	it('starts from the structural prior: each lead could be Zoroark disguised as a back Pokémon', () => {
		const t = track(start(['Whimsicott', 'Kingambit'], ['|turn|1']));
		const r = t.report();
		expect(r.zoroark).toBe('Zoroark-Hisui');
		expect(pz(t, 0)).toBeGreaterThan(0.1);
		expect(pz(t, 0)).toBeLessThan(0.35);
	});

	it('a move the shown species cannot learn but Zoroark can (Whimsicott using Bitter Malice) proves Zoroark', () => {
		const t = track(start(['Whimsicott', 'Kingambit'], ['|turn|1', '|move|p2a: Whimsicott|Bitter Malice|p1a: Sneasler']));
		expect(pz(t, 0)).toBeGreaterThan(0.999);
		expect(pz(t, 1)).toBeLessThan(0.001); // only one Zoroark
	});

	it('a move Zoroark cannot learn proves it is real', () => {
		const t = track(start(['Torkoal', 'Kingambit'], ['|turn|1', '|move|p2a: Torkoal|Heat Wave|p1a: Sneasler|[spread] p1a,p1b']));
		expect(pz(t, 0)).toBeLessThan(0.001);
	});

	it('a Tyranitar with no switch-in message must be Zoroark (Sand Stream and Unnerve both announce)', () => {
		const silent = track(start(['Tyranitar', 'Kingambit'], ['|turn|1']));
		expect(pz(silent, 0)).toBeGreaterThan(0.999);
		const sand = track(start(['Tyranitar', 'Kingambit'], ['|-weather|Sandstorm|[from] ability: Sand Stream|[of] p2a: Tyranitar', '|turn|1']));
		expect(pz(sand, 0)).toBeLessThan(0.001);
	});

	it('a revealed ability (Armor Tail blocking priority) proves it is real', () => {
		const t = track(start(['Farigiraf', 'Kingambit'], [
			'|turn|1',
			'|move|p1b: Incineroar|Fake Out|p2a: Farigiraf',
			'|cant|p2a: Farigiraf|ability: Armor Tail|Fake Out|[of] p1b: Incineroar',
		]));
		expect(pz(t, 0)).toBeLessThan(0.001);
	});

	it('Torkoal moving before a max-speed Sneasler (no Trick Room) must be Zoroark', () => {
		const move = sharedMove('Torkoal', 'Zoroark-Hisui');
		const t = track(start(['Torkoal', 'Kingambit'], [
			'|turn|1',
			`|move|p2a: Torkoal|${move}|p1a: Sneasler`,
			'|move|p1a: Sneasler|Close Combat|p2b: Kingambit',
			'|-damage|p2b: Kingambit|30/100',
		]));
		expect(pz(t, 0)).toBeGreaterThan(0.999);
	});

	it('Whimsicott Taunting after a +0 move makes Zoroark more likely (Prankster would have gone first)', () => {
		const usage = new UsagePrior({
			data: {
				'Whimsicott': { 'Raw count': 100, Abilities: { prankster: 95, infiltrator: 4, chlorophyll: 1 }, Moves: { taunt: 60 } },
				'Zoroark-Hisui': { 'Raw count': 100, Abilities: { illusion: 100 }, Moves: { taunt: 30 } },
			},
		}, prior, 0.03);
		const taunt = '|move|p2a: Whimsicott|Taunt|p1b: Incineroar';
		const cc = ['|move|p1a: Sneasler|Close Combat|p2b: Kingambit', '|-damage|p2b: Kingambit|30/100'];
		const first = track(start(['Whimsicott', 'Kingambit'], ['|turn|1', taunt, ...cc]), usage); // as Prankster would
		const after = track(start(['Whimsicott', 'Kingambit'], ['|turn|1', ...cc, taunt]), usage);
		expect(pz(after, 0)).toBeGreaterThan(pz(first, 0) + 0.3);
		expect(pz(after, 0)).toBeGreaterThan(0.6);
		expect(pz(after, 0)).toBeLessThan(0.999); // a non-Prankster Whimsicott is still possible
	});

	it('taking an attack without the disguise breaking proves it is real', () => {
		const t = track(start(['Whimsicott', 'Kingambit'], [
			'|turn|1',
			'|move|p1a: Sneasler|Close Combat|p2a: Whimsicott',
			'|-damage|p2a: Whimsicott|20/100',
			'|turn|2',
		]));
		expect(pz(t, 0)).toBeLessThan(0.001);
	});

	it('the disguise breaking proves Zoroark', () => {
		const t = track(start(['Whimsicott', 'Kingambit'], [
			'|turn|1',
			'|move|p1a: Sneasler|Close Combat|p2a: Whimsicott',
			'|-damage|p2a: Whimsicott|20/100',
			'|replace|p2a: Zoroark|Zoroark-Hisui, L50',
			'|-end|p2a: Zoroark|Illusion',
		]));
		expect(pz(t, 0)).toBe(1);
	});

	it('coming back with more HP than it left with (no Regenerator possible) means Zoroark', () => {
		const t = track(start(['Whimsicott', 'Kingambit'], [
			'|turn|1',
			'|move|p1a: Sneasler|Close Combat|p2a: Whimsicott',
			'|-damage|p2a: Whimsicott|40/100',
			'|turn|2',
			'|switch|p2a: Tyranitar|Tyranitar, L50|100/100',
			'|-weather|Sandstorm|[from] ability: Sand Stream|[of] p2a: Tyranitar',
			'|turn|3',
			'|switch|p2a: Whimsicott|Whimsicott, L50|100/100',
			'|turn|4',
		]));
		expect(pz(t, 0)).toBeGreaterThan(0.999);
	});

	it('the same Pokémon entering while it already seems to be out: the one already out is Zoroark', () => {
		const lines = start(['Torkoal', 'Kingambit'], ['|turn|1']);
		const t = track(lines);
		expect(pz(t, 0)).toBeLessThan(0.5);
		// The real Torkoal comes in next to "Torkoal": the one in slot a was Zoroark all along.
		const t2 = track([...lines, '|switch|p2b: Torkoal|Torkoal, L50|100/100', '|turn|2']);
		expect(pz(t2, 0)).toBeGreaterThan(0.999);
		expect(pz(t2, 1)).toBeLessThan(0.001);
	});

	it('type immunities to our moves: Toxic failing on "Kingambit" (Steel) means real; Will-O-Wisp burning "Torkoal" (Fire) means Zoroark', () => {
		const immune = track(start(['Whimsicott', 'Kingambit'], ['|turn|1', '|move|p1b: Incineroar|Toxic|p2b: Kingambit', '|-immune|p2b: Kingambit']));
		expect(pz(immune, 1)).toBeLessThan(0.001);
		const burned = track(start(['Torkoal', 'Kingambit'], ['|turn|1', '|move|p1b: Incineroar|Will-O-Wisp|p2a: Torkoal', '|-status|p2a: Torkoal|brn']));
		expect(pz(burned, 0)).toBeGreaterThan(0.999);
	});

	it('is inert when Zoroark is not in the team preview', () => {
		const lines = start(['Whimsicott', 'Kingambit']).map(l => l.replace('Zoroark-Hisui', 'Garchomp'));
		const t = track([...lines, '|turn|1']);
		expect(t.report().pBrought).toBe(0);
		expect(pz(t, 0)).toBe(0);
	});
});

describe('Illusion inference vs simulator truth', () => {
	it('never makes a wrong certain call, and is far better calibrated than the prior', () => {
		let samples = 0, wrong = 0, brier = 0, brierPrior = 0;
		const problems: string[] = [];
		for (let seed = 1; seed <= 40; seed++) {
			const { battle, p1 } = zoroarkBattle(seed);
			const rng = makeRng(seed);
			const tracker = new IllusionTracker({ side: 'p2', ownTeam: p1, prior });
			let fed = 0;
			while (!battle.ended && battle.turn < 40) {
				const pending = sidesNeedingChoice(battle);
				if (pending.length && battle.turn > 0) {
					const view = viewOfLog(battle.log, 'p1');
					for (; fed < view.length; fed++) tracker.feed(view[fed]!);
					for (const s of tracker.report().slots) {
						const truth = battle.sides[1]!.active[s.slot];
						if (!truth || truth.fainted || !s.shown) continue;
						const isZ = truth.baseSpecies.baseSpecies === 'Zoroark';
						samples++;
						brier += (s.pZoroark - (isZ ? 1 : 0)) ** 2;
						brierPrior += (1 / 6 - (isZ ? 1 : 0)) ** 2;
						if ((s.pZoroark > 0.999 && !isZ) || (s.pZoroark < 0.001 && isZ)) {
							wrong++;
							problems.push(`seed ${seed} turn ${battle.turn} slot ${s.slot}: p=${s.pZoroark}, truth ${truth.species.name}`);
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
		expect(problems).toEqual([]);
		expect(wrong).toBe(0);
		expect(samples).toBeGreaterThan(500);
		expect(brier / samples).toBeLessThan(0.5 * (brierPrior / samples));
	});
});
