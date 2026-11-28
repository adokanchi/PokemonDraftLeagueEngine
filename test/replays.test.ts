import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collect, ReplayClient, ReplayStore, type Fetcher } from '../src/data/replays.js';
import { parseBattleLog, viewOfLog } from '../src/state/parser.js';
import { legalChoices, sidesNeedingChoice, submit } from '../src/sim/battle.js';
import { makeRng } from '../src/sim/play.js';
import { randomBattle } from './helpers.js';

/** A fake replay site: 51 per page, page cap (like the real one's 100), rating sort, user search. */
function fakeSite(n: number, pageCap: number) {
	const players = ['ash', 'misty', 'brock', 'may', 'dawn', 'iris'];
	const logs = new Map<number, string>();
	const logFor = (i: number) => {
		if (!logs.has(i % 5)) {
			const b = randomBattle(i % 5 + 1, true); const rng = makeRng(i);
			while (!b.ended && b.turn < 30) for (const s of sidesNeedingChoice(b)) { const o = legalChoices(b, s); submit(b, s, o[Math.floor(rng() * o.length)]!); if (b.ended) break; }
			logs.set(i % 5, viewOfLog(b.log).join('\n'));
		}
		return logs.get(i % 5)!;
	};
	const all = Array.from({ length: n }, (_, i) => ({
		id: `gen9championsvgc2026regmc-${1000 + i}`, format: '[Gen 9 Champions] VGC 2026 Reg M-C',
		players: [players[i % 6]!, players[(i + 1) % 6]!], uploadtime: 1_700_000_000 + i * 60, rating: 1100 + (i * 37) % 600,
	}));
	let requests = 0;
	const fetch: Fetcher = async url => {
		requests++;
		const u = new URL(url);
		const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
		if (u.pathname === '/search.json') {
			const page = Number(u.searchParams.get('page') ?? 1);
			const user = u.searchParams.get('user');
			let list = [...all].sort((a, b) => b.uploadtime - a.uploadtime);
			if (u.searchParams.get('sort') === 'rating') list.sort((a, b) => b.rating - a.rating);
			if (user) list = list.filter(e => e.players.includes(user));
			else if (page > pageCap) return ok([]);
			return ok(list.slice((page - 1) * 50, (page - 1) * 50 + 51).map(e => ({ ...e, players: e.players.join(',') })));
		}
		const id = u.pathname.slice(1).replace(/\.json$/, '');
		const e = all.find(x => x.id === id);
		return e ? ok({ ...e, log: logFor(Number(id.split('-').pop())) }) : { ok: false, status: 404, text: async () => '' };
	};
	return { fetch, total: n, requests: () => requests };
}

const dir = mkdtempSync(join(tmpdir(), 'replays-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('replay collection', () => {
	it('probes the site, pages past the search cap via players, resumes, and stores parseable logs', async () => {
		const site = fakeSite(230, 2);
		const client = new ReplayClient({ site: 'https://replays.test', delayMs: 0, fetch: site.fetch });
		const f = await client.probe('gen9championsvgc2026regmc');
		expect(f).toEqual({ paging: 'page', byRating: true, userParam: 'user' });
		const store = new ReplayStore(dir);
		const first = await collect(client, store, { formats: ['gen9championsvgc2026regmc'] });
		// The format search alone reaches 100 (2 pages) + the top-rated pages; players reach the rest.
		expect(first.downloaded).toBe(230);
		expect(store.ids('gen9championsvgc2026regmc')).toHaveLength(230);
		const again = await collect(client, store, { formats: ['gen9championsvgc2026regmc'] });
		expect(again.downloaded).toBe(0);
		const r = store.load('gen9championsvgc2026regmc', 'gen9championsvgc2026regmc-1007');
		expect(r.players).toHaveLength(2);
		const state = parseBattleLog(r.log);
		expect(state.sides.p1.preview.length).toBeGreaterThan(0);
		expect(state.turn).toBeGreaterThan(0);
	}, 120000);

	it('respects max and minimum rating', async () => {
		const site = fakeSite(120, 3);
		const client = new ReplayClient({ site: 'https://replays.test', delayMs: 0, fetch: site.fetch });
		await client.probe('gen9championsvgc2026regmc');
		const store = new ReplayStore(join(dir, 'b'));
		const res = await collect(client, store, { formats: ['gen9championsvgc2026regmc'], max: 30, minRating: 1400 });
		expect(res.downloaded).toBe(30);
		for (const r of store.all()) expect(r.rating!).toBeGreaterThanOrEqual(1400);
	}, 120000);
});
