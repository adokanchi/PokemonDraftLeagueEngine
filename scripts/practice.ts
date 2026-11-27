/**
 * Practice against the engine on a local Showdown server.
 *
 *   npm run server                                     # terminal 1: local Showdown server on port 8000
 *   npm run practice -- --team their-team.txt          # terminal 2: the engine logs in as "EngineBot"
 *
 * Then open http://localhost:8000 in your browser, pick any name, and challenge EngineBot to
 * "[Gen 9 Champions] VGC 2026 Reg M-C" (Bo3 or single games) with your team.
 *
 * Options:
 *   --team FILE           the engine's six, in Showdown export format (required)
 *   --name NAME           its user name (default EngineBot)
 *   --server HOST:PORT    default localhost:8000
 *   --bring "A,B,C,D"     always bring these four in this order (leads first); default: a random pick
 *   --their-roster FILE[:KEY]  your drafted roster (marks your Megas for it)
 *   --threads N           worker threads for its search (default: all hardware threads but one)
 *   --samples N --keep N  search size (default 6 and 12, as in advise)
 *   --challenge USER      challenge USER instead of waiting to be challenged
 */
import { readFileSync } from 'node:fs';
import { toTeam } from '../src/sim/battle.js';
import { parseRoster } from '../src/draft/validator.js';
import { resolveFormat } from '../src/config.js';
import { defaultThreads, SearchPool } from '../src/engine/pool.js';
import { PracticeClient } from '../src/practice/client.js';
import type { PokemonSet } from '../src/showdown.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const teamFile = opt('team');
if (!teamFile) {
	console.log('Usage: npm run practice -- --team their-team.txt [--name EngineBot] [--bring "A,B,C,D"] [--threads N]');
	process.exit(1);
}
const team = toTeam(readFileSync(teamFile, 'utf8')) as PokemonSet[];
let megaStones: Record<string, string> | undefined;
const roster = opt('their-roster');
if (roster) {
	const [rfile, key] = roster.split(':');
	const text = readFileSync(rfile!, 'utf8');
	const names: string[] = rfile!.endsWith('.json') ? (key ? JSON.parse(text)[key] : JSON.parse(text)).pokemon : text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	megaStones = {};
	for (const e of parseRoster(names).entries) if (e.isMega && e.megaStone) megaStones[e.teamSpecies] = e.megaStone;
}
const threads = Number(opt('threads') ?? defaultThreads());
const pool = threads > 1 ? await SearchPool.start(threads) : undefined;
const format = resolveFormat();
const name = opt('name') ?? 'EngineBot';
const client = new PracticeClient({
	server: opt('server') ?? 'localhost:8000', name, team, formats: [format.formatId], megaStones,
	bring: opt('bring')?.split(',').map(s => s.trim()),
	solve: { samples: Number(opt('samples') ?? 6), keep: Number(opt('keep') ?? 12) },
	pool, challenge: opt('challenge'),
});
await client.connect();
console.log(`${name} is waiting for challenges in "${format.dex.formats.get(format.formatId).name}" (single games or Bo3), searching on ${threads} thread${threads > 1 ? 's' : ''}.`);
console.log(`Open http://${opt('server') ?? 'localhost:8000'} in your browser and challenge ${name}. Ctrl+C to stop.`);
process.on('SIGINT', () => { client.close(); void pool?.close().then(() => process.exit(0)); });
