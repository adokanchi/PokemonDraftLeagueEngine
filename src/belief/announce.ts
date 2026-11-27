/**
 * Which abilities announce themselves when their holder switches in?
 *
 * Measured from the simulator rather than hand-listed: each legal ability is put on a carrier and
 * switched in, in two contexts. A "rich" context (foes hold items and have attacking moves) and a
 * "minimal" one (foes hold nothing and only have Splash).
 *  - always:      announced in both (Intimidate, Sand Stream, Unnerve, Mold Breaker, Pressure...)
 *  - conditional: announced only in the rich context (Frisk, Anticipation...)
 *  - never:       silent on switch-in (Illusion, Levitate, Prankster...)
 * Weather and terrain setters are also recorded: they stay silent if their weather/terrain is
 * already up.
 */
import { toID, type PokemonSet } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';
import { createBattle, sidesNeedingChoice, submit } from '../sim/battle.js';
import { parseBattleLog, viewOfLog } from '../state/parser.js';

export type Announce = 'always' | 'conditional' | 'never';

export interface AnnounceInfo {
	announce: Announce;
	/** Weather id it sets on switch-in, if any. */
	weather?: string;
	/** Terrain id it sets on switch-in, if any. */
	terrain?: string;
}

const cache = new Map<string, Map<string, AnnounceInfo>>();

function carrierFor(ability: string, format: ResolvedFormat): string | undefined {
	const id = toID(ability);
	const candidates = format.dex.species.all().filter(s => s.exists && !s.isNonstandard && !s.battleOnly &&
		Object.values(s.abilities).some(a => toID(a as string) === id));
	return candidates.find(s => s.baseSpecies !== 'Zoroark')?.name ?? candidates[0]?.name;
}

function mon(species: string, ability: string, item: string, moves: string[]): PokemonSet {
	return {
		name: '', species, item, ability, moves, nature: 'Hardy', gender: '', level: 50,
		evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
		ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
	} as PokemonSet;
}

function probe(ability: string, carrier: string, rich: boolean, format: ResolvedFormat) {
	const filler = (s: string) => mon(s, 'Run Away', '', ['Splash']);
	const foeMoves = rich ? ['Tackle', 'Ember', 'Water Gun', 'Thunderbolt'] : ['Splash'];
	const p1 = [mon(carrier, ability, '', ['Splash']), filler('Furret'), filler('Linoone'), filler('Bibarel')];
	const p2 = [
		mon('Furret', 'Run Away', rich ? 'Leftovers' : '', foeMoves),
		mon('Linoone', 'Run Away', rich ? 'Sitrus Berry' : '', foeMoves),
		filler('Bibarel'), filler('Raticate'),
	];
	const battle = createBattle({ format, p1: { name: 'A', team: p1 }, p2: { name: 'B', team: p2 }, seed: 1, keepLog: true });
	for (const side of sidesNeedingChoice(battle)) submit(battle, side, 'team 1234');
	const state = parseBattleLog(viewOfLog(battle.log).join('\n'));
	const carrierMon = state.sides.p1.pokemon.find(p => p.activeSlot === 0);
	const announced = carrierMon?.ability === toID(ability) || carrierMon?.baseAbility === toID(ability);
	const log = battle.log.join('\n');
	const weather = new RegExp(`\\|-weather\\|(\\w+)\\|\\[from\\] ability: ${format.dex.abilities.get(ability).name}`).exec(log)?.[1];
	const terrain = new RegExp(`\\|-fieldstart\\|move: ([\\w ]+)\\|\\[from\\] ability: ${format.dex.abilities.get(ability).name}`).exec(log)?.[1];
	return { announced, weather: weather ? toID(weather) : undefined, terrain: terrain ? toID(terrain) : undefined };
}

/** Switch-in announcement behaviour of every legal ability in the format (cached per format). */
export function switchInAnnouncements(format: ResolvedFormat = resolveFormat()): Map<string, AnnounceInfo> {
	const hit = cache.get(format.formatId);
	if (hit) return hit;
	const out = new Map<string, AnnounceInfo>();
	for (const ab of format.dex.abilities.all()) {
		if (!ab.exists || ab.isNonstandard || ab.id === 'noability') continue;
		const carrier = carrierFor(ab.name, format);
		if (!carrier) continue;
		const rich = probe(ab.name, carrier, true, format);
		const minimal = probe(ab.name, carrier, false, format);
		const announce: Announce = minimal.announced ? 'always' : rich.announced ? 'conditional' : 'never';
		out.set(ab.id, { announce, weather: rich.weather ?? minimal.weather, terrain: rich.terrain ?? minimal.terrain });
	}
	cache.set(format.formatId, out);
	return out;
}
