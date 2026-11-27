/**
 * Format configuration. Everything regulation-specific is selected here so a new regulation is a
 * config change (plus bumping the pinned Showdown commit), not a code change.
 */
import { Dex, type ModdedDex } from './showdown.js';

export interface EngineFormat {
	/** Showdown format ID the league plays (direct challenge, best-of-3 toggled on). */
	formatId: string;
	/** Showdown data mod backing that format. Derived from the format if omitted. */
	mod?: string;
}

/**
 * League format: "[Gen 9 Champions] VGC 2026 Reg M-C", challenged as Bo3.
 * Open team sheets are never accepted in the league, so the engine always treats sheets as closed.
 * When Showdown retires M-C it will move into its own mod (as M-B did with `championsregmb`); at
 * that point update formatId/mod here if needed.
 */
export const DEFAULT_FORMAT: EngineFormat = {
	formatId: 'gen9championsvgc2026regmc',
};

export interface ResolvedFormat {
	formatId: string;
	mod: string;
	dex: ModdedDex;
	gameType: string;
}

export function resolveFormat(f: EngineFormat = DEFAULT_FORMAT): ResolvedFormat {
	const format = Dex.formats.get(f.formatId);
	if (!format.exists) throw new Error(`Unknown Showdown format: ${f.formatId}`);
	const mod = f.mod ?? format.mod;
	return { formatId: format.id, mod, dex: Dex.mod(mod), gameType: format.gameType };
}
