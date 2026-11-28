/**
 * What's in data/replays/: parses every saved replay with the engine's log parser and reports
 * counts, ratings, game length, parse problems, and what each species was seen running
 * (brought %, revealed moves, items, abilities). The revealed-set tallies are also written to
 * data/replays/revealed-<format>.json for use as set priors.
 *
 *   npm run replay-stats                 # all formats
 *   npm run replay-stats -- --format gen9championsvgc2026regmcbo3 --top 30
 *   --dir DIR    another replay folder (default data/replays)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPLAY_DIR, ReplayStore } from '../src/data/replays.js';
import { parseBattleLog } from '../src/state/parser.js';
import { knowledgeFromState } from '../src/state/knowledge.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const top = Number(opt('top') ?? 20);
const dir = opt('dir') ?? REPLAY_DIR;
const store = new ReplayStore(dir);
const formats = opt('format') ? [opt('format')!] : store.formats();
if (!formats.length) { console.log(`No replays in ${dir} yet. Run: npm run fetch-replays`); process.exit(0); }

interface Tally { teams: number; brought: number; moves: Record<string, number>; items: Record<string, number>; abilities: Record<string, number> }
const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

for (const format of formats) {
	let n = 0, failed = 0, noPreview = 0, unfinished = 0, turns = 0;
	const ratings: number[] = [];
	const failures: string[] = [];
	const species: Record<string, Tally> = {};
	let oldest = Infinity, newest = 0;
	for (const r of store.all(format)) {
		n++;
		oldest = Math.min(oldest, r.uploadtime); newest = Math.max(newest, r.uploadtime);
		if (r.rating) ratings.push(r.rating);
		let state;
		try {
			state = parseBattleLog(r.log);
		} catch (e) {
			failed++;
			if (failures.length < 5) failures.push(`${r.id}: ${(e as Error).message.split('\n')[0]}`);
			continue;
		}
		turns += state.turn;
		if (!state.ended) unfinished++;
		for (const side of ['p1', 'p2'] as const) {
			const s = state.sides[side];
			if (s.preview.length < 6) noPreview++;
			for (const sp of s.preview) (species[sp] ??= { teams: 0, brought: 0, moves: {}, items: {}, abilities: {} }).teams++;
			const known = knowledgeFromState(state, side);
			for (const k of Object.values(known)) {
				const t = (species[k.species] ??= { teams: 0, brought: 0, moves: {}, items: {}, abilities: {} });
				t.brought++;
				k.moves.forEach(m => inc(t.moves, m));
				if (k.item) inc(t.items, k.item);
				if (k.ability) inc(t.abilities, k.ability);
			}
		}
	}
	if (!n) continue;
	ratings.sort((a, b) => a - b);
	const q = (f: number) => ratings[Math.floor(f * (ratings.length - 1))];
	const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
	console.log(`\n== ${format}: ${n} replays (${day(oldest)} to ${day(newest)})`);
	console.log(`   parsed ${n - failed}${failed ? `, FAILED ${failed}` : ''}; ${unfinished} without a result; ${noPreview} sides without a full team preview; ${((turns / Math.max(1, n - failed))).toFixed(1)} turns on average`);
	if (ratings.length) console.log(`   rated ${ratings.length}: median ${q(0.5)}, 10th-90th percentile ${q(0.1)}-${q(0.9)}, top ${ratings[ratings.length - 1]}`);
	for (const f of failures) console.log(`   parse failure ${f}`);
	const rows = Object.entries(species).sort((a, b) => b[1].teams - a[1].teams).slice(0, top);
	const teamsTotal = 2 * (n - failed);
	const topOf = (o: Record<string, number>, base: number, k = 4) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k).map(([x, c]) => `${x} ${Math.round(100 * c / base)}%`).join(', ');
	console.log(`   ${'species'.padEnd(20)} on teams  brought  top moves seen | items | abilities`);
	for (const [sp, t] of rows) {
		console.log(`   ${sp.padEnd(20)} ${`${Math.round(100 * t.teams / teamsTotal)}%`.padStart(8)} ${`${Math.round(100 * t.brought / Math.max(1, t.teams))}%`.padStart(8)}  ${topOf(t.moves, t.brought)} | ${topOf(t.items, t.brought, 3)} | ${topOf(t.abilities, t.brought, 2)}`);
	}
	writeFileSync(join(dir, `revealed-${format}.json`), JSON.stringify({ format, replays: n - failed, species }, null, 1));
}
console.log(`\n(Moves/items/abilities are shares of games where the Pokémon was brought and revealed them.)`);
