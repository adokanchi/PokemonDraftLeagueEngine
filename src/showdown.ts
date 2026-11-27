/**
 * Single entry point to the pinned Pokémon Showdown simulator.
 *
 * Showdown ships CommonJS; Node's ESM loader can't see its named exports, so we import the
 * module object once here and re-export typed values. Everything else in the engine imports
 * Showdown through this file.
 */
import PS from 'pokemon-showdown';
import type * as PST from 'pokemon-showdown';

export const Battle = PS.Battle;
export type Battle = PST.Battle;
export const Dex = PS.Dex;
export type ModdedDex = ReturnType<typeof PS.Dex.mod>;
export const Teams = PS.Teams;
export const TeamValidator = PS.TeamValidator;
export type TeamValidator = PST.TeamValidator;
export const toID = PS.toID;
export type Pokemon = PST.Pokemon;
export type Side = PST.Side;

export type PokemonSet = NonNullable<ReturnType<typeof PS.Teams.unpack>>[number];
export type Species = ReturnType<ModdedDex['species']['get']>;
export type Item = ReturnType<ModdedDex['items']['get']>;
export type Move = ReturnType<ModdedDex['moves']['get']>;
export type StatID = keyof PokemonSet['evs'];
