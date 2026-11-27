/**
 * Download Smogon usage stats ("chaos" JSON) for the league format into data/usage/.
 * The engine uses them as a prior for opponents' abilities, items, moves and spreads.
 *
 *   npm run fetch-usage                    # newest month available, rating cutoff 1500
 *   npm run fetch-usage -- 2026-10 0       # a specific month and cutoff (0, 1500, 1630, 1760)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFormat } from '../src/config.js';
import { USAGE_DIR } from '../src/data/priors.js';

const format = resolveFormat();
const [monthArg, cutoffArg] = process.argv.slice(2);
const cutoffs = cutoffArg ? [cutoffArg] : ['1500', '0'];

function recentMonths(n: number): string[] {
	const out: string[] = [];
	const d = new Date();
	for (let i = 0; i < n; i++) {
		d.setUTCDate(1);
		d.setUTCMonth(d.getUTCMonth() - 1);
		out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
	}
	return out;
}

const months = monthArg ? [monthArg] : recentMonths(4);
for (const month of months) {
	for (const cutoff of cutoffs) {
		const url = `https://www.smogon.com/stats/${month}/chaos/${format.formatId}-${cutoff}.json`;
		process.stdout.write(`Trying ${url} ... `);
		const res = await fetch(url);
		if (!res.ok) { console.log(res.status); continue; }
		const text = await res.text();
		const json = JSON.parse(text);
		mkdirSync(USAGE_DIR, { recursive: true });
		const file = join(USAGE_DIR, `${format.formatId}-${month}-${cutoff}.json`);
		writeFileSync(file, text);
		console.log(`ok: ${Object.keys(json.data ?? {}).length} Pokémon, saved to ${file}`);
		process.exit(0);
	}
}
console.log('No usage stats found for this format. The engine will use uniform priors.');
process.exit(1);
