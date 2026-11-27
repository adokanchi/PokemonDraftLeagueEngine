# PokemonDraftLeagueEngine

An analysis and practice engine for Pokémon Champions VGC draft league matches, played on
Pokémon Showdown. Goals: team construction, team preview, and move evaluation. The design is
in [docs/design.md](docs/design.md).

**Status:** P0 and a first version of P1 are done: simulator harness, draft-rule validator,
battle-log parser, Illusion inference, opponent set tracking (including damage-based inference)
and a **one-turn solver** you can ask for advice on any turn of a real battle. Next: faster
(parallel) search, practice mode, and the team-preview solver.

## Setup

Requires **Node.js 22+** and **Git**. Works on Windows, macOS and Linux. Run these once, in order,
from the project folder:

```sh
git clone https://github.com/adokanchi/PokemonDraftLeagueEngine.git
cd PokemonDraftLeagueEngine
npm install        # installs the dev tools (vitest, tsx, TypeScript)
npm run setup      # fetches and builds the pinned Pokémon Showdown simulator (~1-2 min)
npm test
```

After pulling new changes, run `npm install` again, plus `npm run setup` if the Showdown version
changed. If `npm test` says setup isn't finished, it tells you which step is missing.
(`'vitest' is not recognized` means `npm install` hasn't been run in this folder.)

## Commands

| Command | What it does |
|---|---|
| `npm test` | Run all tests |
| `npm run typecheck` | TypeScript type check |
| `npm run bench` | Simulator throughput on this machine, 1 thread and all threads (`-- --threads 8 --seconds 20`) |
| `npm run validate -- examples/rosters.json:a examples/team-a.txt` | Check a roster and team against the league rules and Showdown's validator |
| `npm run check-parser -- 1000` | Deep check of the log parser against simulator truth over many random battles |
| `npm run parse-log -- examples/sample-battle.log --turn 4` | Show what a player knows at a point in a battle (log, replay JSON or saved replay HTML; `--as p1`, `--json`) |
| `npm run parse-log -- replay.html --as p1 --team my-team.txt --turn 5` | Same, plus the chance each opposing Pokémon is a disguised Zoroark (when one is in their preview) |
| `npm run advise -- replay.html --as p1 --team my-team.txt --turn 5` | Recommended play for a turn (a mixed strategy), what they're likely to do, Illusion odds, and their likely sets. Optional `--bring "A,B,C,D"`, `--their-roster rosters.json:b`, `--samples N --keep N` |
| `npm run arena -- 20 [--vs greedy]` | Bot-vs-bot games: the solver against a random player (or a one-turn greedy bot that can see both teams) |
| `npm run fetch-usage` | Download Smogon usage stats for the format (priors for opponents' sets) into `data/usage/` |
| `npm run check-illusion -- 300` | Check Illusion inference against simulator truth over many battles |

Rosters can be JSON (`{"coach": "...", "pokemon": ["Mega Garchomp Z", "Incineroar", ...]}`,
several per file selected with `file.json:key`) or a text file with one Pokémon per line. Teams use
Showdown's export format. In Champions formats the `EVs:` line holds **stat points** (max 32 per
stat, 66 total).

## Layout

```
src/
  showdown.ts        the only import point for the pinned Showdown simulator
  config.ts          format selection (Reg M-C today; change here for a new regulation)
  sim/               battle harness: create/copy/step battles, legal choices, policies, game loop
  draft/             league draft rules (roster size, Megas, dex numbers, Mega stones)
  state/             known-information battle state, Showdown log parser, Bo3 knowledge
scripts/             CLI tools (bench, validate, parse-log, setup)
test/                vitest tests (incl. parser-vs-simulator-truth checks)
examples/            example rosters, teams and a sample battle log
vendor/pokemon-showdown   pinned git submodule (smogon/pokemon-showdown)
docs/design.md       spec and design
```

## Ground rules

- **Showdown is the source of truth** for mechanics and legality. Nothing is hand-maintained.
- Showdown is pinned to an exact commit. To move to a newer Showdown or regulation:
  `cd vendor/pokemon-showdown && git fetch --depth 1 origin <commit> && git checkout <commit>`,
  then `npm run setup`, update `src/config.ts` if the format ID changed, run `npm test`, and commit
  the submodule bump.
