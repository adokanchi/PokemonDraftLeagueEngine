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
	| { action: 'unknown'; why: string };

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
	/** Replacements after faints (end of turn): who came in. */
	replacements: { turn: number; side: SideId; slot: number; species: string }[];
}

const TARGETED = new Set(['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf']);
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
		const decided = new Set<string>();
		const mega = new Set<string>();
		const redirected: Record<SideId, boolean> = { p1: false, p2: false };
		let actionsStarted = false;
		// Instructed moves have no [from] tag: skip the next move line of an Instructed Pokémon.
		const instructed = new Set<string>();
		const encored = new Set<string>();
		const faintedFoeSlots: Record<SideId, Set<number>> = { p1: new Set(), p2: new Set() };
		const slotsNow: Record<SideId, (string | null)[]> = { p1: [...occupant.p1], p2: [...occupant.p2] };
		for (const line of ls) {
			const { cmd, args, tags } = parts(line);
			const from = tags.find(t => t.startsWith('[from]'));
			if (cmd === '-mega' || (cmd === 'detailschange' && /-Mega/.test(args[1] ?? ''))) {
				const p = pos(args[0]);
				if (p) mega.add(`${p.side}${p.slot}`);
			}
			if (cmd === '-singleturn' && REDIRECT.test(args[1] ?? '')) { const p = pos(args[0]); if (p) redirected[p.side] = true; }
			if (cmd === '-singleturn' && /Instruct/.test(args[1] ?? '')) { const p = pos(args[0]); if (p) instructed.add(`${p.side}${p.slot}`); }
			if (cmd === '-start' && /Encore/.test(args[1] ?? '')) { const p = pos(args[0]); if (p) encored.add(`${p.side}${p.slot}`); }
			if (cmd === 'switch' || cmd === 'drag') {
				const p = pos(args[0]);
				if (!p) continue;
				const key = `${p.side}${p.slot}`;
				const species = (args[1] ?? '').split(',')[0]!.trim();
				// Switches before anyone acts are chosen; later ones come from moves or items (U-turn, Eject Button).
				if (cmd === 'switch' && !from && !actionsStarted && !decided.has(key) && labels[p.side][p.slot] !== null) {
					labels[p.side][p.slot] = { action: 'switch', species, name: p.name };
					decided.add(key);
				}
				slotsNow[p.side][p.slot] = p.name;
				continue;
			}
			if (cmd === 'faint') {
				const p = pos(args[0]);
				if (p) { slotsNow[p.side][p.slot] = null; faintedFoeSlots[p.side].add(p.slot); }
				continue;
			}
			if (cmd === 'move' || cmd === 'cant') {
				actionsStarted = true;
				const p = pos(args[0]);
				if (!p) continue;
				const key = `${p.side}${p.slot}`;
				if (cmd === 'move' && instructed.has(key)) { instructed.delete(key); continue; }
				if (decided.has(key) || from) continue;
				decided.add(key);
				// Encored before it moved this turn: what it chose was overridden.
				if (encored.has(key)) { labels[p.side][p.slot] = { action: 'unknown', why: 'Encored this turn' }; continue; }
				if (cmd === 'cant') { labels[p.side][p.slot] = { action: 'unknown', why: `couldn't move (${args[1]})` }; continue; }
				const move = format.dex.moves.get(args[1] ?? '');
				const label: SlotLabel = { action: 'move', move: move.id || toID(args[1] ?? '') };
				if (mega.has(key)) label.mega = true;
				if (TARGETED.has(move.target)) {
					const tp = pos(args[2]);
					const foe = p.side === 'p1' ? 'p2' : 'p1';
					// The shown target isn't the chosen one if the opponent redirected, or Lightning Rod-style abilities did.
					const absorbed = ls.some(l => /-activate\|.*\|ability: (Lightning Rod|Storm Drain)/.test(l));
					// A foe fainted earlier this turn: a move aimed at it was retargeted, so the shown target may not be the chosen one.
					const retargeted = tp?.side === foe && faintedFoeSlots[foe].size > 0;
					if (tp && retargeted && !redirected[foe] && !absorbed) { /* move known, target not */ }
					else if (tp && !(tp.side === foe && redirected[foe]) && !absorbed) label.target = tp.side === p.side ? -(tp.slot + 1) : tp.slot + 1;
					else if (!tp || redirected[foe] || absorbed) { labels[p.side][p.slot] = { action: 'unknown', why: 'target hidden or redirected' }; continue; }
				}
				labels[p.side][p.slot] = label;
				continue;
			}
		}
		for (const side of ['p1', 'p2'] as const) out.turns.push({ turn: t, side, slots: labels[side] });
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
