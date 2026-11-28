/**
 * Training labels from a battle log: for every turn and side, what each Pokémon on the field was
 * told to do (move + target + Mega, or switch), plus who won. Positions themselves aren't stored:
 * a position is "the log up to `|turn|N`, seen by side S", and the featurizer rebuilds it from the
 * log with the parser (fast, and the representation can change without re-reading replays).
 *
 * The log doesn't always show the choice. Those slots are labelled `unknown` rather than guessed:
 * a Pokémon that couldn't move (flinch, sleep, paralysis), fainted before acting, or was
 * redirected (Follow Me, Lightning Rod) so the shown target isn't the one chosen.
 */
import { toID } from '../showdown.js';
import { resolveFormat, type ResolvedFormat } from '../config.js';
import type { SideId } from '../state/types.js';

export type SlotLabel =
	| { action: 'move'; move: string; /** Showdown target: 1/2 foe slot a/b, -1/-2 ally slot a/b; absent if the move picks none. */ target?: number; mega?: boolean }
	| { action: 'switch'; /** Species (team forme) brought in. */ species: string; name: string }
	| { action: 'unknown'; /** e.g. couldn't move, fainted before acting, locked into a move (no choice made), target hidden. */ why: string };

export interface TurnLabel {
	turn: number;
	side: SideId;
	/** Slot a and b (null: no Pokémon there). */
	slots: (SlotLabel | null)[];
}

export interface GameLabels {
	winner?: SideId;
	players: Record<SideId, string>;
	turns: TurnLabel[];
	/** The last turn if it never ran (the game ended by forfeit or timer first). */
	unplayedTurn?: number;
	/** Replacements after faints (end of turn): who came in. */
	replacements: { turn: number; side: SideId; slot: number; species: string }[];
}

const TARGETED = new Set(['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf']);
/** The shown target can differ from the chosen one (Dragon Darts retargets; Expanding Force spreads in Psychic Terrain). */
const SHOWN_TARGET_UNRELIABLE = new Set(['dragondarts', 'expandingforce']);
const REDIRECT = /Follow Me|Rage Powder|Spotlight|Ally Switch/;

function parts(line: string) {
	const p = line.slice(1).split('|');
	const args = p.slice(1).filter(a => !a.startsWith('['));
	const tags = p.slice(1).filter(a => a.startsWith('['));
	return { cmd: p[0] ?? '', args, tags };
}

const pos = (ident: string | undefined) => {
	const m = /^(p[12])([ab]):\s*(.*)$/.exec(ident ?? '');
	return m ? { side: m[1] as SideId, slot: 'ab'.indexOf(m[2]!), name: m[3]! } : undefined;
};

export function labelLog(log: string | string[], format: ResolvedFormat = resolveFormat()): GameLabels {
	const lines = (Array.isArray(log) ? log : log.split('\n')).map(l => l.replace(/\r$/, ''));
	const out: GameLabels = { players: { p1: '', p2: '' }, turns: [], replacements: [] };
	// Who is in each slot, as of the start of the current turn's actions.
	const occupant: Record<SideId, (string | null)[]> = { p1: [null, null], p2: [null, null] };
	let turn = 0;
	let body: string[] = [];
	const flush = () => {
		if (turn > 0) labelTurn(turn, body);
		body = [];
	};
	const labelTurn = (t: number, ls: string[]) => {
		const labels: Record<SideId, (SlotLabel | null)[]> = {
			p1: occupant.p1.map(o => (o ? { action: 'unknown', why: 'no action shown' } : null)),
			p2: occupant.p2.map(o => (o ? { action: 'unknown', why: 'no action shown' } : null)),
		};
		// Keys are side + the slot a Pokémon stood in when the turn's choices were made: Ally Switch
		// moves it, and the log then names it by its new slot.
		const decided = new Set<string>();
		const mega = new Set<string>();
		const redirected: Record<SideId, boolean> = { p1: false, p2: false };
		let actionsStarted = false;
		// Instructed moves have no [from] tag: skip the next move line of an Instructed Pokémon.
		const instructed = new Set<string>();
		const encored = new Set<string>();
		const faintedFoeSlots: Record<SideId, Set<number>> = { p1: new Set(), p2: new Set() };
		const slotsNow: Record<SideId, (string | null)[]> = { p1: [...occupant.p1], p2: [...occupant.p2] };
		/** Current position -> slot at choice time. */
		const chosenAt: Record<SideId, number[]> = { p1: [0, 1], p2: [0, 1] };
		const at = (p: { side: SideId; slot: number }) => chosenAt[p.side][p.slot]!;
		const keyOf = (p: { side: SideId; slot: number }) => `${p.side}${at(p)}`;
		/** Marks a slot that hasn't acted yet as unknown for `why` (it's not going to act). */
		const settle = (p: { side: SideId; slot: number; name: string }, why: string) => {
			const key = keyOf(p), o = at(p);
			if (decided.has(key) || labels[p.side][o]?.action !== 'unknown' || occupant[p.side][o] !== p.name) return;
			labels[p.side][o] = { action: 'unknown', why };
			decided.add(key);
		};
		for (let i = 0; i < ls.length; i++) {
			const line = ls[i]!;
			const { cmd, args, tags } = parts(line);
			const from = tags.find(t => t.startsWith('[from]'));
			if (cmd === '-mega' || (cmd === 'detailschange' && /-Mega/.test(args[1] ?? ''))) {
				const p = pos(args[0]);
				if (p) mega.add(keyOf(p));
			}
			if (cmd === '-singleturn' && REDIRECT.test(args[1] ?? '')) { const p = pos(args[0]); if (p) redirected[p.side] = true; }
			if (cmd === '-singleturn' && /Instruct/.test(args[1] ?? '')) { const p = pos(args[0]); if (p) instructed.add(keyOf(p)); }
			if (cmd === '-start' && /Encore/.test(args[1] ?? '')) { const p = pos(args[0]); if (p) encored.add(keyOf(p)); }
			// Hurt itself in confusion: no cant line, just the damage.
			if (cmd === '-damage' && from === '[from] confusion') { const p = pos(args[0]); if (p) settle(p, "couldn't move (confusion)"); }
			if (cmd === 'swap') {
				const p = pos(args[0]);
				const to = Number(args[1]);
				if (p && (to === 0 || to === 1) && to !== p.slot) {
					const c = chosenAt[p.side], n = slotsNow[p.side];
					[c[0], c[1]] = [c[1]!, c[0]!];
					[n[0], n[1]] = [n[1]!, n[0]!];
				}
				continue;
			}
			if (cmd === 'switch' || cmd === 'drag') {
				const p = pos(args[0]);
				if (!p) continue;
				const key = keyOf(p), o = at(p);
				const species = (args[1] ?? '').split(',')[0]!.trim();
				// Switches before anyone acts are chosen; later ones come from moves or items (U-turn, Eject Button).
				if (cmd === 'switch' && !from && !actionsStarted && !decided.has(key) && labels[p.side][o] !== null) {
					labels[p.side][o] = { action: 'switch', species, name: p.name };
					decided.add(key);
				} else {
					// Whoever it replaced left before acting (Eject Button, Roar, Red Card).
					const gone = slotsNow[p.side][p.slot];
					if (gone) settle({ side: p.side, slot: p.slot, name: gone }, 'left the field before acting');
				}
				slotsNow[p.side][p.slot] = p.name;
				continue;
			}
			if (cmd === 'faint') {
				const p = pos(args[0]);
				if (p) {
					settle(p, 'fainted before acting');
					slotsNow[p.side][p.slot] = null; faintedFoeSlots[p.side].add(p.slot);
				}
				continue;
			}
			if (cmd === 'move' || cmd === 'cant') {
				actionsStarted = true;
				const p = pos(args[0]);
				if (!p) continue;
				const key = keyOf(p), o = at(p);
				if (cmd === 'move' && instructed.has(key)) { instructed.delete(key); continue; }
				if (decided.has(key)) continue;
				// Locked in (second turn of a charge move, Outrage, recharge): nothing was chosen.
				if (from === '[from] lockedmove') { settle(p, 'locked into a move'); continue; }
				if (from) continue;
				decided.add(key);
				// Encored before it moved this turn: what it chose was overridden.
				if (encored.has(key)) { labels[p.side][o] = { action: 'unknown', why: 'Encored this turn' }; continue; }
				if (cmd === 'cant') { labels[p.side][o] = { action: 'unknown', why: args[1] === 'recharge' ? 'locked into a move' : `couldn't move (${args[1]})` }; continue; }
				const move = format.dex.moves.get(args[1] ?? '');
				if (move.id === 'struggle') { labels[p.side][o] = { action: 'unknown', why: 'locked into a move' }; continue; }
				const label: SlotLabel = { action: 'move', move: move.id || toID(args[1] ?? '') };
				if (mega.has(key)) label.mega = true;
				if (TARGETED.has(move.target)) {
					let tp = pos(args[2]);
					// Charge moves that fire at once (Electro Shot in rain, Power Herb) name the target on -anim.
					if (!tp && tags.includes('[still]')) {
						for (let j = i + 1; j < ls.length && j < i + 4; j++) {
							const q = parts(ls[j]!);
							if (q.cmd === '-anim' && q.args[0] === args[0]) { tp = pos(q.args[2]); break; }
						}
					}
					const foe = p.side === 'p1' ? 'p2' : 'p1';
					// The shown target isn't the chosen one if the opponent redirected, or Lightning Rod-style abilities did.
					const absorbed = ls.some(l => /-activate\|.*\|ability: (Lightning Rod|Storm Drain)/.test(l));
					// A foe fainted earlier this turn: a move aimed at it was retargeted, so the shown target may not be the chosen one.
					const retargeted = tp?.side === foe && faintedFoeSlots[foe].size > 0;
					if (tp && (retargeted || SHOWN_TARGET_UNRELIABLE.has(move.id)) && !redirected[foe] && !absorbed) { /* move known, target not */ }
					else if (tp && !(tp.side === foe && redirected[foe]) && !absorbed) label.target = tp.side === p.side ? -(tp.slot + 1) : tp.slot + 1;
					else { labels[p.side][o] = { action: 'unknown', why: tp ? 'target redirected' : 'target hidden' }; continue; }
				}
				labels[p.side][o] = label;
				continue;
			}
		}
		if (ls.some(l => l.startsWith('|win|') || l === '|tie')) for (const side of ['p1', 'p2'] as const) labels[side].forEach((l, i) => {
			if (l?.action === 'unknown' && l.why === 'no action shown') labels[side][i] = { action: 'unknown', why: 'game ended first' };
		});
		// A turn that never ran (forfeit or timer loss right after |turn|) has no choices to read.
		const ran = ls.some(l => /^\|(move|cant|switch|drag)\|/.test(l));
		if (ran) for (const side of ['p1', 'p2'] as const) out.turns.push({ turn: t, side, slots: labels[side] });
		else out.unplayedTurn = t;
		// Replacements after the turn's actions: switches after upkeep.
		const up = ls.findIndex(l => l === '|upkeep');
		for (const line of up >= 0 ? ls.slice(up) : []) {
			const { cmd, args } = parts(line);
			if (cmd !== 'switch') continue;
			const p = pos(args[0]);
			if (p) out.replacements.push({ turn: t, side: p.side, slot: p.slot, species: (args[1] ?? '').split(',')[0]!.trim() });
		}
		occupant.p1 = slotsNow.p1; occupant.p2 = slotsNow.p2;
	};
	for (const line of lines) {
		const { cmd, args } = parts(line);
		if (cmd === 'player' && (args[0] === 'p1' || args[0] === 'p2') && args[1]) out.players[args[0]] = args[1];
		if (cmd === 'turn') { flush(); turn = Number(args[0]); continue; }
		if (cmd === 'win') { const w = Object.entries(out.players).find(([, n]) => toID(n) === toID(args[0] ?? '')); if (w) out.winner = w[0] as SideId; }
		if (turn === 0) {
			// Leads.
			if (cmd === 'switch') { const p = pos(args[0]); if (p) occupant[p.side][p.slot] = p.name; }
			continue;
		}
		body.push(line);
	}
	if (turn > 0) labelTurn(turn, body);
	return out;
}
