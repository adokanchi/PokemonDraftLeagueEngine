/**
 * Check a roster (and optionally a team) against the league draft rules + Showdown's validator.
 *
 *   npm run validate -- examples/rosters.json:a
 *   npm run validate -- examples/rosters.json:a examples/team-a.txt
 *   npm run validate -- my-roster.txt my-team.txt      (roster .txt: one Pokémon per line)
 */
import { readFileSync } from 'node:fs';
import { parseRoster, validateRoster, validateTeam } from '../src/draft/validator.js';
import { toTeam } from '../src/sim/battle.js';

function loadRoster(spec: string) {
	const [file, key] = spec.split(/:(?=[^\\/]+$)/);
	const text = readFileSync(file!, 'utf8');
	if (file!.endsWith('.json')) {
		const json = JSON.parse(text);
		const entry = key ? json[key] : json;
		if (!entry?.pokemon) throw new Error(`No "pokemon" list in ${spec}`);
		return parseRoster(entry.pokemon, entry.coach);
	}
	return parseRoster(text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')));
}

const [rosterSpec, teamFile] = process.argv.slice(2);
if (!rosterSpec) {
	console.log('Usage: npm run validate -- <roster.json[:key] | roster.txt> [team.txt]');
	process.exit(1);
}
const roster = loadRoster(rosterSpec);
console.log(`Roster${roster.coach ? ` (${roster.coach})` : ''}: ${roster.entries.map(e => e.species.name + (e.isMega ? ` [Mega, holds ${e.megaStone}]` : '')).join(', ')}`);
const r = validateRoster(roster);
console.log(r.valid ? '  Roster OK' : r.problems.map(p => `  ✗ ${p}`).join('\n'));
let ok = r.valid;
if (teamFile) {
	const t = validateTeam(toTeam(readFileSync(teamFile, 'utf8')), roster);
	console.log(t.valid ? '  Team OK' : t.problems.map(p => `  ✗ ${p}`).join('\n'));
	ok &&= t.valid;
}
process.exit(ok ? 0 : 1);
