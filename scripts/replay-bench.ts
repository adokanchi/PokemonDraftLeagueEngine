/**
 * How often does the engine choose what the winning player chose? Takes positions from held-out
 * replays (see isHeldOut), rebuilds each from the winner's point of view, runs the engine, and
 * compares per Pokémon with the labels from `npm run extract-positions`.
 *
 *   npm run replay-bench                      # 200 positions
 *   npm run replay-bench -- --n 500 --threads 8 --min-rating 1500
 *   npm run replay-bench -- --no-usage        # uniform set priors (to compare with usage stats)
 *
 * Options: --format F --dir REPLAYS --positions FILE --samples N --keep N --side winner|loser
 *          --seed N --out FILE (per-position results as JSON)
 *          --misses N  print up to N choices that weren't legal in the rebuilt position
 *
 * Reported, per Pokémon that had a readable choice:
 *   action  same move (or "switch" when they switched)      full  also same target / same Pokémon
 *   engine top: the engine's single most likely choice; engine mix: chance its mixed strategy matches;
 *   random: a uniformly random legal action; frequent: the move this species is most often seen using
 *   (from the training replays) among the legal ones.
 */
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { REPLAY_DIR, ReplayStore } from '../src/data/replays.js';
import { isHeldOut, type GameLabels, type SlotLabel } from '../src/data/positions.js';
import { agreement, benchInput, legalSlotActions, slotActions, type SlotAction } from '../src/data/bench.js';
import { loadPrior, UniformPrior } from '../src/data/priors.js';
import { solveTurn, solveTurnParallel } from '../src/engine/solver.js';
import { defaultThreads, SearchPool } from '../src/engine/pool.js';
import { makeRng } from '../src/sim/play.js';
import { toID } from '../src/showdown.js';
import type { SideId } from '../src/state/types.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name: string) => args.includes(`--${name}`);
const store = new ReplayStore(opt('dir') ?? REPLAY_DIR);
const format = opt('format') ?? store.formats()[0];
if (!format) { console.log('No replays found. Run: npm run fetch-replays'); process.exit(0); }
const positionsFile = opt('positions') ?? join(process.cwd(), 'data', 'positions', `${format}.jsonl.gz`);
if (!existsSync(positionsFile)) { console.log(`No labels at ${positionsFile}. Run: npm run extract-positions`); process.exit(0); }
const n = Number(opt('n') ?? 200);
const minRating = Number(opt('min-rating') ?? 0);
const whose = (opt('side') ?? 'winner') as 'winner' | 'loser';
const seed = Number(opt('seed') ?? 1);
const threads = Number(opt('threads') ?? defaultThreads());
const samples = Number(opt('samples') ?? 6);
const keep = Number(opt('keep') ?? 12);
const prior = flag('no-usage') ? new UniformPrior() : loadPrior();

// Labels: species move frequencies from training games; candidate positions from held-out ones.
const freq = new Map<string, Map<string, number>>();
interface Candidate { id: string; turn: number; side: SideId; slots: (SlotLabel | null)[] }
const byGame = new Map<string, Candidate[]>();
const rl = createInterface({ input: createReadStream(positionsFile).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
	if (!line) continue;
	const g = JSON.parse(line) as GameLabels & { id: string; rating: number | null };
	const held = isHeldOut(g.id);
	for (const t of g.turns) {
		if (!held) {
			t.slots.forEach((l, i) => {
				const sp = t.species?.[i];
				if (!l || !sp || l.action === 'unknown') return;
				const key = l.action === 'move' ? `move:${l.move}` : 'switch';
				const m = freq.get(toID(sp)) ?? new Map<string, number>();
				m.set(key, (m.get(key) ?? 0) + 1);
				freq.set(toID(sp), m);
			});
			continue;
		}
		if (!g.winner || (g.rating ?? 0) < minRating) continue;
		const side = whose === 'winner' ? g.winner : (g.winner === 'p1' ? 'p2' : 'p1');
		if (t.side !== side || !t.slots.some(l => l && l.action !== 'unknown')) continue;
		const list = byGame.get(g.id) ?? [];
		list.push({ id: g.id, turn: t.turn, side, slots: t.slots });
		byGame.set(g.id, list);
	}
}
// One position per game, games and turns picked at random.
const rng = makeRng(seed);
const games = [...byGame.keys()].sort();
for (let i = games.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [games[i], games[j]] = [games[j]!, games[i]!]; }
const picked = games.slice(0, n).map(id => { const l = byGame.get(id)!; return l[Math.floor(rng() * l.length)]!; });
console.log(`${format}: ${byGame.size} held-out games with ${whose}s' choices; benchmarking ${picked.length} positions`);
console.log(`prior: ${prior.source}; search: ${samples} guesses, ${keep} options per side, ${threads} threads\n`);

type Score = { action: number; full: number };
const tally: Record<string, Score> = {};
const add = (k: string, s: Score) => { const t = (tally[k] ??= { action: 0, full: 0 }); t.action += s.action; t.full += s.full; };
let slotsScored = 0, legalAction = 0, legalFull = 0, skipped = 0, failed = 0, done = 0;
const skips: Record<string, number> = {};
const results: unknown[] = [];
const missLimit = Number(opt('misses') ?? 0);
const misses: string[] = [];
const pool = threads > 1 ? await SearchPool.start(threads) : undefined;
const started = Date.now();
try {
	for (const c of picked) {
		const lines = store.load(format, c.id).log.split('\n');
		const setup = benchInput(lines, c.turn, c.side, { prior, samples, keep, seed });
		if ('skip' in setup) { skipped++; skips[setup.skip] = (skips[setup.skip] ?? 0) + 1; continue; }
		let res;
		try {
			res = pool ? await solveTurnParallel(setup.input, pool) : solveTurn(setup.input);
		} catch (e) {
			failed++;
			if (failed <= 5) console.warn(`  ${c.id} turn ${c.turn}: ${(e as Error).message.split('\n')[0]}`);
			continue;
		}
		const ref = res.reference;
		const legal = legalSlotActions(ref, c.side);
		const top = [...res.options].sort((a, b) => b.p - a.p)[0]!;
		const topActs = slotActions(ref, c.side, top.choice);
		const mixActs = res.options.map(o => ({ p: o.p, acts: slotActions(ref, c.side, o.choice) }));
		const mixTotal = mixActs.reduce((s, o) => s + o.p, 0) || 1;
		const species = ref.sides[c.side === 'p1' ? 0 : 1]!.active.map(m => toID(m?.species.name ?? ''));
		const per: unknown[] = [];
		c.slots.forEach((l, i) => {
			if (!l || l.action === 'unknown' || !legal[i]) return;
			slotsScored++;
			const opts: SlotAction[] = legal[i]!;
			const ag = opts.map(a => agreement(a, l));
			if (ag.some(x => x.action)) legalAction++;
			else if (misses.length < missLimit) {
				const mon = ref.sides[c.side === 'p1' ? 0 : 1]!.active[i];
				misses.push(`${c.id} turn ${c.turn} ${c.side}${'ab'[i]} ${mon?.species.name ?? '?'}: chose ${JSON.stringify(l)}\n    rebuilt moves: ${mon?.moveSlots.map(m => `${m.id}${m.disabled ? ' (disabled)' : ''}`).join(', ')}; team: ${ref.sides[c.side === 'p1' ? 0 : 1]!.pokemon.map(p => `${p.species.name}${p.fainted ? ' (fainted)' : ''}`).join(', ')}\n    legal: ${opts.map(a => a.key).join(' ')}`);
			}
			if (ag.some(x => x.full)) legalFull++;
			const t = agreement(topActs[i] ?? { key: '', kind: 'other' }, l);
			add('engine top', { action: +t.action, full: +t.full });
			const mix = mixActs.reduce((s, o) => { const a = agreement(o.acts[i] ?? { key: '', kind: 'other' }, l); return { action: s.action + o.p * +a.action, full: s.full + o.p * +a.full }; }, { action: 0, full: 0 });
			add('engine mix', { action: mix.action / mixTotal, full: mix.full / mixTotal });
			add('random', { action: ag.filter(x => x.action).length / opts.length, full: ag.filter(x => x.full).length / opts.length });
			// Most frequent: by species' move counts in training games ("switch" counts as one action).
			const counts = freq.get(species[i] ?? '') ?? new Map<string, number>();
			const score = (a: SlotAction) => counts.get(a.kind === 'switch' ? 'switch' : a.key) ?? 0;
			const best = opts.reduce((b, a) => (score(a) > score(b) ? a : b), opts[0]!);
			const fa = agreement(best, l);
			add('frequent', { action: +fa.action, full: +fa.full });
			per.push({ slot: i, label: l, engine: topActs[i], match: t });
		});
		results.push({ id: c.id, turn: c.turn, side: c.side, slots: per, value: res.value, ms: res.ms });
		done++;
		if (done % 10 === 0) {
			const s = tally['engine top']!;
			console.log(`  ${done}/${picked.length} positions, ${slotsScored} choices: engine top ${(100 * s.action / slotsScored).toFixed(1)}% same action (${((Date.now() - started) / 1000 / done).toFixed(1)} s per position)`);
		}
	}
} finally {
	await pool?.close();
}

console.log(`\n${done} positions, ${slotsScored} Pokémon choices compared (${skipped} positions skipped${Object.keys(skips).length ? `: ${JSON.stringify(skips)}` : ''}; ${failed} failed)`);
console.log(`their choice was legal in the rebuilt position: ${(100 * legalAction / Math.max(1, slotsScored)).toFixed(1)}% (action), ${(100 * legalFull / Math.max(1, slotsScored)).toFixed(1)}% (with target / Pokémon)\n`);
console.log(`${''.padEnd(12)} ${'action'.padStart(8)} ${'full'.padStart(8)}`);
for (const k of ['engine top', 'engine mix', 'frequent', 'random']) {
	const s = tally[k];
	if (!s) continue;
	console.log(`${k.padEnd(12)} ${`${(100 * s.action / slotsScored).toFixed(1)}%`.padStart(8)} ${`${(100 * s.full / slotsScored).toFixed(1)}%`.padStart(8)}`);
}
if (misses.length) console.log(`\nNot legal in the rebuilt position:\n${misses.join('\n')}`);
const out = opt('out');
if (out) { writeFileSync(out, JSON.stringify({ format, prior: prior.source, samples, keep, tally, slotsScored, results }, null, 1)); console.log(`\nper-position results: ${out}`); }
process.exit(0);
