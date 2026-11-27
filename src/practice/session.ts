/**
 * The engine playing one battle on a Showdown server: reads the battle room's messages, keeps the
 * opponent model up to date, and answers each request (team preview, moves, forced switches).
 *
 * It sees exactly what a player sees: its own side's details (from the requests and the private
 * log lines) and the public log. What the opponent revealed in earlier games of a Bo3 is passed in
 * as `knowledge`, and `finish()` returns what this game added.
 */
import { toID, type PokemonSet } from '../showdown.js';
import { enumerateChoices, type Request, type RequestPokemon, type TargetContext } from '../sim/choices.js';
import { makeRng } from '../sim/play.js';
import { OpponentModel } from '../belief/sets.js';
import type { SetPrior } from '../data/priors.js';
import { knowledgeFromState, type TeamKnowledge } from '../state/knowledge.js';
import type { SideId } from '../state/types.js';
import { describeChoice, solveTurn, solveTurnParallel, type SolveOptions, type SolveResult } from '../engine/solver.js';
import type { SearchPool } from '../engine/pool.js';

export interface SessionOptions {
	room: string;
	/** Our six, as on the team sheet. */
	team: PokemonSet[];
	/** Which four to bring, in order (leads first). Default: a random pick each game. */
	bring?: string[];
	/** What earlier games of this set revealed about the opponent. */
	knowledge?: TeamKnowledge;
	/** The opponent's drafted Megas (team species -> stone), if known. */
	megaStones?: Record<string, string>;
	prior?: SetPrior;
	solve?: SolveOptions;
	pool?: SearchPool;
	seed?: number;
	/** Send a command in this battle room (e.g. "/choose move 1 1, move 2|3"). */
	send: (command: string) => void;
	/** Progress notes (decisions and what the engine expects). */
	note?: (text: string) => void;
}

const speciesOf = (details: string) => details.split(',')[0]!.trim();

export class BattleSession {
	private lines: string[] = [];
	private model?: OpponentModel;
	private fed = 0;
	private me?: SideId;
	private lastRequest?: BattleSession['request'];
	private request?: Request & { rqid?: number; side: { id: SideId; name: string; pokemon: (RequestPokemon & { stats?: unknown })[] } };
	private turnSeen = 0;
	private decidedTurn = -1;
	private deciding = false;
	private rng: () => number;
	ended = false;
	winner?: string;
	readonly timings: number[] = [];

	constructor(private readonly opts: SessionOptions) {
		this.rng = makeRng(opts.seed ?? 1);
	}

	/** Lines of one message for this room (without the ">room" header). */
	receive(lines: string[]) {
		for (const line of lines) {
			if (line.startsWith('|request|')) {
				const json = line.slice('|request|'.length);
				if (json) this.request = JSON.parse(json);
				continue;
			}
			if (line.startsWith('|error|')) {
				this.opts.note?.(`server: ${line.slice(7)}`);
				// An invalid choice: answer the same request again with a safe legal choice.
				if (/\[Invalid choice\]|\[Unavailable choice\]/.test(line)) { this.request ??= this.lastRequest; this.fallback(); }
				continue;
			}
			this.lines.push(line);
			if (line.startsWith('|turn|')) this.turnSeen = Number(line.slice(6));
			if (line.startsWith('|win|')) { this.ended = true; this.winner = line.slice(5); }
			if (line === '|tie') this.ended = true;
		}
		void this.maybeAct();
	}

	/** What earlier games revealed about this opponent (before the first move of this game). */
	setKnowledge(k: TeamKnowledge | undefined) { if (!this.model) this.opts.knowledge = k; }

	/** What this game revealed about the opponent (for the next game of the set). */
	knowledge(): TeamKnowledge {
		if (!this.model || !this.me) return {};
		return knowledgeFromState(this.model.state, this.me === 'p1' ? 'p2' : 'p1');
	}

	private async maybeAct() {
		const req = this.request;
		if (!req || req.wait || this.deciding || this.ended) return;
		if (req.teamPreview) return this.teamPreview(req);
		if (req.forceSwitch) return this.forceSwitch(req);
		// A move request arrives just before the log of the turn it's for: wait for "|turn|N".
		if (req.active && this.turnSeen > this.decidedTurn) {
			this.decidedTurn = this.turnSeen;
			this.deciding = true;
			try { await this.move(req); } finally { this.deciding = false; }
		}
	}

	private choose(choice: string) {
		const rqid = this.request?.rqid;
		this.lastRequest = this.request;
		this.request = undefined;
		this.opts.send(`/choose ${choice}${rqid !== undefined ? `|${rqid}` : ''}`);
	}

	private setFor(p: RequestPokemon): PokemonSet | undefined {
		const name = toID(p.ident.slice(p.ident.indexOf(':') + 1));
		const species = toID(speciesOf(p.details));
		return this.opts.team.find(s => toID(s.name) === name) ?? this.opts.team.find(s => toID(s.species) === species);
	}

	private teamPreview(req: NonNullable<BattleSession['request']>) {
		this.me = req.side.id;
		const party = req.side.pokemon;
		let picks: number[] = [];
		if (this.opts.bring?.length === 4) {
			for (const want of this.opts.bring) {
				const i = party.findIndex((p, idx) => !picks.includes(idx + 1) && [toID(p.ident.slice(4)), toID(speciesOf(p.details)), toID(this.setFor(p)?.species ?? '')].includes(toID(want)));
				if (i >= 0) picks.push(i + 1);
			}
		}
		if (picks.length !== 4) {
			const options = enumerateChoices(req, { foeAlive: [true, true], selfAlive: [true, true] });
			const pick = options[Math.floor(this.rng() * options.length)]!;
			picks = pick.slice(5).split('').map(Number);
		}
		this.opts.note?.(`bringing ${picks.map(i => speciesOf(party[i - 1]!.details)).join(', ')} (leads ${speciesOf(party[picks[0]! - 1]!.details)} + ${speciesOf(party[picks[1]! - 1]!.details)})`);
		this.choose(`team ${picks.join('')}`);
	}

	private targetContext(): TargetContext {
		const state = this.ensureModel()?.state;
		const alive = (side: SideId | undefined) => [0, 1].map(slot => {
			if (!state || !side) return true;
			const ident = state.sides[side].active[slot];
			const mon = state.sides[side].pokemon.find(p => p.ident === ident);
			return !!mon && !mon.fainted;
		});
		const them = this.me === 'p1' ? 'p2' : 'p1';
		return { foeAlive: alive(them), selfAlive: alive(this.me) };
	}

	/** Forced switch: bring in the healthiest Pokémon available. */
	private forceSwitch(req: NonNullable<BattleSession['request']>) {
		const options = enumerateChoices(req, this.targetContext());
		const hp = (i: number) => {
			const c = req.side.pokemon[i - 1]?.condition ?? '0';
			const [cur, max] = c.split(' ')[0]!.split('/').map(Number);
			return max ? cur! / max : 0;
		};
		const score = (choice: string) => [...choice.matchAll(/switch (\d)/g)].reduce((s, m) => s + hp(Number(m[1])), 0);
		const best = options.sort((a, b) => score(b) - score(a))[0];
		if (best) this.choose(best);
	}

	private ensureModel(): OpponentModel | undefined {
		const req = this.request;
		if (!this.model) {
			if (!req || !this.me) return undefined;
			const them: SideId = this.me === 'p1' ? 'p2' : 'p1';
			// Right after team preview the party is in the order we brought it.
			const ownOrder = req.side.pokemon.slice(0, 4).map(p => this.setFor(p)?.species ?? speciesOf(p.details));
			this.model = new OpponentModel({
				side: them, ownTeam: this.opts.team, ownOrder, knowledge: this.opts.knowledge,
				megaStones: this.opts.megaStones, prior: this.opts.prior, seed: this.opts.seed,
			});
		}
		for (; this.fed < this.lines.length; this.fed++) this.model.feed(this.lines[this.fed]!);
		return this.model;
	}

	private async move(req: NonNullable<BattleSession['request']>) {
		this.me ??= req.side.id;
		const model = this.ensureModel();
		const legal = enumerateChoices(req, this.targetContext());
		if (!model || !legal.length) return this.fallback();
		// The four we brought, in their current party order; our real actives (whatever disguise the log shows).
		const myTeam = req.side.pokemon.slice(0, 4).map(p => this.setFor(p)).filter((s): s is PokemonSet => !!s);
		const ownZoroark = req.side.pokemon.filter(p => p.active).map((p, slot) => ({ slot, isZoroark: /^Zoroark/.test(speciesOf(p.details)) }));
		const input = { state: model.state, me: this.me!, myTeam, model, ownZoroark, options: { seed: Math.floor(this.rng() * 1e6), ...this.opts.solve } };
		let res: SolveResult;
		try {
			res = this.opts.pool ? await solveTurnParallel(input, this.opts.pool) : solveTurn(input);
		} catch (e) {
			this.opts.note?.(`search failed (${(e as Error).message}); playing a legal move`);
			return this.fallback();
		}
		this.timings.push(res.ms);
		// Play the recommended mix: draw from it.
		let r = this.rng();
		const pick = res.options.find(o => (r -= o.p) <= 0) ?? res.options[0]!;
		const choice = this.toServer(res, pick.choice, req);
		this.opts.note?.(`turn ${this.turnSeen}: ${pick.label} (${(100 * pick.p).toFixed(0)}% of the mix; expects ${res.value.toFixed(2)}, ${(res.ms / 1000).toFixed(1)} s)`);
		this.choose(legal.includes(choice) ? choice : this.safest(legal));
	}

	/** Rewrite "switch N" from the rebuilt battle's team order to the server's party order. */
	private toServer(res: SolveResult, choice: string, req: NonNullable<BattleSession['request']>): string {
		const side = res.reference.sides[this.me === 'p1' ? 0 : 1]!;
		return choice.replace(/switch (\d)/g, (m, n: string) => {
			const set = side.pokemon[Number(n) - 1]?.set;
			const i = req.side.pokemon.findIndex(p => this.setFor(p) === set || (set && toID(p.ident.slice(4)) === toID(set.name)));
			return i >= 0 ? `switch ${i + 1}` : m;
		});
	}

	private safest(legal: string[]): string {
		return legal.find(c => !c.includes('switch')) ?? legal[0]!;
	}

	private fallback() {
		const req = this.request;
		if (!req) return;
		const legal = enumerateChoices(req, this.targetContext());
		if (legal.length) this.choose(legal[Math.floor(this.rng() * legal.length)]!);
	}

	/** Readable form of a choice (for logs), from the last search. */
	static describe(res: SolveResult, me: 0 | 1, choice: string) {
		return describeChoice(res.reference, me, choice);
	}
}
