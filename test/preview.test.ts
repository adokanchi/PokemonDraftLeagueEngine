import { describe, expect, it } from 'vitest';
import { Teams, type PokemonSet } from '../src/showdown.js';
import { PreviewSolver } from '../src/engine/preview.js';
import { OpponentModel } from '../src/belief/sets.js';
import { UniformPrior } from '../src/data/priors.js';

const sets = (text: string) => Teams.import(text)! as PokemonSet[];
const mine = sets(`Garchomp @ Life Orb
Ability: Rough Skin
EVs: 2 HP / 32 Atk / 32 Spe
Jolly Nature
- Earthquake
- Dragon Claw
- Rock Slide
- Protect

Chandelure @ Charcoal
Ability: Flash Fire
EVs: 2 HP / 32 SpA / 32 Spe
Timid Nature
- Heat Wave
- Shadow Ball
- Energy Ball
- Protect

Hatterene @ Leftovers
Ability: Magic Bounce
EVs: 32 HP / 32 SpA / 2 SpD
Quiet Nature
- Dazzling Gleam
- Psychic
- Mystical Fire
- Protect

Kingambit @ Black Glasses
Ability: Defiant
EVs: 32 HP / 32 Atk / 2 Def
Adamant Nature
- Kowtow Cleave
- Iron Head
- Sucker Punch
- Protect

Scizor @ Choice Band
Ability: Technician
EVs: 32 HP / 32 Atk / 2 Def
Adamant Nature
- Bullet Punch
- U-turn
- Close Combat
- Knock Off

Primarina @ Sitrus Berry
Ability: Torrent
EVs: 32 HP / 32 SpA / 2 SpD
Modest Nature
- Moonblast
- Hydro Pump
- Ice Beam
- Protect`);

describe('team preview', () => {
	it('rates one-on-ones sensibly and picks a legal four', () => {
		const theirSpecies = ['Gholdengo', 'Heatran', 'Dragonite', 'Tyranitar', 'Gengar', 'Rillaboom'];
		const model = new OpponentModel({ side: 'p2', ownTeam: mine, prior: new UniformPrior(), seed: 2 });
		const theirs = theirSpecies.map(species => ({ species, sets: model.posterior(species).slice(0, 3) }));
		const res = new PreviewSolver().solve({ mine, theirs, iterations: 800 });
		const m = (a: string, b: string) => res.matchup[mine.findIndex(s => s.species === a)]![theirSpecies.indexOf(b)]!;
		expect(m('Garchomp', 'Heatran')).toBeGreaterThan(0.3);   // 4x Earthquake
		expect(m('Hatterene', 'Gholdengo')).toBeLessThan(-0.3);  // Steel and Ghost both hit it hard
		expect(m('Primarina', 'Heatran')).toBeGreaterThan(0.3);  // Water into Fire/Steel
		expect(new Set(res.pick).size).toBe(4);
		expect(res.pick.every(i => i >= 0 && i < 6)).toBe(true);
		expect(res.options.reduce((s, o) => s + o.p, 0)).toBeGreaterThan(0.9);
	}, 60000);
});
