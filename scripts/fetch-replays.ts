/**
 * Download public Showdown replays of the league format into data/replays/ (resumable).
 *
 *   npm run fetch-replays -- --probe          # check what the replay site supports, download nothing
 *   npm run fetch-replays                     # M-C singles-game and Bo3 ladder replays, all it can find
 *   npm run fetch-replays -- --max 500        # stop after 500 new downloads
 *   npm run fetch-replays -- --min-rating 1300 --no-players
 *
 * Options:
 *   --formats a,b      format ids (default: gen9championsvgc2026regmc, gen9championsvgc2026regmcbo3)
 *   --max N            stop after N new downloads
 *   --min-rating R     skip rated replays below R (unrated ones are kept unless --rated-only)
 *   --no-players       don't search by player (only the ~5,000 newest and top-rated per format)
 *   --delay MS         pause between requests (default 300)
 *   --dir DIR          where to save (default data/replays)
 *
 * Run it again any time: replays already saved are skipped. Ctrl+C is safe.
 */
import { collect, REPLAY_DIR, ReplayClient, ReplayStore } from '../src/data/replays.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const formats = (opt('formats') ?? 'gen9championsvgc2026regmc,gen9championsvgc2026regmcbo3').split(',').map(s => s.trim()).filter(Boolean);
const client = new ReplayClient({ delayMs: Number(opt('delay') ?? 300), log: t => console.log(t) });
const store = new ReplayStore(opt('dir') ?? REPLAY_DIR);

for (const format of formats) {
	try {
		const f = await client.probe(format);
		console.log(`${format}: paging by ${f.paging}, sort by rating ${f.byRating ? 'yes' : 'no'}, search by player ${f.userParam ? `yes (${f.userParam}=)` : 'no'}; ${store.ids(format).length} already saved`);
	} catch (e) {
		console.log(`${format}: ${(e as Error).message}`);
	}
}
if (args.includes('--probe')) process.exit(0);

const t0 = Date.now();
const res = await collect(client, store, {
	formats, max: opt('max') ? Number(opt('max')) : undefined, byPlayer: !args.includes('--no-players'),
	minRating: opt('min-rating') ? Number(opt('min-rating')) : undefined, ratedOnly: args.includes('--rated-only'),
	log: t => console.log(t),
});
console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)} s: ${res.downloaded} new replays saved to ${REPLAY_DIR} (${res.found} found, ${res.skipped} already saved or skipped).`);
console.log('Check them with: npm run replay-stats');
