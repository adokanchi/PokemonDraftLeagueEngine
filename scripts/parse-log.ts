/**
 * Show what a player knows at a point in a battle, from a Showdown log or saved replay.
 *
 *   npm run parse-log -- replay.html                 # end of the battle
 *   npm run parse-log -- replay.html --turn 5        # when choosing turn 5
 *   npm run parse-log -- battle.log --as p1 --json   # full state as JSON, from p1's view
 */
import { readFileSync } from 'node:fs';
import { extractLog, parseBattleLog } from '../src/state/parser.js';
import { knowledgeFromState } from '../src/state/knowledge.js';
import type { MonState, SideId } from '../src/state/types.js';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a) && a !== 'p1' && a !== 'p2');
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
if (!file) {
	console.log('Usage: npm run parse-log -- <log|replay.html|replay.json> [--turn N] [--as p1|p2] [--json]');
	process.exit(1);
}
const turn = opt('turn');
const state = parseBattleLog(extractLog(readFileSync(file, 'utf8')), {
	stopAtTurn: turn ? Number(turn) : undefined,
	perspective: opt('as') as SideId | undefined,
});

if (args.includes('--json')) {
	console.log(JSON.stringify(state, null, 2));
	process.exit(0);
}

const mon = (m: MonState) => {
	const hp = m.fainted ? 'fainted' : m.maxHp === 100 ? `${m.hp}%${m.hpColor ? ` (${m.hpColor})` : ''}` : `${m.hp}/${m.maxHp}`;
	const boosts = Object.entries(m.boosts).filter(([, v]) => v).map(([k, v]) => `${k}${v! > 0 ? '+' : ''}${v}`).join(' ');
	const item = m.item.current ? m.item.current : m.item.current === '' ? `none${m.item.original ? ` (had ${m.item.original}, ${m.item.lostVia})` : ''}` : '?';
	return `  ${m.activeSlot !== null ? `[${'ab'[m.activeSlot]}]` : '   '} ${m.name}${m.species !== m.name ? ` (${m.species})` : ''}: ${hp}` +
		`${m.status ? ` ${m.status}` : ''}${boosts ? ` | ${boosts}` : ''} | item ${item} | ability ${m.baseAbility ?? m.ability ?? '?'}` +
		` | moves ${Object.keys(m.moves).join(', ') || '?'}`;
};

console.log(`Turn ${state.turn}${state.ended ? ` (ended, winner: ${state.winner ?? 'tie'})` : ''}`);
const f = state.field;
const fieldBits = [f.weather, f.terrain, ...Object.keys(f.pseudoWeather)].filter(Boolean);
if (fieldBits.length) console.log(`Field: ${fieldBits.join(', ')}`);
for (const id of ['p1', 'p2'] as const) {
	const s = state.sides[id];
	console.log(`\n${id} ${s.name}${s.megaUsed ? ' (Mega used)' : ''}`);
	console.log(`  preview: ${s.preview.join(', ')}`);
	const conds = Object.keys(s.conditions);
	if (conds.length) console.log(`  side: ${conds.join(', ')}`);
	for (const m of s.pokemon) if (m.seen) console.log(mon(m));
}
console.log('\nRevealed (carries over to later games in the set):');
for (const id of ['p1', 'p2'] as const) {
	console.log(`  ${id}: ${JSON.stringify(knowledgeFromState(state, id))}`);
}
