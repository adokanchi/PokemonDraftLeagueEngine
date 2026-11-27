/**
 * A minimal Pokémon Showdown client for the engine: logs in, accepts challenges in the league's
 * format (single games or Bo3), and plays each battle with a BattleSession. Knowledge about an
 * opponent carries over between the games of a Bo3 (and later sets against the same name).
 */
import { Teams, toID, type PokemonSet } from '../showdown.js';
import { mergeKnowledge, type TeamKnowledge } from '../state/knowledge.js';
import type { SetPrior } from '../data/priors.js';
import type { SearchPool } from '../engine/pool.js';
import type { SolveOptions } from '../engine/solver.js';
import { BattleSession } from './session.js';

export interface ClientOptions {
	/** "localhost:8000" or a full ws:// URL. */
	server: string;
	name: string;
	team: PokemonSet[];
	/** Formats to accept (ids; anything starting with one of these, e.g. Bo3 variants). */
	formats: string[];
	bring?: string[];
	megaStones?: Record<string, string>;
	prior?: SetPrior;
	solve?: SolveOptions;
	pool?: SearchPool;
	/** Challenge this user once logged in (instead of waiting to be challenged). */
	challenge?: string;
	log?: (text: string) => void;
}

export class PracticeClient {
	private ws?: WebSocket;
	private sessions = new Map<string, BattleSession>();
	private opponentOf = new Map<string, string>();
	/** What each opponent (by user id) has revealed so far. */
	private knowledge = new Map<string, TeamKnowledge>();
	private loggedIn = false;
	private games = 0;
	readonly results: { room: string; opponent: string; won: boolean | null }[] = [];

	constructor(private readonly opts: ClientOptions) {}

	private log(text: string) { (this.opts.log ?? console.log)(text); }

	connect(): Promise<void> {
		const url = this.opts.server.startsWith('ws') ? this.opts.server : `ws://${this.opts.server}/showdown/websocket`;
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			this.ws = ws;
			ws.onerror = () => reject(new Error(`Can't connect to ${url}. Is the server running (npm run server)?`));
			ws.onmessage = ev => this.onMessage(String(ev.data), resolve);
			ws.onclose = () => this.log('disconnected');
		});
	}

	close() { this.ws?.close(); }

	private send(text: string) { this.ws?.send(text); }

	private onMessage(data: string, ready: () => void) {
		let room = '';
		let lines = data.split('\n');
		if (lines[0]!.startsWith('>')) { room = lines[0]!.slice(1); lines = lines.slice(1); }
		if (room.startsWith('battle-')) return this.onBattle(room, lines);
		for (const line of lines) {
			const parts = line.split('|');
			switch (parts[1]) {
			case 'challstr':
				// Local server started with --no-security: guest names need no password.
				this.send(`|/trn ${this.opts.name},0,`);
				break;
			case 'updateuser':
				if (!this.loggedIn && toID(parts[2] ?? '') === toID(this.opts.name)) {
					this.loggedIn = true;
					this.log(`logged in as ${this.opts.name}`);
					if (this.opts.challenge) {
						this.send(`|/utm ${Teams.pack(this.opts.team)}`);
						this.send(`|/challenge ${this.opts.challenge}, ${this.opts.formats[0]}`);
					}
					ready();
				}
				break;
			case 'updatechallenges': {
				// (Older servers list incoming challenges here.)
				const info = JSON.parse(parts.slice(2).join('|')) as { challengesFrom: Record<string, string> };
				for (const [user, format] of Object.entries(info.challengesFrom ?? {})) this.onChallenge(user, format);
				break;
			}
			case 'pm': {
				// "|pm| Tester| EngineBot|/challenge gen9championsvgc2026regmc|..." (an empty format = withdrawn)
				const from = toID(parts[2] ?? '');
				const text = parts[4] ?? '';
				if (from !== toID(this.opts.name) && text.startsWith('/challenge ') && text.length > 11) this.onChallenge(from, text.slice(11).trim());
				break;
			}
			case 'c': {
				// Bo3: "Are you ready for game N?" — say yes.
				const ready = /value="\/msgroom ([\w-]+),\/confirmready"/.exec(line);
				if (ready && /I'm ready!<\/button>/.test(line) && !/disabled/.test(line)) this.send(`|/msgroom ${ready[1]},/confirmready`);
				break;
			}
			case 'popup':
				this.log(`server: ${parts.slice(2).join('|').replace(/\|\|/g, '\n')}`);
				break;
			}
		}
	}

	private onChallenge(user: string, format: string) {
		if (this.opts.formats.some(f => toID(format).startsWith(f))) {
			this.log(`accepting ${format} from ${user}`);
			this.send(`|/utm ${Teams.pack(this.opts.team)}`);
			this.send(`|/accept ${user}`);
		} else {
			this.log(`rejecting ${format} from ${user} (I play ${this.opts.formats[0]})`);
			this.send(`|/reject ${user}`);
		}
	}

	private onBattle(room: string, lines: string[]) {
		let session = this.sessions.get(room);
		if (!session && lines.some(l => l === '|init|battle')) {
			const send = (cmd: string) => this.send(`${room}|${cmd}`);
			session = new BattleSession({
				room, team: this.opts.team, bring: this.opts.bring, megaStones: this.opts.megaStones, prior: this.opts.prior,
				solve: this.opts.solve, pool: this.opts.pool, seed: ++this.games, send,
				note: t => this.log(`[${room}] ${t}`),
			});
			this.sessions.set(room, session);
		}
		if (!session) return;
		for (const l of lines) {
			const p = /^\|player\|(p[12])\|([^|]+)/.exec(l);
			if (p && toID(p[2]!) !== toID(this.opts.name)) {
				const opp = toID(p[2]!);
				this.opponentOf.set(room, opp);
				// What earlier games against this opponent revealed (sets are locked for the whole Bo3).
				const known = this.knowledge.get(opp);
				session.setKnowledge(known);
				if (known && Object.keys(known).length) {
					const facts = Object.values(known).reduce((n, k) => n + k.moves.length + (k.item ? 1 : 0) + (k.ability ? 1 : 0), 0);
					this.log(`[${room}] remembering ${facts} facts about ${opp}'s team from earlier games`);
				}
			}
		}
		const wasEnded = session.ended;
		session.receive(lines);
		if (session.ended && !wasEnded) {
			const opp = this.opponentOf.get(room) ?? '?';
			this.knowledge.set(opp, mergeKnowledge(this.knowledge.get(opp) ?? {}, session.knowledge()));
			const won = session.winner ? toID(session.winner) === toID(this.opts.name) : null;
			this.results.push({ room, opponent: opp, won });
			this.log(`[${room}] ${won === null ? 'tie' : won ? 'won' : 'lost'} against ${opp}`);
			this.send(`|/leave ${room}`);
		}
		if (lines.includes('|deinit')) this.sessions.delete(room);
	}
}
