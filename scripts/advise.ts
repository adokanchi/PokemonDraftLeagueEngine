/**
 * Recommend a move for a turn of a real battle.
 *
 *   npm run advise -- replay.html --as p1 --team my-team.txt --turn 5
 *
 * Options:
 *   --as p1|p2         which side you were (required)
 *   --team FILE        your full team in Showdown export format (required)
 *   --turn N           the turn to decide (default: the last turn in the log)
 *   --bring "A,B,C,D"  the four you brought, in the order you picked them (leads first); needed
 *                      to see through your own Zoroark's disguise, and if not all have appeared
 *   --zoroark a|b|none which of your active slots is your Zoroark right now, if the log can't tell
 *   --their-roster FILE[:key]  their roster (JSON/txt) so drafted Mega stones are known
 *   --samples N --keep N       search budget (defaults 6 and 12; larger = slower, steadier)
 */
import { readFileSync } from 'node:fs';
import { toTeam } from '../src/sim/battle.js';
import { extractLog } from '../src/state/parser.js';
import { OpponentModel } from '../src/belief/sets.js';
import { solveTurn } from '../src/engine/solver.js';
import { parseRoster } from '../src/draft/validator.js';
import { Dex, toID, type PokemonSet } from '../src/showdown.js';
import type { SideId } from '../src/state/types.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const valueFlags = new Set(['--as', '--team', '--turn', '--bring', '--their-roster', '--samples', '--keep', '--zoroark']);
const file = args.find((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1] ?? ''));
const me = opt('as') as SideId | undefined;
const teamFile = opt('team');
if (!file || !me || !teamFile) {
	console.log('Usage: npm run advise -- <log|replay.html|replay.json> --as p1|p2 --team my-team.txt [--turn N] [--bring "A,B,C,D"]');
	process.exit(1);
}
const them: SideId = me === 'p1' ? 'p2' : 'p1';
const ownTeam = toTeam(readFileSync(teamFile, 'utf8')) as PokemonSet[];

let megaStones: Record<string, string> | undefined;
const rosterSpec = opt('their-roster');
if (rosterSpec) {
	const [rfile, key] = rosterSpec.split(/:(?=[^\\/]+$)/);
	const text = readFileSync(rfile!, 'utf8');
	const names: string[] = rfile!.endsWith('.json') ? (key ? JSON.parse(text)[key] : JSON.parse(text)).pokemon : text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	megaStones = {};
	for (const e of parseRoster(names).entries) if (e.isMega && e.megaStone) megaStones[e.teamSpecies] = e.megaStone;
}

// --bring in the order you picked them (leads first) also lets it see through your own Zoroark.
const ownOrder = opt('bring')?.split(',').map(s => s.trim()).map(n => ownTeam.find(t => toID(t.species) === toID(n) || toID(t.name) === toID(n))?.species ?? n);
const model = new OpponentModel({ side: them, ownTeam, megaStones, ownOrder });
const log = extractLog(readFileSync(file, 'utf8')).split('\n');
const turnArg = opt('turn');
const lastTurn = Math.max(0, ...log.filter(l => l.startsWith('|turn|')).map(l => Number(l.slice(6))));
const turn = turnArg ? Number(turnArg) : lastTurn;
for (const line of log) {
	model.feed(line);
	if (line === `|turn|${turn}`) break;
}
const state = model.state;
if (state.turn !== turn) { console.log(`Turn ${turn} isn't in this log (it goes up to turn ${lastTurn}).`); process.exit(1); }

// The four we brought: the ones seen so far, plus --bring or the rest of the team in order.
const seen = state.sides[me].pokemon.filter(m => m.seen).map(m => toID(m.teamSpecies));
const bringNames = opt('bring')?.split(',').map(s => toID(s.trim()));
const byId = (id: string) => ownTeam.find(s => toID(s.species) === id || toID(s.name) === id);
const myTeam: PokemonSet[] = [];
for (const id of [...seen, ...(bringNames ?? []), ...ownTeam.map(s => toID(s.species))]) {
	const s = byId(id);
	if (s && !myTeam.includes(s) && myTeam.length < 4) myTeam.push(s);
}

const samples = Number(opt('samples') ?? 6);
const keep = Number(opt('keep') ?? 12);
console.log(`Turn ${turn}: thinking (${samples} guesses of their team, up to ${keep} options per side)...`);
const zArg = opt('zoroark');
const ownZoroark = zArg ? [0, 1].map(slot => ({ slot, isZoroark: zArg === 'ab'[slot] })) : undefined;
if (!zArg) {
	for (const s of model.ownZoroarkOdds()) {
		if (s.pZoroark > 0.05 && s.pZoroark < 0.95) {
			console.log(`Can't tell from the log whether your ${s.shown} in slot ${'ab'[s.slot]} is your Zoroark (${(100 * s.pZoroark).toFixed(0)}%). Assuming it isn't; pass --zoroark ${'ab'[s.slot]} if it is.`);
		}
	}
}
const res = solveTurn({ state, me, myTeam, model, options: { samples, keep }, ownZoroark });

console.log(`\nRecommended (expected score ${res.value.toFixed(2)} on a -1..+1 scale):`);
for (const o of res.options.filter(o => o.p >= 0.02)) console.log(`  ${(100 * o.p).toFixed(0).padStart(3)}%  ${o.label}`);
console.log('\nOther options (score if they respond well):');
for (const o of res.options.filter(o => o.p < 0.02).slice(0, 5)) console.log(`        ${o.value.toFixed(2)}  ${o.label}`);
console.log('\nWhat they are likely to do:');
for (const o of res.opponent.slice(0, 5)) console.log(`  ${(100 * o.p).toFixed(0).padStart(3)}%  ${o.label}`);

const illusion = model.illusion.report();
if (illusion.zoroark) {
	console.log(`\nIllusion: ${illusion.slots.filter(s => s.shown).map(s => `${s.shown} ${(100 * s.pZoroark).toFixed(0)}% Zoroark`).join(', ')}`);
}
console.log('\nTheir likely sets (top guess per Pokémon on the field):');
for (const slot of [0, 1]) {
	const ident = state.sides[them].active[slot];
	const mon = state.sides[them].pokemon.find(p => p.ident === ident);
	if (!mon || mon.fainted) continue;
	const post = model.posterior(mon.teamSpecies)[0];
	if (!post) continue;
	const s = post.set;
	const dex = Dex.mod('champions');
	const sp = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(k => `${s.evs[k as 'hp']} ${k}`).filter(x => !x.startsWith('0 ')).join(' / ');
	const item = s.item ? dex.items.get(s.item).name : 'no item';
	console.log(`  ${mon.species} (${(100 * post.p).toFixed(0)}%): ${item}, ${dex.abilities.get(s.ability).name}, ${s.nature}, ${sp}; ${s.moves.map(m => dex.moves.get(m).name).join(', ')}`);
}
console.log(`\n(${res.simulations} simulated turns in ${(res.ms / 1000).toFixed(1)} s)`);
