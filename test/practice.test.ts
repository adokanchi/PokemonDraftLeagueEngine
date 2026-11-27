import { describe, expect, it } from 'vitest';
import { BattleStream, getPlayerStreams, Teams, type PokemonSet } from '../src/showdown.js';
import { enumerateChoices } from '../src/sim/choices.js';
import { makeRng } from '../src/sim/play.js';
import { BattleSession } from '../src/practice/session.js';
import { UniformPrior } from '../src/data/priors.js';
import { resolveFormat } from '../src/config.js';
import { randomTeam } from './helpers.js';
import { teamWithZoroark } from './zoroark-helpers.js';

/** One battle through Showdown's own battle stream (the same messages a server sends a player). */
async function playThroughStream(seed: number, botTeam: PokemonSet[], foeTeam: PokemonSet[]) {
	const stream = new BattleStream();
	const players = getPlayerStreams(stream);
	const errors: string[] = [];
	const bot = new BattleSession({
		room: 'test', team: botTeam, prior: new UniformPrior(), seed,
		solve: { samples: 1, keep: 4, perSlot: 2, replies: 2, iterations: 200 },
		send: cmd => { const m = /^\/choose (.*?)(?:\|\d+)?$/.exec(cmd); if (m) void players.p1.write(m[1]!); },
	});
	const rng = makeRng(seed);
	void (async () => {
		for await (const chunk of players.p2) {
			for (const line of chunk.split('\n')) {
				if (!line.startsWith('|request|')) continue;
				const req = JSON.parse(line.slice(9));
				if (req.wait) continue;
				const options = enumerateChoices(req, { foeAlive: [true, true], selfAlive: [true, true] });
				void players.p2.write(options[Math.floor(rng() * options.length)]!);
			}
		}
	})();
	const done = (async () => {
		for await (const chunk of players.p1) {
			const lines = chunk.split('\n');
			errors.push(...lines.filter(l => l.startsWith('|error|')));
			bot.receive(lines);
			if (bot.ended) return;
		}
	})();
	const format = resolveFormat();
	void players.omniscient.write(`>start ${JSON.stringify({ formatid: format.formatId, seed: [seed, seed + 1, seed + 2, seed + 3] })}`);
	void players.omniscient.write(`>player p1 ${JSON.stringify({ name: 'EngineBot', team: Teams.pack(botTeam) })}`);
	void players.omniscient.write(`>player p2 ${JSON.stringify({ name: 'Tester', team: Teams.pack(foeTeam) })}`);
	await done;
	void stream.writeEnd();
	return { winner: bot.winner, errors, decisions: bot.timings.length };
}

describe('practice bot', () => {
	it('plays whole battles from the player stream (as on a server) without invalid choices', async () => {
		let wins = 0;
		for (const seed of [1, 2, 3]) {
			const team = seed === 3 ? teamWithZoroark(40) : randomTeam(100 + seed);
			const res = await playThroughStream(seed, team, randomTeam(200 + seed));
			expect(res.decisions).toBeGreaterThan(0);
			expect(res.errors).toEqual([]);
			if (res.winner === 'EngineBot') wins++;
		}
		expect(wins).toBeGreaterThanOrEqual(2);
	}, 300000);
});
