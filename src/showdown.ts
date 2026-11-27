/**
 * Single entry point to the pinned Pokémon Showdown simulator (git submodule at
 * vendor/pokemon-showdown, built by `npm run setup`).
 *
 * Showdown ships CommonJS; Node's ESM loader can't see its named exports, so we load the
 * module object once here and re-export typed values. Everything else in the engine imports
 * Showdown through this file.
 */
import { createRequire } from 'node:module';
import type * as PST from '../vendor/pokemon-showdown/dist/sim/index.js';

function loadShowdown(): typeof PST {
	const require = createRequire(import.meta.url);
	try {
		return require('../vendor/pokemon-showdown/dist/sim/index.js') as typeof PST;
	} catch (e) {
		if ((e as { code?: string }).code !== 'MODULE_NOT_FOUND') throw e;
		throw new Error('Pokémon Showdown is not set up yet. Run `npm run setup` (after `npm install`), then try again.');
	}
}

const PS = loadShowdown();

export const Battle = PS.Battle;
export type Battle = PST.Battle;
export const Dex = PS.Dex;
export type ModdedDex = ReturnType<typeof PS.Dex.mod>;
export const Teams = PS.Teams;
export const TeamValidator = PS.TeamValidator;
export type TeamValidator = PST.TeamValidator;
export const toID = PS.toID;
export const Pokemon = PS.Pokemon;
/** Showdown's streaming battle interface (what a server runs): for end-to-end tests of the bot. */
export const BattleStream = PS.BattleStream;
export const getPlayerStreams = PS.getPlayerStreams;
export type Pokemon = PST.Pokemon;
export type Side = PST.Side;

export type PokemonSet = NonNullable<ReturnType<typeof PS.Teams.unpack>>[number];
export type Species = ReturnType<ModdedDex['species']['get']>;
export type Item = ReturnType<ModdedDex['items']['get']>;
export type Move = ReturnType<ModdedDex['moves']['get']>;
export type StatID = keyof PokemonSet['evs'];
