/**
 * Public Showdown replays: search, download, and a local store (data/replays/).
 *
 * The replay site's search returns up to 51 entries per page, newest first (or by rating), and
 * stops after page 100 — about 5,000 replays per query. To reach further back, `collect` also
 * searches by player: every player seen in a format is searched in that format too.
 *
 * Each replay is saved as data/replays/<format>/<id>.json.gz with its id, format, players,
 * upload time, rating and full log. Downloads are resumable (existing files are skipped) and
 * rate-limited.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const REPLAY_DIR = join(process.cwd(), 'data', 'replays');
export const REPLAY_SITE = 'https://replay.pokemonshowdown.com';

export interface ReplayEntry {
	id: string;
	format?: string;
	/** Player names (the site sends a list, or a comma-separated string). */
	players: string[];
	uploadtime: number;
	rating?: number | null;
	/** Set on private replays (we never fetch those). */
	password?: string | null;
}

export interface Replay extends ReplayEntry {
	log: string;
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ClientOptions {
	site?: string;
	/** Pause between requests, ms (default 300). */
	delayMs?: number;
	fetch?: Fetcher;
	log?: (text: string) => void;
	userAgent?: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function normalise(e: Record<string, unknown>): ReplayEntry | undefined {
	if (typeof e.id !== 'string') return undefined;
	const players = Array.isArray(e.players) ? (e.players as string[]) : typeof e.players === 'string' ? e.players.split(',') : [];
	return {
		id: e.id, format: typeof e.format === 'string' ? e.format : undefined,
		players: players.map(p => p.replace(/^!/, '').trim()).filter(Boolean),
		uploadtime: Number(e.uploadtime) || 0, rating: e.rating == null ? null : Number(e.rating),
		password: typeof e.password === 'string' ? e.password : null,
	};
}

/** What the live site supports, found by probing (paging style, rating sort, user search parameter). */
export interface SiteFeatures {
	paging: 'page' | 'before' | 'none';
	byRating: boolean;
	userParam: 'user' | 'username' | null;
}

export class ReplayClient {
	private readonly site: string;
	private readonly delay: number;
	private readonly fetchImpl: Fetcher;
	private last = 0;
	features?: SiteFeatures;

	constructor(private readonly opts: ClientOptions = {}) {
		this.site = opts.site ?? REPLAY_SITE;
		this.delay = opts.delayMs ?? 300;
		const ua = opts.userAgent ?? 'PokemonDraftLeagueEngine replay collector (practice/analysis tool)';
		this.fetchImpl = opts.fetch ?? ((url: string) => fetch(url, { headers: { 'User-Agent': ua } }));
	}

	private log(text: string) { this.opts.log?.(text); }

	/** GET with a polite delay between requests and retries with backoff on 429 / 5xx / network errors. */
	async get(path: string): Promise<string | undefined> {
		const url = `${this.site}${path}`;
		for (let attempt = 0; attempt < 5; attempt++) {
			const wait = this.last + this.delay - Date.now();
			if (wait > 0) await sleep(wait);
			this.last = Date.now();
			try {
				const res = await this.fetchImpl(url);
				if (res.ok) return await res.text();
				if (res.status === 404) return undefined;
				if (res.status !== 429 && res.status < 500) throw new Error(`${res.status} for ${url}`);
				this.log(`  ${res.status} from the replay site; backing off`);
			} catch (e) {
				if (/^\d{3} for/.test((e as Error).message)) throw e;
				this.log(`  network error (${(e as Error).message}); retrying`);
			}
			await sleep(2000 * 2 ** attempt);
		}
		throw new Error(`gave up on ${url}`);
	}

	async search(params: Record<string, string | number>): Promise<ReplayEntry[]> {
		const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
		const text = await this.get(`/search.json?${qs}`);
		if (!text) return [];
		let data: unknown;
		try { data = JSON.parse(text.replace(/^\]\)\}'?\n?/, '')); } catch { throw new Error(`search returned something other than JSON: ${text.slice(0, 120)}`); }
		const list = Array.isArray(data) ? data : (data as { replays?: unknown[] })?.replays ?? [];
		return list.map(e => normalise(e as Record<string, unknown>)).filter((e): e is ReplayEntry => !!e && !e.password);
	}

	/** Find out how the live site pages, sorts and searches by user (results differ in each case). */
	async probe(format: string): Promise<SiteFeatures> {
		const first = await this.search({ format });
		if (!first.length) throw new Error(`no public replays found for ${format}`);
		const ids = (l: ReplayEntry[]) => l.map(e => e.id).join(',');
		let paging: SiteFeatures['paging'] = 'none';
		const p2 = await this.search({ format, page: 2 });
		if (p2.length && ids(p2) !== ids(first)) paging = 'page';
		else {
			const oldest = Math.min(...first.map(e => e.uploadtime));
			const b = await this.search({ format, before: oldest });
			if (b.length && ids(b) !== ids(first)) paging = 'before';
		}
		const rated = await this.search({ format, sort: 'rating' });
		const byRating = rated.length > 0 && ids(rated) !== ids(first) && rated.every((e, i) => i === 0 || (e.rating ?? 0) <= (rated[i - 1]!.rating ?? 0));
		let userParam: SiteFeatures['userParam'] = null;
		const someone = first[0]!.players[0];
		if (someone) {
			for (const p of ['user', 'username'] as const) {
				const r = await this.search({ [p]: someone, format });
				if (r.length && r.every(e => e.players.some(x => x.toLowerCase().replace(/[^a-z0-9]/g, '') === someone.toLowerCase().replace(/[^a-z0-9]/g, '')))) { userParam = p; break; }
			}
		}
		this.features = { paging, byRating, userParam };
		return this.features;
	}

	/** All search results for a query, page by page (up to `maxPages`). */
	async *searchAll(params: Record<string, string | number>, maxPages = 100): AsyncGenerator<ReplayEntry[]> {
		const f = this.features ?? { paging: 'page', byRating: false, userParam: null };
		let before: number | undefined;
		const seen = new Set<string>();
		for (let page = 1; page <= maxPages; page++) {
			const q = { ...params, ...(f.paging === 'page' && page > 1 ? { page } : {}), ...(f.paging === 'before' && before ? { before } : {}) };
			const got = await this.search(q);
			// (51 results means there is another page; the 51st comes first on it.)
			const pageEntries = got.slice(0, 50);
			const fresh = pageEntries.filter(e => !seen.has(e.id));
			if (!fresh.length) return;
			fresh.forEach(e => seen.add(e.id));
			yield fresh;
			if (got.length <= 50 || f.paging === 'none') return;
			before = Math.min(...pageEntries.map(e => e.uploadtime));
		}
	}

	async replay(id: string): Promise<Replay | undefined> {
		const text = await this.get(`/${id}.json`);
		if (!text) return undefined;
		const r = JSON.parse(text) as Record<string, unknown>;
		const e = normalise(r);
		if (!e || typeof r.log !== 'string') return undefined;
		return { ...e, log: r.log };
	}
}

/** Local store of downloaded replays. */
export class ReplayStore {
	constructor(readonly dir = REPLAY_DIR) {}

	private path(format: string, id: string) { return join(this.dir, format, `${id}.json.gz`); }

	has(format: string, id: string) { return existsSync(this.path(format, id)); }

	save(format: string, r: Replay) {
		mkdirSync(join(this.dir, format), { recursive: true });
		writeFileSync(this.path(format, r.id), gzipSync(JSON.stringify(r)));
	}

	formats(): string[] {
		return existsSync(this.dir) ? readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];
	}

	ids(format: string): string[] {
		const d = join(this.dir, format);
		return existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.json.gz')).map(f => f.slice(0, -8)) : [];
	}

	load(format: string, id: string): Replay {
		return JSON.parse(gunzipSync(readFileSync(this.path(format, id))).toString('utf8'));
	}

	*all(format?: string): Generator<Replay> {
		for (const f of format ? [format] : this.formats()) for (const id of this.ids(f)) yield this.load(f, id);
	}
}

export interface CollectOptions {
	formats: string[];
	/** Stop after this many new downloads (default: no limit). */
	max?: number;
	/** Also search every player seen, to reach beyond the ~5,000 newest per format (default true). */
	byPlayer?: boolean;
	/** Skip replays below this rating (unrated ones are kept unless `ratedOnly`). */
	minRating?: number;
	ratedOnly?: boolean;
	log?: (text: string) => void;
}

/** Search the formats (newest, top-rated, then by player) and download every replay not already stored. */
export async function collect(client: ReplayClient, store: ReplayStore, opts: CollectOptions): Promise<{ downloaded: number; found: number; skipped: number }> {
	const log = opts.log ?? (() => {});
	let downloaded = 0, found = 0, skipped = 0;
	const done = () => opts.max !== undefined && downloaded >= opts.max;
	const keep = (e: ReplayEntry) => (e.rating == null ? !opts.ratedOnly : e.rating >= (opts.minRating ?? 0));
	for (const format of opts.formats) {
		if (done()) break;
		const queued = new Set<string>();
		const players = new Set<string>();
		const take = async (entries: ReplayEntry[]) => {
			for (const e of entries) {
				e.players.forEach(p => players.add(p));
				if (queued.has(e.id)) continue;
				queued.add(e.id);
				found++;
				if (!keep(e) || store.has(format, e.id)) { skipped++; continue; }
				if (done()) return;
				const r = await client.replay(e.id);
				if (!r) { skipped++; continue; }
				store.save(format, { ...r, rating: r.rating ?? e.rating ?? null });
				downloaded++;
				if (downloaded % 25 === 0) log(`  ${format}: ${downloaded} downloaded (${found} found so far)`);
			}
		};
		log(`${format}: newest replays`);
		for await (const page of client.searchAll({ format })) { await take(page); if (done()) break; }
		if (client.features?.byRating && !done()) {
			log(`${format}: top-rated replays`);
			for await (const page of client.searchAll({ format, sort: 'rating' })) { await take(page); if (done()) break; }
		}
		if (opts.byPlayer !== false && client.features?.userParam && !done()) {
			const searched = new Set<string>();
			log(`${format}: searching by player (${players.size} so far)`);
			for (let progress = true; progress && !done();) {
				progress = false;
				for (const p of [...players]) {
					if (searched.has(p) || done()) continue;
					searched.add(p);
					progress = true;
					for await (const page of client.searchAll({ [client.features.userParam]: p, format })) { await take(page); if (done()) break; }
				}
			}
		}
	}
	return { downloaded, found, skipped };
}
