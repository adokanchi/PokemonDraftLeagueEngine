/**
 * Enumerates every legal choice for one side from a Showdown request.
 *
 * Choices are produced in Showdown's own choice-string syntax ("move 1 2 mega, switch 3"), so
 * they can be fed straight back into the simulator. Redundant variants are removed (e.g. aiming
 * at a fainted foe, which Showdown silently retargets). Tera/Z/Dynamax are never produced: the
 * league bans them.
 */

/** Minimal shape of Showdown's request objects (see vendor/pokemon-showdown/sim/side.ts). */
export interface RequestPokemon {
	ident: string;
	details: string;
	condition: string;
	active: boolean;
	commanding?: boolean;
	reviving?: boolean;
}
export interface RequestMove {
	move: string;
	id: string;
	target?: string;
	disabled?: string | boolean;
}
export interface RequestActive {
	moves: RequestMove[];
	trapped?: boolean;
	maybeTrapped?: boolean;
	canMegaEvo?: boolean;
}
export interface Request {
	wait?: boolean;
	teamPreview?: boolean;
	forceSwitch?: boolean[];
	active?: RequestActive[];
	maxChosenTeamSize?: number;
	side: { pokemon: RequestPokemon[] };
}

export type SlotAction =
	| { type: 'move'; move: number; target?: number; mega?: boolean }
	| { type: 'switch'; slot: number }
	| { type: 'pass' };

/** Which target locations currently hold a living Pokémon (Showdown loc numbering). */
export interface TargetContext {
	/** foeAlive[k] = foe at loc k+1 is alive. */
	foeAlive: boolean[];
	/** selfAlive[k] = our Pokémon at loc -(k+1) is alive. */
	selfAlive: boolean[];
}

const CHOOSABLE_TARGETS = new Set(['normal', 'any', 'adjacentAlly', 'adjacentAllyOrSelf', 'adjacentFoe']);

const isFainted = (p: RequestPokemon | undefined) => !p || p.condition.endsWith(' fnt');

export function actionToString(a: SlotAction): string {
	switch (a.type) {
	case 'pass': return 'pass';
	case 'switch': return `switch ${a.slot}`;
	case 'move': {
		let s = `move ${a.move}`;
		if (a.target !== undefined) s += ` ${a.target}`;
		if (a.mega) s += ' mega';
		return s;
	}
	}
}

export function choiceToString(actions: SlotAction[]): string {
	return actions.map(actionToString).join(', ');
}

/** Possible target locations for a move used from our slot `slot` (0-based) in doubles. */
export function targetsFor(targetType: string | undefined, slot: number, ctx: TargetContext): number[] | undefined {
	if (!targetType || !CHOOSABLE_TARGETS.has(targetType)) return undefined;
	const nSlots = ctx.foeAlive.length;
	const foes = Array.from({ length: nSlots }, (_, k) => k + 1);
	const allies = Array.from({ length: nSlots }, (_, k) => -(k + 1)).filter(loc => loc !== -(slot + 1));
	const self = -(slot + 1);
	let locs: number[];
	switch (targetType) {
	case 'adjacentFoe': locs = foes; break;
	case 'adjacentAlly': locs = allies; break;
	case 'adjacentAllyOrSelf': locs = [self, ...allies]; break;
	default: locs = [...foes, ...allies]; // 'normal' | 'any'
	}
	const alive = (loc: number) => (loc > 0 ? ctx.foeAlive[loc - 1] : ctx.selfAlive[-loc - 1]) === true;
	const living = locs.filter(alive);
	// If nothing valid is alive the move is still legal (it will fail/retarget); keep one option.
	return living.length ? living : locs.slice(0, 1);
}

/** Team preview: choose 4 of 6, the first two lead. Leads and back are unordered pairs (90 options). */
export function teamPreviewChoices(req: Request, opts: { orderedLeads?: boolean } = {}): string[] {
	const n = req.side.pokemon.length;
	const pick = req.maxChosenTeamSize ?? 4;
	if (pick !== 4) throw new Error(`Only bring-6-pick-4 is supported (got pick ${pick})`);
	const out: string[] = [];
	for (let a = 1; a <= n; a++) {
		for (let b = 1; b <= n; b++) {
			if (b === a || (!opts.orderedLeads && b < a)) continue;
			const rest = Array.from({ length: n }, (_, i) => i + 1).filter(x => x !== a && x !== b);
			for (let i = 0; i < rest.length; i++) {
				for (let j = i + 1; j < rest.length; j++) out.push(`team ${a}${b}${rest[i]}${rest[j]}`);
			}
		}
	}
	return out;
}

function product<T>(lists: T[][], ok: (partial: T[]) => boolean): T[][] {
	let acc: T[][] = [[]];
	for (const list of lists) {
		const next: T[][] = [];
		for (const partial of acc) {
			for (const item of list) {
				const cand = [...partial, item];
				if (ok(cand)) next.push(cand);
			}
		}
		acc = next;
	}
	return acc;
}

const noConflicts = (acts: SlotAction[]) => {
	const switches = acts.filter(a => a.type === 'switch').map(a => (a as { slot: number }).slot);
	if (new Set(switches).size !== switches.length) return false;
	return acts.filter(a => a.type === 'move' && a.mega).length <= 1;
};

function forceSwitchChoices(req: Request): SlotAction[][] {
	const mons = req.side.pokemon;
	const nActive = req.forceSwitch!.length;
	const bench = mons.map((p, i) => ({ p, slot: i + 1 })).filter(x => x.slot > nActive && !isFainted(x.p));
	const fainted = mons.map((p, i) => ({ p, slot: i + 1 })).filter(x => isFainted(x.p));
	const needing = req.forceSwitch!.map((f, i) => f && !mons[i]?.reviving ? i : -1).filter(i => i >= 0);
	const passesAllowed = Math.max(0, needing.length - bench.length);
	const perSlot = req.forceSwitch!.map((f, i): SlotAction[] => {
		if (!f) return [{ type: 'pass' }];
		if (mons[i]?.reviving) return fainted.map(x => ({ type: 'switch', slot: x.slot }));
		const opts: SlotAction[] = bench.map(x => ({ type: 'switch', slot: x.slot }));
		if (passesAllowed > 0) opts.push({ type: 'pass' });
		return opts;
	});
	return product(perSlot, acts => {
		if (!noConflicts(acts)) return false;
		const passes = acts.filter((a, i) => a.type === 'pass' && needing.includes(i)).length;
		return passes <= passesAllowed;
	}).filter(acts => {
		const passes = acts.filter((a, i) => a.type === 'pass' && needing.includes(i)).length;
		return passes === passesAllowed;
	});
}

function moveChoices(req: Request, ctx: TargetContext): SlotAction[][] {
	const mons = req.side.pokemon;
	const active = req.active!;
	const bench = mons.map((p, i) => ({ p, slot: i + 1 })).filter(x => x.slot > active.length && !isFainted(x.p));
	const perSlot = active.map((a, slot): SlotAction[] => {
		const mon = mons[slot];
		if (isFainted(mon) || mon?.commanding) return [{ type: 'pass' }];
		const opts: SlotAction[] = [];
		a.moves.forEach((m, idx) => {
			if (m.disabled) return;
			const targets = targetsFor(m.target, slot, ctx);
			const megas = a.canMegaEvo ? [false, true] : [false];
			for (const mega of megas) {
				if (targets) for (const target of targets) opts.push({ type: 'move', move: idx + 1, target, mega });
				else opts.push({ type: 'move', move: idx + 1, mega });
			}
		});
		if (!a.trapped) for (const x of bench) opts.push({ type: 'switch', slot: x.slot });
		return opts;
	});
	return product(perSlot, noConflicts);
}

/** All legal choices for a side, as Showdown choice strings. Empty if the side has nothing to choose. */
export function enumerateChoices(req: Request | null | undefined, ctx: TargetContext): string[] {
	if (!req || req.wait) return [];
	if (req.teamPreview) return teamPreviewChoices(req);
	if (req.forceSwitch) return forceSwitchChoices(req).map(choiceToString);
	if (req.active) return moveChoices(req, ctx).map(choiceToString);
	return [];
}
