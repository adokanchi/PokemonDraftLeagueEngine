/**
 * Team preview advice: which four to bring and who to lead with, against their six.
 *
 *   npm run preview -- --team my-team.txt --theirs "Medicham, Tyranitar, Gyarados, Gholdengo, Steelix, Pidgeot"
 *   npm run preview -- --team my-team.txt --log game1.html --as p1     # their six (and what game 1 revealed) from a log
 *
 * Options:
 *   --team FILE           your six, in Showdown export format (required)
 *   --theirs "A, B, ..."  their six (or take them from --log)
 *   --log FILE            an earlier game of the set (repeatable): what it revealed about their sets is used
 *   --as p1|p2            your side in the logs (required with --log)
 *   --their-roster FILE[:KEY]   their drafted roster (marks their Megas)
 */
import { readFileSync } from 'node:fs';
import { toTeam } from '../src/sim/battle.js';
import { extractLog, parseBattleLog } from '../src/state/parser.js';
import { knowledgeFromState, mergeKnowledge, type TeamKnowledge } from '../src/state/knowledge.js';
import { parseRoster } from '../src/draft/validator.js';
import { OpponentModel } from '../src/belief/sets.js';
import { PreviewSolver } from '../src/engine/preview.js';
import { resolveFormat } from '../src/config.js';
import type { PokemonSet } from '../src/showdown.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const all = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
const teamFile = opt('team');
if (!teamFile) {
	console.log('Usage: npm run preview -- --team my-team.txt (--theirs "A, B, C, D, E, F" | --log game1.html --as p1)');
	process.exit(1);
}
const format = resolveFormat();
const mine = toTeam(readFileSync(teamFile, 'utf8')) as PokemonSet[];
const me = (opt('as') ?? 'p1') as 'p1' | 'p2';
const them = me === 'p1' ? 'p2' : 'p1';

let knowledge: TeamKnowledge = {};
let theirSpecies = opt('theirs')?.split(',').map(s => format.dex.species.get(s.trim()).name).filter(Boolean) ?? [];
for (const file of all('log')) {
	const state = parseBattleLog(extractLog(readFileSync(file, 'utf8')), { perspective: me });
	knowledge = mergeKnowledge(knowledge, knowledgeFromState(state, them));
	if (!theirSpecies.length) theirSpecies = state.sides[them].preview;
}
if (theirSpecies.length < 4) {
	console.log("Give their six with --theirs, or a log with --log that includes team preview.");
	process.exit(1);
}
let megaStones: Record<string, string> | undefined;
const roster = opt('their-roster');
if (roster) {
	const [rfile, key] = roster.split(':');
	const text = readFileSync(rfile!, 'utf8');
	const names: string[] = rfile!.endsWith('.json') ? (key ? JSON.parse(text)[key] : JSON.parse(text)).pokemon : text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	megaStones = {};
	for (const e of parseRoster(names).entries) if (e.isMega && e.megaStone) megaStones[e.teamSpecies] = e.megaStone;
}

const model = new OpponentModel({ side: them, ownTeam: mine, knowledge, megaStones });
const theirs = theirSpecies.map(species => ({ species, sets: model.posterior(species).slice(0, 4) }));
const res = new PreviewSolver(format).solve({ mine, theirs });

const name = (s: PokemonSet) => s.species;
const short = (s: string) => s.length > 10 ? s.slice(0, 9) + '.' : s;
console.log(`One-on-one matchups (+1 = yours wins clearly, -1 = theirs does), from Showdown's damage formula, speed and their likely sets:\n`);
console.log(''.padEnd(14) + theirSpecies.map(s => short(s).padStart(11)).join(''));
res.matchup.forEach((row, i) => console.log(short(name(mine[i]!)).padEnd(14) + row.map(v => v.toFixed(2).padStart(11)).join('')));
console.log('\nRecommended (a mix when picks are close):');
for (const o of res.options) {
	const [a, b, c, d] = o.order.map(i => name(mine[i]!));
	console.log(`  ${(100 * o.p).toFixed(0).padStart(3)}%  lead ${a} + ${b}, back ${c}, ${d}`);
}
console.log('\nWhat they are likely to bring:');
for (const t of res.theirLikely) {
	const [a, b, c, d] = t.order.map(j => theirSpecies[j]);
	console.log(`  ${(100 * t.p).toFixed(0).padStart(3)}%  lead ${a} + ${b}, back ${c}, ${d}`);
}
if (Object.keys(knowledge).length) console.log(`\n(Using what earlier games revealed about ${Object.keys(knowledge).length} of their Pokémon.)`);
console.log('\nNot modelled yet: support moves (Tailwind, Trick Room, Fake Out, Intimidate, redirection), spread moves, partner synergy.');
