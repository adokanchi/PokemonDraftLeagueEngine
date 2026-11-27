/**
 * Turns a battle log into damage observations, one per hit, each with what the damage formula
 * needs to explain it (see HitSpec): the state just before the hit, which hit of a multi-hit move
 * it was, a crit on that hit, an item the hit used up (resist berry, Focus Sash), and whether the
 * hit could have done more than it shows (a KO, Focus Sash, Sturdy, Endure, False Swipe).
 *
 * Observations are released at the end of each turn, once it is known who moved after each hit
 * (Payback, Analytic, Bolt Beak depend on it).
 *
 * Use alongside a BattleLogParser: call `before(line)` before the parser reads a line, `after()` after.
 */
import { toID } from '../showdown.js';
import type { KnownBattleState, MonState, SideId } from '../state/types.js';
import type { HitSpec } from './damage.js';

export interface HitObservation extends HitSpec {
	/** HP lost, as shown: exact HP for the side whose HP we know exactly, else percentage points. */
	lost: number;
	exact: boolean;
	/** HP before the hit, as shown. */
	before: number;
	/** The hit could have done more than it shows (KO, Focus Sash, Sturdy, Endure, False Swipe). */
	atLeast: boolean;
}

/** Parts of a protocol line: command, plain arguments, and [tags]. */
function split(line: string) {
	const parts = line.slice(1).split('|');
	const args: string[] = [];
	const tags: Record<string, string> = {};
	for (const a of parts.slice(1)) {
		const m = /^\[(\w+)\]\s?(.*)$/.exec(a);
		if (m) tags[m[1]!] = m[2] ?? '';
		else args.push(a);
	}
	return { cmd: parts[0] ?? '', args, tags };
}

const CAPS = new Set(['focussash', 'focusband']);
const CAPPING = /ability: Sturdy|move: Endure/;
/** The hit was absorbed by a disguise: the damage shown says nothing about the move. */
const NO_INFO = /ability: (Disguise|Ice Face)/;

export class HitRecorder {
	private cur?: {
		user: string; side: SideId; move: string; spread: boolean;
		hitsOn: Map<string, number>; crits: Set<string>; used: Record<string, string>; capped: Set<string>; noInfo: Set<string>;
		lucky?: boolean;
	};
	private lineNo = 0;
	private turnObs: { obs: HitObservation; lineNo: number }[] = [];
	private turnMoves: { lineNo: number; ident: string }[] = [];
	private turnHits: { by: string; on: string }[] = [];
	private turnLowered = new Set<string>();

	constructor(private readonly getState: () => KnownBattleState, private readonly emit: (o: HitObservation) => void) {}

	private monAt(pos: string | undefined): MonState | undefined {
		const m = /^(p[12])([ab]): /.exec(pos ?? '');
		if (!m) return undefined;
		const side = this.getState().sides[m[1] as SideId];
		const ident = side.active['ab'.indexOf(m[2]!)];
		return side.pokemon.find(p => p.ident === ident);
	}

	/** Call before the parser reads `line`. */
	before(line: string) {
		this.lineNo++;
		if (!line.startsWith('|')) return;
		const { cmd, args, tags } = split(line);
		switch (cmd) {
		case 'move': {
			const user = this.monAt(args[0]);
			if (!user) { this.cur = undefined; break; }
			const from = tags.from ?? '';
			// A move called by another of the user's moves (Metronome, Sleep Talk) is what hits.
			if (!/^(ability|item):/i.test(from) && !from) this.turnMoves.push({ lineNo: this.lineNo, ident: user.ident });
			this.cur = {
				user: user.ident, side: user.side, move: args[1] ?? '', spread: tags.spread !== undefined,
				hitsOn: new Map(), crits: new Set(), used: {}, capped: new Set(), noInfo: new Set(),
			};
			break;
		}
		case 'cant': case 'upkeep': case 'turn': case 'win': case 'tie':
			this.cur = undefined;
			if (cmd !== 'cant') this.flush();
			if (cmd === 'turn') { this.turnMoves = []; this.turnHits = []; this.turnLowered.clear(); this.turnObs = []; }
			break;
		case '-crit': {
			const t = this.monAt(args[0]);
			if (t && this.cur) this.cur.crits.add(t.ident);
			break;
		}
		case '-enditem': {
			// An item used up just before the hit lands (resist berry, Focus Sash); not Knock Off etc. after it.
			const t = this.monAt(args[0]);
			if (!t || !this.cur || t.ident === this.cur.user || /^move:/i.test(tags.from ?? '')) break;
			const id = toID(args[1] ?? '');
			this.cur.used[t.ident] = id;
			if (CAPS.has(id)) this.cur.capped.add(t.ident);
			break;
		}
		case '-activate': case '-ability': {
			const t = this.monAt(args[0]);
			if (!t || !this.cur) break;
			const what = cmd === '-ability' ? `ability: ${args[1] ?? ''}` : (args[1] ?? '');
			if (t.ident === this.cur.user && /move: Fickle Beam/.test(what)) this.cur.lucky = true;
			if (CAPPING.test(what)) this.cur.capped.add(t.ident);
			if (NO_INFO.test(what)) this.cur.noInfo.add(t.ident);
			break;
		}
		case '-unboost': {
			const t = this.monAt(args[0]);
			if (t) this.turnLowered.add(t.ident);
			break;
		}
		case '-damage': {
			if (tags.from !== undefined || !this.cur) break;
			const t = this.monAt(args[0]);
			if (!t || t.ident === this.cur.user) break;
			const c = this.cur;
			const hit = (c.hitsOn.get(t.ident) ?? 0) + 1;
			c.hitsOn.set(t.ident, hit);
			const state = this.getState();
			const hpText = (args[1] ?? '').split(' ')[0] ?? '';
			const after = hpText === '0' || / fnt/.test(args[1] ?? '') ? 0 : Number(hpText.split('/')[0]);
			const exact = state.perspective === t.side && t.maxHp !== 100;
			const noInfo = c.noInfo.has(t.ident);
			if (!noInfo && Number.isFinite(after)) {
				const falseSwipe = ['falseswipe', 'holdback'].includes(toID(c.move)) && (exact ? after === 1 : after <= 1);
				const obs: HitObservation = {
					state: structuredClone(state), attacker: c.user, defender: t.ident, move: c.move,
					crit: c.crits.has(t.ident), spread: c.spread, hit, lucky: c.lucky,
					itemsBefore: { ...c.used }, earlierHits: [...this.turnHits], loweredThisTurn: [...this.turnLowered],
					lost: t.hp - after, exact, before: t.hp, atLeast: after === 0 || c.capped.has(t.ident) || falseSwipe,
				};
				this.turnObs.push({ obs, lineNo: this.lineNo });
			}
			this.turnHits.push({ by: c.user, on: t.ident });
			c.crits.delete(t.ident);
			delete c.used[t.ident];
			c.capped.delete(t.ident);
			c.noInfo.delete(t.ident);
			break;
		}
		}
	}

	/** Release this turn's observations, now that the order of moves is known (also call at the end of a log). */
	flush() {
		for (const { obs, lineNo } of this.turnObs) {
			obs.yetToMove = [...new Set(this.turnMoves.filter(m => m.lineNo > lineNo).map(m => m.ident))];
			this.emit(obs);
		}
		this.turnObs = [];
	}
}

/** Moves whose damage depends on things the log doesn't show (or that ignore the formula). */
const UNMODELLED = new Set(['beatup', 'fling', 'naturalgift', 'spitup', 'echoedvoice', 'round', 'furycutter', 'rollout', 'iceball',
	'fusionflare', 'fusionbolt', 'firepledge', 'grasspledge', 'waterpledge', 'present', 'magnitude', 'triplearrows']);

/** Why an observation can't be scored with the damage formula (or undefined if it can). */
export function skipReason(o: HitObservation, format: { dex: { moves: { get(id: string): { exists: boolean; category: string; damageCallback?: unknown; ohko?: unknown } } } }): string | undefined {
	const move = format.dex.moves.get(o.move);
	if (!move.exists || move.category === 'Status') return 'not a damaging move';
	if (move.damageCallback || move.ohko) return 'fixed damage';
	if (UNMODELLED.has(toID(o.move))) return 'damage depends on unlogged state';
	const find = (ident: string) => o.state.sides[ident.slice(0, 2) as SideId].pokemon.find(p => p.ident === ident);
	if (find(o.attacker)?.transformedInto || find(o.defender)?.transformedInto) return 'transformed';
	return undefined;
}

/** Is the observed hit consistent with this damage range? */
export function fits(o: HitObservation, r: { min: number; max: number; maxHp: number; immune: boolean }): boolean {
	if (r.immune) return false;
	// Percentages are floor(100 × HP / max HP) before and after, so a loss is within ±1 point.
	const scale = o.exact ? 1 : 100 / r.maxHp;
	const slack = o.exact ? 0 : 1.01;
	const lo = r.min * scale - slack, hi = r.max * scale + slack;
	return o.atLeast ? hi >= o.lost : o.lost >= lo && o.lost <= hi;
}
