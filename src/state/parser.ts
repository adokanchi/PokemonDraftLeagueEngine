/**
 * Builds a KnownBattleState from a Showdown battle log (protocol lines).
 *
 * Accepts spectator logs (replays), player logs, and omniscient simulator logs with `|split|`
 * sections (pass `perspective` to keep that player's private lines). Protocol reference:
 * vendor/pokemon-showdown/sim/SIM-PROTOCOL.md.
 */
import { toID } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';
import type { BoostId, KnownBattleState, MonState, SideId, SideState } from './types.js';

const BOOSTS: BoostId[] = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
const ITEM_SWAP_MOVES = new Set(['trick', 'switcheroo', 'thief', 'covet', 'bestow', 'fling']);
const TERRAINS = new Set(['electricterrain', 'grassyterrain', 'mistyterrain', 'psychicterrain']);
/** Lines that mean the current move did nothing to a target. */
const FAILURE_LINES = new Set(['-fail', '-miss', '-immune', '-notarget', '-block']);
const ENDING_LINES = new Set(['-end', '-sideend', '-fieldend']);
/** Abilities that take a move in instead of being hit by it (the move fails, as in Showdown). */
const ABSORBING = new Set(['lightningrod', 'stormdrain', 'sapsipper', 'motordrive', 'wellbakedbody', 'windrider', 'flashfire',
	'voltabsorb', 'waterabsorb', 'dryskin', 'eartheater', 'telepathy']);
/** Lines that mean the current move did something. (Protect blocking is neither, as in Showdown.) */
const EFFECT_LINES = new Set(['-damage', '-heal', '-sethp', '-status', '-curestatus', '-cureteam', '-boost', '-unboost', '-setboost',
	'-clearboost', '-clearpositiveboost', '-clearnegativeboost', '-clearallboost', '-invertboost', '-copyboost', '-swapboost',
	'-weather', '-fieldstart', '-fieldend', '-sidestart', '-sideend', '-swapsideconditions', '-start', '-end', '-item', '-enditem',
	'-transform', '-singleturn', '-singlemove', '-formechange', '-clearnegativeboost', 'swap']);

/** Reveals the parser attributes to a Pokémon, as they happen (for belief tracking). */
export type ParserEvent =
	| { type: 'ability'; mon: MonState; ability: string }
	| { type: 'item'; mon: MonState; item: string; how: 'held' | 'lost' }
	| { type: 'move'; mon: MonState; move: string };

export interface ParseOptions {
	/** Called whenever an ability/item/move is revealed for a Pokémon (repeats included). */
	onEvent?: (e: ParserEvent) => void;
	/** Keep this player's private `|split|` lines (their exact HP etc.). */
	perspective?: SideId;
	/** Stop when this turn starts (state = what you know when choosing your turn-N move). */
	stopAtTurn?: number;
	format?: ResolvedFormat;
}

interface Tags {
	from?: string;
	of?: string;
	flags: Set<string>;
	/** Other "[key] value" tags, e.g. "[ability] Iron Fist". */
	values: Record<string, string>;
}

function splitTags(args: string[]): { args: string[]; tags: Tags } {
	const plain: string[] = [];
	const tags: Tags = { flags: new Set(), values: {} };
	for (const a of args) {
		const m = /^\[(\w+)\]\s?(.*)$/.exec(a);
		if (!m) { plain.push(a); continue; }
		const [, key, val] = m;
		if (key === 'from') tags.from = val;
		else if (key === 'of') tags.of = val;
		else { tags.flags.add(key!); if (val) tags.values[key!] = val; }
	}
	return { args: plain, tags };
}

/** "ability: Rough Skin" -> { kind: 'ability', name: 'Rough Skin' } */
function effectOf(s: string | undefined): { kind: string; name: string } | undefined {
	if (!s) return undefined;
	const m = /^(ability|item|move): ?(.*)$/i.exec(s.trim());
	if (m) return { kind: m[1]!.toLowerCase(), name: m[2]!.trim() };
	return { kind: 'other', name: s.trim() };
}

function mergeMoves(a: MonState['moves'], b: MonState['moves']): MonState['moves'] {
	const out: MonState['moves'] = structuredClone(a);
	for (const [id, m] of Object.entries(b)) (out[id] ??= { uses: 0 }).uses += m.uses;
	return out;
}

export class BattleLogParser {
	readonly state: KnownBattleState;
	private readonly format: ResolvedFormat;
	private readonly perspective?: SideId;
	private skipNext = 0;
	private pendingSplit: SideId | null = null;
	private snapshots: Record<SideId, ({ before: MonState | null } | undefined)[]> = { p1: [], p2: [] };
	/** Boosts/volatiles waiting to be Baton Passed into a slot. */
	private batonPass: Record<SideId, ({ boosts: MonState['boosts']; volatiles: MonState['volatiles'] } | undefined)[]> = { p1: [], p2: [] };
	/** "Bug Bite/Pluck ate the target's berry": the eater's next "[from] item: X" isn't its own item. */
	private stolenBerry?: { mon: MonState; item: string };
	/** The move being executed right now (for hits taken, failure, Outrage-style locks, trapping). */
	private cur?: {
		user: MonState; id: string; succeeded: boolean; failed: boolean; fatigue: boolean; locked: boolean;
		/** Pokémon the move reached. */
		targets: Set<MonState>;
		/** Targets whose ability took the move instead (Lightning Rod, Sap Sipper...): their boosts aren't the move working. */
		absorbed: Set<MonState>;
		bounced?: boolean;
		/** Hits landed on each Pokémon. */
		hits: Map<MonState, number>;
		/** The Pokémon whose ability is announcing stat changes right now. */
		abilityBoosting?: MonState;
	};
	done = false;

	constructor(private opts: ParseOptions = {}) {
		this.format = opts.format ?? resolveFormat();
		this.perspective = opts.perspective;
		const side = (id: SideId): SideState => ({
			id, name: '', preview: [], pokemon: [], active: [null, null], conditions: {}, megaUsed: false,
		});
		this.state = {
			perspective: opts.perspective,
			gameType: 'doubles',
			turn: 0,
			sides: { p1: side('p1'), p2: side('p2') },
			field: { pseudoWeather: {} },
			ended: false,
		};
	}

	feedLog(text: string): this {
		for (const line of text.split('\n')) {
			if (this.done) break;
			this.feed(line);
		}
		return this;
	}

	feed(rawLine: string): void {
		const line = rawLine.replace(/\r$/, '');
		// |split|p1 is followed by a private line (that player + omniscient) and a public line.
		if (this.pendingSplit) {
			const side = this.pendingSplit;
			this.pendingSplit = null;
			if (this.perspective === side) { this.skipNext = 1; this.handle(line); } else { this.skipNext = 0; }
			return;
		}
		if (this.skipNext > 0) { this.skipNext--; return; }
		if (line.startsWith('|split|')) { this.pendingSplit = line.slice(7) as SideId; return; }
		if (line.startsWith('|')) this.handle(line);
	}

	// ---- identity helpers ----------------------------------------------------------------------

	private sideOf(id: string): SideState {
		return this.state.sides[id.slice(0, 2) as SideId];
	}

	/** "p1a: Nick" -> { side, slot, ident: "p1: Nick" } */
	private parsePosition(s: string): { side: SideId; slot: number | null; ident: string; name: string } {
		const m = /^(p[12])([a-c]?): ?(.*)$/.exec(s.trim());
		if (!m) throw new Error(`Bad Pokémon identifier: ${s}`);
		const side = m[1] as SideId;
		const slot = m[2] ? 'abc'.indexOf(m[2]) : null;
		return { side, slot, ident: `${side}: ${m[3]}`, name: m[3]! };
	}

	private parseDetails(details: string) {
		const parts = details.split(', ');
		const species = parts[0]!;
		let level = 100;
		let gender = '';
		for (const p of parts.slice(1)) {
			if (/^L\d+$/.test(p)) level = Number(p.slice(1));
			else if (p === 'M' || p === 'F') gender = p;
		}
		return { species, level, gender };
	}

	private mon(s: string | undefined): MonState | undefined {
		if (!s) return undefined;
		let pos;
		try { pos = this.parsePosition(s); } catch { return undefined; }
		const side = this.state.sides[pos.side];
		// Resolve by position when given: an Illusion user can share a name with its ally.
		if (pos.slot !== null) {
			const here = side.pokemon.find(p => p.ident === side.active[pos.slot!]);
			if (here && here.name === pos.name) return here;
		}
		return side.pokemon.find(p => p.ident === pos.ident);
	}

	private getOrCreate(position: string, details: string): MonState {
		const pos = this.parsePosition(position);
		const side = this.state.sides[pos.side];
		const d = this.parseDetails(details);
		let mon = side.pokemon.find(p => p.ident === pos.ident);
		if (!mon) {
			// A Pokémon pre-loaded from our own team sheet may be keyed by species, not nickname.
			mon = side.pokemon.find(p => !p.seen && (p.teamSpecies === d.species || p.species === d.species) && p.ident.endsWith(`: ${p.teamSpecies}`));
			if (mon) { mon.ident = pos.ident; mon.name = pos.name; }
		}
		if (!mon) {
			mon = {
				ident: pos.ident, side: pos.side, name: pos.name,
				species: d.species, teamSpecies: d.species, level: d.level, gender: d.gender,
				hp: 100, maxHp: 100, status: '', boosts: {}, volatiles: {}, fainted: false,
				activeSlot: null, seen: false, megaEvolved: false, moves: {}, item: { swapped: false },
			};
			side.pokemon.push(mon);
		}
		return mon;
	}

	private setHp(mon: MonState, hpStatus: string | undefined) {
		if (!hpStatus) return;
		const [hpPart, status] = hpStatus.split(' ');
		if (hpPart === '0' || status === 'fnt') {
			mon.hp = 0;
			if (status === 'fnt' || hpPart === '0') mon.fainted = true;
			return;
		}
		// Champions shows opponents' HP as floor(percent) (min 1); at exactly 20 and 50 a letter
		// says which side of the threshold it is (g/y at 50, y/r at 20).
		const m = /^(\d+)(?:\/(\d+)([gyr])?)?$/.exec(hpPart ?? '');
		if (m) {
			mon.hp = Number(m[1]);
			if (m[2]) mon.maxHp = Number(m[2]);
			mon.hpColor = m[3] as MonState['hpColor'];
			if (mon.hp > 0) mon.fainted = false; // e.g. Revival Blessing
		}
		if (status !== undefined && status !== 'fnt') this.setStatus(mon, status);
		else if (status === undefined && mon.status && !mon.fainted) {
			// HP strings always carry the current status; absence means none.
			mon.status = '';
			mon.statusSince = undefined;
		}
	}

	private setStatus(mon: MonState, status: string) {
		if (mon.status !== status) mon.statusSince = this.state.turn;
		mon.status = status as MonState['status'];
	}

	// ---- reveals -------------------------------------------------------------------------------

	private revealAbility(mon: MonState | undefined, ability: string, base = true) {
		if (!mon) return;
		const id = toID(ability);
		this.opts.onEvent?.({ type: 'ability', mon, ability: id });
		mon.ability = id;
		if (base && !mon.baseAbility && !mon.megaEvolved && !mon.transformedInto && !mon.abilityChanged) mon.baseAbility = id;
	}

	private revealItem(mon: MonState | undefined, item: string) {
		if (!mon) return;
		const id = toID(item);
		// "[from] item: Sitrus Berry" right after eating it: already accounted for.
		if (mon.item.current === '' && mon.item.lostItem === id) return;
		if (!mon.item.swapped) this.opts.onEvent?.({ type: 'item', mon, item: id, how: 'held' });
		mon.item.current = id;
		mon.item.lostVia = undefined;
		if (!mon.item.swapped && mon.item.original === undefined) mon.item.original = id;
	}

	private loseItem(mon: MonState | undefined, item: string, via: NonNullable<MonState['item']['lostVia']>) {
		if (!mon) return;
		if (mon.stint && mon.activeSlot !== null) { mon.stint.itemChangedSinceMove = true; mon.stint.itemLost = true; }
		const id = toID(item);
		if (!mon.item.swapped) this.opts.onEvent?.({ type: 'item', mon, item: id, how: 'lost' });
		if (!mon.item.swapped && mon.item.original === undefined) mon.item.original = id;
		mon.item.current = '';
		mon.item.lostVia = via;
		mon.item.lostItem = id;
	}

	private canHaveAbility(mon: MonState | undefined, ability: string): boolean {
		if (!mon) return false;
		const sp = this.format.dex.species.get(mon.species);
		const base = this.format.dex.species.get(mon.teamSpecies);
		const id = toID(ability);
		if (mon.ability === id) return true; // e.g. traced or swapped earlier
		return [sp, base].some(s => Object.values(s.abilities ?? {}).some(a => toID(a as string) === id));
	}

	/**
	 * Attribute a "[from] ability: X" / "[from] item: X" tag. `target` is the Pokémon named in the
	 * message; `[of]` names the other party. Which of them owns the effect depends on the message
	 * type; for abilities we also check which species can actually have it.
	 */
	private attributeFrom(cmd: string, target: MonState | undefined, tags: Tags) {
		const eff = effectOf(tags.from);
		if (!eff || (eff.kind !== 'ability' && eff.kind !== 'item')) return;
		const of = this.mon(tags.of);
		let owner: MonState | undefined;
		if (eff.kind === 'ability') {
			// "[from] ability: X|[of] Y" normally means Y's ability; for -heal (Water Absorb etc.)
			// [of] is the attacker and the ability is the healed Pokémon's.
			// (Hospitality heals an ally "[of] holder", so a same-side [of] owns it.)
			const sameSide = !!of && !!target && of.side === target.side && of !== target;
			owner = cmd === '-heal' && !sameSide ? (target ?? of) : (of ?? target);
			if (owner && !this.canHaveAbility(owner, eff.name)) {
				const other = owner === target ? of : target;
				// Neither can legally have it (e.g. a copied ability): don't guess.
				owner = other && this.canHaveAbility(other, eff.name) ? other : undefined;
			}
			this.revealAbility(owner, eff.name);
		} else {
			if (cmd === '-enditem' || cmd === '-item') return; // handled by the command itself
			// Items: Rocky Helmet etc. damage the attacker "[of] holder"; Life Orb, Leftovers, berries
			// name the holder as the target.
			owner = cmd === '-damage' ? (of ?? target) : (target ?? of);
			if (this.stolenBerry && this.stolenBerry.mon === owner && this.stolenBerry.item === toID(eff.name)) return;
			this.revealItem(owner, eff.name);
		}
	}

	// ---- switching -----------------------------------------------------------------------------

	private switchIn(position: string, details: string, hp: string | undefined) {
		const pos = this.parsePosition(position);
		const side = this.state.sides[pos.side];
		const slot = pos.slot ?? 0;
		const prevIdent = side.active[slot];
		if (prevIdent) {
			const prev = side.pokemon.find(p => p.ident === prevIdent);
			if (prev) this.switchOut(prev);
		}
		const existing = side.pokemon.find(p => p.ident === pos.ident);
		let mon: MonState;
		if (existing && existing.activeSlot !== null && existing.activeSlot !== slot) {
			// The same Pokémon can't be in two slots: this is an Illusion user disguised as its ally.
			mon = this.illusionPlaceholder(pos.side, pos.ident, pos.name, details);
			this.snapshots[pos.side][slot] = { before: null };
		} else {
			// Remember the pre-switch state in case this turns out to be a disguised Illusion user.
			this.snapshots[pos.side][slot] = { before: existing ? structuredClone(existing) : null };
			mon = this.getOrCreate(position, details);
		}
		const d = this.parseDetails(details);
		mon.species = d.species;
		mon.permanentSpecies = d.species;
		mon.level = d.level;
		mon.seen = true;
		mon.activeSlot = slot;
		mon.switchedInTurn = this.state.turn;
		mon.lastMove = undefined;
		mon.lastMoveTurn = undefined;
		mon.stint = { timesAttacked: mon.revivedHits ?? 0, moves: {}, faintedAllies: side.pokemon.filter(p => p.fainted && !p.ident.endsWith('#illusion')).length };
		mon.revivedHits = undefined;
		side.active[slot] = mon.ident;
		this.setHp(mon, hp);
		const passed = this.batonPass[pos.side][slot];
		if (passed) {
			mon.boosts = { ...passed.boosts };
			for (const v of ['substitute', 'confusion', 'leechseed', 'focusenergy', 'curse', 'embargo', 'healblock', 'aquaring', 'ingrain', 'magnetrise', 'perishsong', 'powertrick']) {
				if (passed.volatiles[v]) mon.volatiles[v] = passed.volatiles[v]!;
			}
			this.batonPass[pos.side][slot] = undefined;
		}
	}

	private illusionPlaceholder(side: SideId, ident: string, name: string, details: string): MonState {
		const d = this.parseDetails(details);
		const mon: MonState = {
			ident: `${ident}#illusion`, side, name,
			species: d.species, teamSpecies: d.species, level: d.level, gender: d.gender,
			hp: 100, maxHp: 100, status: '', boosts: {}, volatiles: {}, fainted: false,
			activeSlot: null, seen: false, megaEvolved: false, moves: {}, item: { swapped: false },
			ability: 'illusion', baseAbility: 'illusion',
		};
		this.state.sides[side].pokemon.push(mon);
		return mon;
	}

	/** |replace|: the Pokémon in this slot was an Illusion user. Move what it did onto the real one. */
	private replace(position: string, details: string) {
		const pos = this.parsePosition(position);
		const side = this.state.sides[pos.side];
		const slot = pos.slot ?? 0;
		const shown = side.pokemon.find(p => p.ident === side.active[slot]);
		const d = this.parseDetails(details);
		let real = side.pokemon.find(p => p.ident === pos.ident && p !== shown);
		const otherPlaceholder = side.pokemon.find(p => p !== shown && p.ident === `${shown?.ident}#illusion`);
		if (shown && otherPlaceholder) {
			// Two Pokémon with the same name were out and we guessed the wrong one was the disguise:
			// the placeholder is the real one, and the Pokémon in this slot is the Illusion user.
			otherPlaceholder.ident = shown.ident;
			otherPlaceholder.ability = undefined;
			otherPlaceholder.baseAbility = undefined;
			shown.ident = `${shown.ident}#illusion`;
			if (otherPlaceholder.activeSlot !== null) side.active[otherPlaceholder.activeSlot] = otherPlaceholder.ident;
			side.active[slot] = shown.ident;
		}
		if (shown?.ident.endsWith('#illusion')) {
			// Placeholder created when the disguise was detected: it becomes the real Pokémon.
			if (real) side.pokemon.splice(side.pokemon.indexOf(real), 1), Object.assign(shown, { moves: mergeMoves(real.moves, shown.moves), item: real.item });
			real = shown;
			real.ident = pos.ident;
			real.name = pos.name;
		} else {
			real ??= this.getOrCreate(position, details);
			if (shown && shown !== real) {
				const snap = this.snapshots[pos.side][slot]?.before;
				real.hp = shown.hp; real.maxHp = shown.maxHp; real.hpColor = shown.hpColor;
				real.status = shown.status; real.statusSince = shown.statusSince;
				real.boosts = shown.boosts; real.volatiles = shown.volatiles;
				real.stint = shown.stint; real.switchedInTurn = shown.switchedInTurn;
				real.lastMove = shown.lastMove; real.lastMoveTurn = shown.lastMoveTurn;
				for (const [id, m] of Object.entries(shown.moves)) {
					const delta = m.uses - (snap?.moves[id]?.uses ?? 0);
					if (delta > 0 || !snap?.moves[id]) (real.moves[id] ??= { uses: 0 }).uses += Math.max(0, delta);
				}
				if (snap) Object.assign(shown, snap, { activeSlot: null });
				else side.pokemon.splice(side.pokemon.indexOf(shown), 1);
			}
		}
		real.species = d.species;
		real.teamSpecies = real.megaEvolved ? real.teamSpecies : d.species;
		real.level = d.level;
		real.seen = true;
		real.activeSlot = slot;
		real.ability = 'illusion';
		real.baseAbility ??= 'illusion';
		side.active[slot] = real.ident;
	}

	private switchOut(mon: MonState) {
		this.releaseTrapsBy(mon);
		mon.activeSlot = null;
		// Temporary formes (Stance Change, Hunger Switch, Transform...) revert on switching out.
		mon.transformedInto = undefined;
		if (mon.permanentSpecies) mon.species = mon.permanentSpecies;
		mon.boosts = {};
		mon.volatiles = {};
		if (mon.status === 'tox') mon.statusSince = undefined;
		// A changed ability (Trace, Mummy, Skill Swap...) reverts when it leaves the field.
		if (mon.abilityChanged) { mon.ability = mon.baseAbility; mon.abilityChanged = false; mon.abilityFrom = undefined; }
	}

	/** Mean Look / Block / Spirit Shackle trapping ends when the trapper leaves the field. */
	private releaseTrapsBy(mon: MonState) {
		for (const s of Object.values(this.state.sides)) {
			for (const p of s.pokemon) if (p.volatiles.trapped?.source === mon.ident) delete p.volatiles.trapped;
		}
	}

	/** Finish bookkeeping for the move that just ran: did it fail, does an Outrage-style lock go on? */
	private endMove() {
		const c = this.cur;
		if (!c) return;
		this.cur = undefined;
		// (Showdown keeps only the result of a Pokémon's latest move this turn.)
		if ((c.failed && !c.succeeded) || c.bounced) c.user.failedTurn = this.state.turn;
		else if (c.user.failedTurn === this.state.turn) c.user.failedTurn = undefined;
		if (c.locked) {
			const lock = c.user.volatiles.lockedmove;
			if (c.succeeded && !c.fatigue) {
				c.user.volatiles.lockedmove = { since: lock?.since ?? this.state.turn, move: c.id, count: (lock?.count ?? 0) + 1 };
			} else {
				delete c.user.volatiles.lockedmove;
			}
		}
	}

	private activeAt(side: SideId, slot: number): MonState | undefined {
		const ident = this.state.sides[side].active[slot];
		return ident ? this.state.sides[side].pokemon.find(p => p.ident === ident) : undefined;
	}

	private typesOf(mon: MonState | undefined): string[] | undefined {
		if (!mon) return undefined;
		return mon.volatiles.typechange?.types ?? [...this.format.dex.species.get(mon.species).types];
	}

	/** Something happened to a Pokémon during the current move: it worked on at least one target. */
	private moveDidSomething(target: MonState | undefined) {
		if (this.cur && target && target !== this.cur.user) this.cur.succeeded = true;
	}

	// ---- main dispatch -------------------------------------------------------------------------

	private handle(line: string) {
		const parts = line.slice(1).split('|');
		const cmd = parts[0] ?? '';
		const { args, tags } = splitTags(parts.slice(1));
		const st = this.state;
		const target = (cmd.startsWith('-') || ['move', 'cant', 'faint', 'detailschange', 'swap'].includes(cmd)) ? this.mon(args[0]) : undefined;

		// What the current move did: hits taken (Rage Fist), and whether it worked at all.
		if (this.cur) {
			// (Psychic Terrain stopping a priority move is a failure; Protect blocking isn't, as in Showdown.)
			const ability = cmd === '-ability' && !tags.from ? toID(args[1] ?? '') : /^ability:/i.test(args[1] ?? '') && ['-activate', '-start'].includes(cmd) ? toID(effectOf(args[1])!.name) : '';
			if (target && target !== this.cur.user && ABSORBING.has(ability) && this.cur.targets.has(target)) {
				this.cur.absorbed.add(target);
				this.cur.failed = true;
			}
			// "-fail|X|heal" at full HP: a failure for Recover or Rest, but not for moves that heal in their own
			// hit handler (Moonlight, Synthesis...), which Showdown counts as having worked.
			const mv = this.format.dex.moves.get(this.cur.id);
			const healStillWorked = cmd === '-fail' && args[1] === 'heal' && !!mv.onHit && !mv.heal && !mv.onTry;
			// A stat change of 0 (Swords Dance at +6) is the move failing.
			const noChange = (cmd === '-boost' || cmd === '-unboost') && args[2] === '0';
			// Boosts announced by an ability (Speed Boost at the end of the turn, Defiant, Justified...) aren't the move working.
			const abilityBoost = (cmd === '-boost' || cmd === '-unboost') && !!target && this.cur.abilityBoosting === target;
			if (cmd === '-ability' && args[2] === 'boost') this.cur.abilityBoosting = target;
			else if (cmd !== '-boost' && cmd !== '-unboost') this.cur.abilityBoosting = undefined;
			if ((FAILURE_LINES.has(cmd) && !healStillWorked) || noChange || (cmd === '-activate' && toID(args[1] ?? '') === 'movepsychicterrain')) this.cur.failed = true;
			else if (abilityBoost) { /* not the move */ }
			// Effects on what the move reached (or on the field), but not Protean/Libero changing the
			// user's type before it can miss, and not end-of-turn effects.
			// Lines with a [from] tag are side effects (Leftovers, Life Orb, Protean...) unless they name this move.
			// Things ending (-end, -sideend, -fieldend, weather fading) are usually end-of-turn expiry: only
			// count them when they name the move (Defog, Brick Break, Rapid Spin).
			else if (EFFECT_LINES.has(cmd) && !tags.flags.has('upkeep') && !tags.flags.has('silent') && !(target && this.cur.absorbed.has(target))
				&& (target ? this.cur.targets.has(target) : !args[0]?.match(/^p[12][ab]?:/))
				&& (tags.from ? toID(effectOf(tags.from)?.name ?? '') === this.cur.id : !ENDING_LINES.has(cmd) && !(cmd === '-weather' && args[0] === 'none'))) this.cur.succeeded = true;
			const hitOnSub = cmd === '-activate' && tags.flags.has('damage') && /substitute/i.test(args[1] ?? '');
			if (target && target !== this.cur.user && ((cmd === '-damage' && !tags.from) || hitOnSub) && target.stint) {
				target.stint.timesAttacked++;
				this.cur.hits.set(target, (this.cur.hits.get(target) ?? 0) + 1);
			}
		}

		switch (cmd) {
		case 'player': {
			if (args[0] && args[1] !== undefined && args[1] !== '') this.sideOf(args[0]).name = args[1];
			break;
		}
		case 'gametype': st.gameType = args[0] ?? st.gameType; break;
		case 'teamsize': if (args[0]) this.sideOf(args[0]).teamSize = Number(args[1]); break;
		case 'clearpoke': st.sides.p1.preview = []; st.sides.p2.preview = []; break;
		case 'poke': if (args[0] && args[1]) this.sideOf(args[0]).preview.push(this.parseDetails(args[1]).species); break;
		case 'turn': {
			this.endMove();
			for (const s of Object.values(st.sides)) {
				for (const p of s.pokemon) for (const [k, v] of Object.entries(p.volatiles)) if (v.singleTurn) delete p.volatiles[k];
			}
			st.turn = Number(args[0]);
			this.batonPass = { p1: [], p2: [] };
			this.stolenBerry = undefined;
			if (this.opts.stopAtTurn !== undefined && st.turn >= this.opts.stopAtTurn) this.done = true;
			break;
		}
		case 'upkeep': {
			this.endMove();
			for (const s of Object.values(st.sides)) {
				for (const p of s.pokemon) {
					// An Outrage-style lock ends if it couldn't move this turn or fell asleep.
					if (p.volatiles.lockedmove && (p.lastMoveTurn !== st.turn || p.status === 'slp')) delete p.volatiles.lockedmove;
				}
			}
			break;
		}
		case 'win': st.ended = true; st.winner = args[0]; break;
		case 'tie': st.ended = true; break;

		case 'switch': case 'drag': {
			if (cmd === 'drag' && args[0]) this.batonPass[args[0].slice(0, 2) as SideId] = [];
			this.switchIn(args[0]!, args[1]!, args[2]);
			// Shed Tail hands its Substitute to the Pokémon coming in.
			if (toID(tags.from ?? '') === 'shedtail') {
				const pos = this.parsePosition(args[0]!);
				const mon = this.activeAt(pos.side, pos.slot ?? 0);
				if (mon) mon.volatiles.substitute = { since: st.turn };
			}
			break;
		}
		case 'replace': {
			this.replace(args[0]!, args[1]!);
			break;
		}
		case 'detailschange': {
			if (target && args[1]) {
				const d = this.parseDetails(args[1]);
				target.species = d.species;
				target.permanentSpecies = d.species;
				// A permanent forme change (Mega Evolution) replaces any copied ability with the new forme's.
				if (target.abilityChanged) {
					const abilities = Object.values(this.format.dex.species.get(d.species).abilities ?? {});
					target.ability = abilities.length === 1 ? toID(abilities[0] as string) : undefined;
					target.abilityChanged = false;
				}
			}
			break;
		}
		case '-formechange': {
			if (target && args[1]) target.species = args[1];
			break;
		}
		case '-mega': {
			if (target) {
				target.megaEvolved = true;
				this.sideOf(args[0]!).megaUsed = true;
				if (args[2]) this.revealItem(target, args[2]);
			}
			break;
		}
		case 'faint': {
			if (target) {
				target.fainted = true;
				target.hp = 0;
				this.sideOf(args[0]!).lastFaintTurn = st.turn;
				// Showdown clears the hit counter on fainting, then counts the hits of the move that KO'd it
				// (what it has if Revival Blessing brings it back).
				target.revivedHits = this.cur?.hits.get(target) ?? 0;
				this.releaseTrapsBy(target);
			}
			break;
		}

		case 'move': {
			const user = target;
			const moveName = args[1] ?? '';
			const from = tags.from ?? '';
			// Moves called by other moves/abilities aren't part of the moveset.
			const called = /^(ability|move|item):/i.test(from) || tags.flags.has('zeffect');
			if (user && toID(moveName) === 'batonpass' && !tags.flags.has('still') && user.activeSlot !== null) {
				this.batonPass[user.side][user.activeSlot] = { boosts: { ...user.boosts }, volatiles: structuredClone(user.volatiles) };
			}
			const bounced = called && /magic bounce|magic coat/i.test(from);
			if (bounced) {
				// Reflected: a failure for the original user; how the reflected move goes counts for the reflector.
				if (this.cur) { this.cur.bounced = true; this.endMove(); }
				if (user) this.cur = { user, id: toID(moveName), succeeded: false, failed: false, fatigue: false, locked: false, targets: new Set([user, ...[this.mon(args[2])].filter(m => !!m) as MonState[]]), absorbed: new Set(), hits: new Map() };
			} else if (called && this.cur) {
				// Called by another move (Metronome, Sleep Talk...): part of the move in progress.
				if (this.cur.user === user) this.cur.targets.add(this.mon(args[2]) ?? user);
			} else {
				this.endMove();
			}
			if (user && !called) for (const [k, v] of Object.entries(user.volatiles)) if (v.singleMove) delete user.volatiles[k];
			if (user && !called && toID(moveName) !== 'struggle') {
				const id = toID(moveName);
				// Releasing a charged move, or continuing an Outrage-style lock, uses no PP.
				const charged = user.volatiles.twoturnmove?.move === id;
				const continuing = user.volatiles.lockedmove?.move === id;
				if (charged) delete user.volatiles.twoturnmove;
				if (!user.transformedInto && !charged && !continuing) {
					user.moves[id] ??= { uses: 0 };
					user.moves[id]!.uses++;
				}
				if (!user.transformedInto) this.opts.onEvent?.({ type: 'move', mon: user, move: id });
				user.lastMove = id;
				user.lastMoveTurn = st.turn;
				if (user.stint) {
					if (!charged && !continuing) user.stint.moves[id] = (user.stint.moves[id] ?? 0) + 1;
					user.stint.itemChangedSinceMove = false;
				}
				const locks = this.format.dex.moves.get(id).self?.volatileStatus === 'lockedmove';
				// Who the move reached: its target, the [spread] list, and the user (residual effects of others don't count).
				const targets = new Set<MonState>([user]);
				const t = this.mon(args[2]);
				if (t) targets.add(t);
				const sideOf = (args[2] ?? '').slice(0, 2) || (user.side === 'p1' ? 'p2' : 'p1');
				for (const slot of (tags.values.spread ?? '').split(',')) {
					const m = /^(p[12])([ab])$/.exec(slot.trim()) ?? (/^[ab]$/.test(slot.trim()) ? [slot, sideOf, slot.trim()] : null);
					const mon = m && this.activeAt(m[1] as SideId, 'ab'.indexOf(m[2]!));
					if (mon) targets.add(mon);
				}
				this.cur = { user, id, succeeded: false, failed: tags.flags.has('notarget') || tags.flags.has('miss'), fatigue: false, locked: locks, targets, absorbed: new Set(), hits: new Map() };
			}
			if (from.toLowerCase().startsWith('ability:')) {
				const eff = effectOf(from)!;
				this.revealAbility(user, eff.name);
			}
			break;
		}
		case 'cant': {
			// "|cant|HOLDER|ability: Queenly Majesty|MOVE|[of] ATTACKER": the move is the attacker's.
			const of = this.mon(tags.of);
			const mover = of ?? target;
			this.endMove();
			// Flinch, paralysis, sleep, Taunt, ...: counts as a failed move (Stomping Tantrum). Recharging doesn't.
			if (mover && !['recharge', 'truant'].includes(toID(args[1] ?? ''))) mover.failedTurn = st.turn;
			if (mover) for (const [k, v] of Object.entries(mover.volatiles)) if (v.singleMove) delete mover.volatiles[k];
			if (mover && args[2] && !mover.transformedInto) {
				const id = toID(args[2]);
				mover.moves[id] ??= { uses: 0 };
			}
			const eff = effectOf(args[1]);
			if (eff?.kind === 'ability') {
				const owner = target && this.canHaveAbility(target, eff.name) ? target :
					of && this.canHaveAbility(of, eff.name) ? of : target;
				this.revealAbility(owner, eff.name);
			}
			break;
		}

		case '-damage': case '-heal': case '-sethp': {
			if (target && cmd === '-damage' && toID(tags.from ?? '') === 'confusion') {
				// Hurt itself in confusion: that was its action, and it failed.
				this.endMove();
				target.failedTurn = st.turn;
			}
			if (target) this.setHp(target, args[1]);
			this.attributeFrom(cmd, target, tags);
			break;
		}
		case '-status': {
			if (target && args[1]) this.setStatus(target, args[1]);
			this.attributeFrom(cmd, target, tags);
			break;
		}
		case '-curestatus': {
			if (target) { target.status = ''; target.statusSince = undefined; }
			else if (args[0]) {
				// Can name a benched Pokémon by ident without position.
				const mon = this.mon(args[0]);
				if (mon) mon.status = '';
			}
			this.attributeFrom(cmd, target, tags);
			break;
		}
		case '-cureteam': {
			if (args[0]) for (const p of this.sideOf(args[0]).pokemon) p.status = '';
			break;
		}

		case '-boost': case '-unboost': {
			if (target && args[1]) {
				const stat = args[1] as BoostId;
				const n = Number(args[2] ?? 0) * (cmd === '-boost' ? 1 : -1);
				target.boosts[stat] = Math.max(-6, Math.min(6, (target.boosts[stat] ?? 0) + n));
			}
			this.attributeFrom(cmd, target, tags);
			break;
		}
		case '-setboost': {
			if (target && args[1]) target.boosts[args[1] as BoostId] = Number(args[2]);
			this.attributeFrom(cmd, target, tags);
			break;
		}
		case '-clearboost': if (target) target.boosts = {}; break;
		case '-clearpositiveboost': {
			if (target) for (const b of BOOSTS) if ((target.boosts[b] ?? 0) > 0) target.boosts[b] = 0;
			break;
		}
		case '-clearnegativeboost': {
			if (target) for (const b of BOOSTS) if ((target.boosts[b] ?? 0) < 0) target.boosts[b] = 0;
			break;
		}
		case '-clearallboost': {
			for (const s of Object.values(st.sides)) for (const p of s.pokemon) if (p.activeSlot !== null) p.boosts = {};
			break;
		}
		case '-invertboost': {
			if (target) for (const b of BOOSTS) if (target.boosts[b]) target.boosts[b] = -target.boosts[b]!;
			break;
		}
		case '-copyboost': {
			const src = this.mon(args[1]);
			if (target && src) target.boosts = { ...src.boosts };
			break;
		}
		case '-swapboost': {
			const other = this.mon(args[1]);
			const stats = (args[2] ? args[2].split(', ') : BOOSTS) as BoostId[];
			if (target && other) {
				for (const s of stats) {
					const a = target.boosts[s];
					target.boosts[s] = other.boosts[s];
					other.boosts[s] = a;
				}
			}
			break;
		}

		case '-weather': {
			const w = args[0] ?? 'none';
			if (w === 'none') { st.field.weather = undefined; st.field.weatherSince = undefined; }
			else if (!tags.flags.has('upkeep')) {
				st.field.weather = toID(w);
				st.field.weatherSince = st.turn;
			}
			this.attributeFrom(cmd, undefined, tags);
			break;
		}
		case '-fieldstart': case '-fieldend': {
			const eff = effectOf(args[0]);
			const id = toID(eff?.name ?? '');
			if (TERRAINS.has(id)) {
				if (cmd === '-fieldstart') { st.field.terrain = id; st.field.terrainSince = st.turn; }
				else if (st.field.terrain === id) { st.field.terrain = undefined; st.field.terrainSince = undefined; }
			} else if (cmd === '-fieldstart') {
				st.field.pseudoWeather[id] = { since: st.turn };
			} else {
				delete st.field.pseudoWeather[id];
			}
			if (cmd === '-fieldstart') this.attributeFrom(cmd, undefined, tags);
			break;
		}
		case '-sidestart': case '-sideend': {
			if (!args[0]) break;
			const side = this.sideOf(args[0]);
			const id = toID(effectOf(args[1])?.name ?? '');
			if (cmd === '-sidestart') {
				const prev = side.conditions[id];
				side.conditions[id] = { since: prev?.since ?? st.turn, layers: (prev?.layers ?? 0) + 1 };
			} else {
				delete side.conditions[id];
			}
			break;
		}
		case '-swapsideconditions': {
			const a = st.sides.p1.conditions;
			st.sides.p1.conditions = st.sides.p2.conditions;
			st.sides.p2.conditions = a;
			break;
		}

		case '-start': {
			if (target && args[1]) {
				const eff = effectOf(args[1]);
				const id = toID(eff?.name ?? args[1]);
				const info: MonState['volatiles'][string] = { since: st.turn };
				if (id === 'typechange') {
					// "-start|X|typechange|Bug/Steel" (Protean, Soak, ...); Reflect Type names no types: copy [of].
					info.types = args[2] ? args[2].split('/') : this.typesOf(this.mon(tags.of));
					delete target.volatiles.typeadd;
				} else if (id === 'typeadd') {
					info.types = args[2] ? [args[2]] : [];
				} else if (id === 'disable' && args[2]) {
					info.move = toID(args[2]);
				} else if (id === 'confusion' && tags.flags.has('fatigue')) {
					delete target.volatiles.lockedmove;
					if (this.cur?.user === target) this.cur.fatigue = true;
				}
				target.volatiles[id] = info;
				if (eff?.kind === 'ability') this.revealAbility(target, eff.name);
			}
			this.attributeFrom(cmd, target, tags);
			break;
		}
		case '-end': {
			if (target && args[1]) {
				const eff = effectOf(args[1]);
				const id = toID(eff?.name ?? args[1]);
				delete target.volatiles[tags.flags.has('partiallytrapped') ? 'partiallytrapped' : id];
				if (eff?.kind === 'ability') this.revealAbility(target, eff.name);
			}
			this.attributeFrom(cmd, target, tags);
			break;
		}

		case '-item': {
			if (target && args[1]) {
				const from = effectOf(tags.from);
				if (from?.kind === 'move' && ITEM_SWAP_MOVES.has(toID(from.name))) {
					// Received via Trick etc.: not the original item.
					if (target.stint) target.stint.itemChangedSinceMove = true;
					target.item.swapped = true;
					target.item.current = toID(args[1]);
					target.item.lostVia = undefined;
				} else if (from?.kind === 'ability' && ['pickpocket', 'magician', 'pickup', 'harvest'].includes(toID(from.name))) {
					if (target.stint) target.stint.itemChangedSinceMove = true;
					target.item.swapped = true;
					target.item.current = toID(args[1]);
					this.revealAbility(target, from.name);
				} else {
					this.revealItem(target, args[1]);
					if (from?.kind === 'ability') this.attributeFrom(cmd, target, tags);
				}
			}
			break;
		}
		case '-enditem': {
			if (target && args[1]) {
				const from = effectOf(tags.from);
				if (toID(tags.from ?? '') === 'stealeat') {
					const eater = this.mon(tags.of);
					if (eater) this.stolenBerry = { mon: eater, item: toID(args[1]) };
				}
				let via: NonNullable<MonState['item']['lostVia']> = 'used';
				if (tags.flags.has('eat')) via = 'consumed';
				else if (from?.kind === 'move') via = 'removed';
				else if (toID(args[1]) === 'airballoon') via = 'popped';
				if (from?.kind === 'move' && ITEM_SWAP_MOVES.has(toID(from.name))) {
					// Lost to Trick/Thief/etc.: still tells us what it had.
					this.loseItem(target, args[1], 'removed');
					target.item.swapped = true;
				} else {
					this.loseItem(target, args[1], via);
				}
				if (from?.kind === 'ability') this.attributeFrom(cmd, this.mon(tags.of) ?? target, { ...tags, of: undefined });
			}
			break;
		}
		case '-ability': {
			if (target && args[1]) {
				const from = effectOf(tags.from);
				if (from?.kind === 'ability' && toID(from.name) === 'trace') {
					this.revealAbility(target, 'Trace');
					target.ability = toID(args[1]);
					target.abilityChanged = true;
					const of = this.mon(tags.of);
					this.revealAbility(of, args[1]);
				} else if (from?.kind === 'move' || from?.kind === 'ability') {
					// Changed by Role Play / Mummy / Entrainment / etc.: current ability only.
					target.ability = toID(args[1]);
					target.abilityChanged = true;
				} else {
					this.revealAbility(target, args[1]);
				}
			}
			break;
		}
		case '-activate': {
			const eff = effectOf(args[1]);
			if (target && eff && toID(eff.name) === 'trapped') {
				// Mean Look, Block, Spirit Shackle, ...: lasts while the user of the current move stays in.
				target.volatiles.trapped = { since: st.turn, source: this.cur?.user.ident };
			} else if (target && eff?.kind === 'move' && this.format.dex.moves.get(eff.name).volatileStatus === 'partiallytrapped') {
				// "-activate|X|move: Infestation|[of] SOURCE"
				target.volatiles.partiallytrapped = { since: st.turn, move: toID(eff.name), source: this.mon(tags.of)?.ident };
			}
			if (target && eff) {
				if (eff.kind === 'ability') {
					this.revealAbility(target, eff.name);
					// "|-activate|HOLDER|ability: Mummy|ATTACKER|[ability] OLD": the attacker's ability is replaced.
					if (['mummy', 'lingeringaroma'].includes(toID(eff.name)) && args[2]) {
						const other = this.mon(args[2]);
						if (other) {
							if (tags.values.ability) this.revealAbility(other, tags.values.ability);
							other.ability = toID(eff.name);
							other.abilityChanged = true;
						}
					}
				} else if (eff.kind === 'item') {
					this.revealItem(target, eff.name);
				} else if (toID(eff.name) === 'skillswap') {
					// "|-activate|SOURCE|move: Skill Swap|GOT|HAD|[of] TARGET" (also Wandering Spirit).
					// Between allies the names are hidden ("Skill Swap|||").
					const other = this.mon(tags.of);
					const got = args[2] ? toID(args[2]) : undefined;
					const had = args[3] ? toID(args[3]) : undefined;
					if (had) this.revealAbility(target, had);
					if (got && other) this.revealAbility(other, got);
					target.ability = got;
					target.abilityChanged = true;
					if (other) { other.ability = had; other.abilityChanged = true; }
					// Track whose original ability each now has (the names are hidden between allies).
					if (other) {
						const mine = target.abilityFrom ?? target.ident, theirs = other.abilityFrom ?? other.ident;
						target.abilityFrom = theirs;
						other.abilityFrom = mine;
					}
				} else if (eff.kind === 'move' && ['trick', 'switcheroo'].includes(toID(eff.name))) {
					target.item.swapped = true;
					const other = this.mon(args[2]);
					if (other) other.item.swapped = true;
				}
			}
			this.attributeFrom(cmd, target, tags);
			break;
		}
		case 'swap': {
			// Ally Switch etc.: "|swap|p2a: X|1" moves X to slot 1 and the ally to X's old slot.
			const pos = this.parsePosition(args[0]!);
			const side = st.sides[pos.side];
			const from = pos.slot ?? side.active.indexOf(target?.ident ?? '');
			const to = Number(args[1]);
			if (from < 0 || Number.isNaN(to) || from === to) break;
			const a = side.active[from] ?? null;
			const b = side.active[to] ?? null;
			side.active[from] = b;
			side.active[to] = a;
			for (const m of side.pokemon) {
				if (m.ident === a) m.activeSlot = to;
				else if (m.ident === b) m.activeSlot = from;
			}
			break;
		}
		case '-transform': {
			this.attributeFrom(cmd, target, tags);
			const into = this.mon(args[1]);
			if (target && into) {
				target.boosts = { ...into.boosts };
				// Transform copies the target's hit counter (Rage Fist) and type changes too.
				if (target.stint) target.stint.timesAttacked = into.stint?.timesAttacked ?? 0;
				if (into.volatiles.typechange) target.volatiles.typechange = { ...into.volatiles.typechange };
				target.volatiles.transform = { since: st.turn };
				target.transformedInto = into.species;
				target.species = into.species;
			}
			break;
		}
		case '-prepare': {
			// Charging a two-turn move (Solar Beam, Meteor Beam, ...): locked into it next turn.
			if (target && args[1]) target.volatiles.twoturnmove = { since: st.turn, move: toID(args[1]) };
			break;
		}
		case '-anim': {
			// ...unless it fires right away (sun, Power Herb).
			if (target && args[1] && target.volatiles.twoturnmove?.move === toID(args[1])) delete target.volatiles.twoturnmove;
			break;
		}
		case '-singleturn': {
			// Helping Hand, Roost, Protect, Endure, Follow Me, ...: until the end of the turn.
			if (target && args[1]) {
				const id = toID(effectOf(args[1])?.name ?? args[1]);
				const prev = target.volatiles[id];
				target.volatiles[id] = { since: st.turn, singleTurn: true, count: (prev?.count ?? 0) + 1, source: this.mon(tags.of)?.ident };
			}
			this.attributeFrom(cmd, target, tags);
			break;
		}
		case '-singlemove': {
			// Glaive Rush, Destiny Bond, Grudge...: until the Pokémon's next move.
			if (target && args[1]) target.volatiles[toID(effectOf(args[1])?.name ?? args[1])] = { since: st.turn, singleMove: true };
			break;
		}
		case '-immune': case '-block': case '-fail': case '-miss': case '-crit': case '-supereffective':
		case '-resisted': case '-notarget': case '-hitcount':
		case '-zbroken': case '-center': case '-combine': case '-waiting':
		case '-mustrecharge': case '-hint': case '-message':
			this.attributeFrom(cmd, target, tags);
			break;
		default:
			break;
		}
	}
}

/** Parse a whole log. */
export function parseBattleLog(log: string, opts: ParseOptions = {}): KnownBattleState {
	return new BattleLogParser(opts).feedLog(log).state;
}

/**
 * Pull the protocol log out of whatever the user pasted: raw log, a replay JSON
 * (`{"log": ...}`), or a saved replay HTML page.
 */
export function extractLog(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith('{')) {
		const json = JSON.parse(trimmed) as { log?: string; inputLog?: string };
		if (json.log) return json.log;
	}
	const m = /<script[^>]*class="battle-log-data"[^>]*>([\s\S]*?)<\/script>/.exec(text);
	if (m) return m[1]!.replace(/\\\//g, '/');
	return text;
}

/**
 * Turn the simulator's omniscient log (with |split| sections) into what one player — or a
 * spectator, if `perspective` is omitted — would have received.
 */
export function viewOfLog(lines: string[], perspective?: SideId): string[] {
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.startsWith('|split|')) {
			const side = line.slice(7);
			out.push(side === perspective ? lines[i + 1]! : lines[i + 2]!);
			i += 2;
		} else {
			out.push(line);
		}
	}
	return out;
}
