# PokemonDraftLeagueEngine

An analysis and practice engine for Pokémon Champions VGC draft league matches, played on
Pokémon Showdown. Goals: team construction, team preview, and move evaluation. The design is
in [docs/design.md](docs/design.md).

**Status:** foundations (phase P0). The simulator harness, legal-move enumeration, draft-rule
validator, battle-log parser and benchmark are working and tested. The turn solver is next (P1).

## Setup

Requires **Node.js 22+** and **Git**. Works on Windows, macOS and Linux.

```sh
git clone --recurse-submodules https://github.com/adokanchi/PokemonDraftLeagueEngine.git
cd PokemonDraftLeagueEngine
npm install
npm run setup      # fetches and builds the pinned Pokémon Showdown simulator (~1 min)
npm test
```

If you cloned without `--recurse-submodules`, `npm run setup` fetches the submodule for you.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Run all tests |
| `npm run typecheck` | TypeScript type check |
| `npm run bench` | Simulator throughput on this machine, 1 thread and all threads (`-- --threads 8 --seconds 20`) |
| `npm run validate -- examples/rosters.json:a examples/team-a.txt` | Check a roster and team against the league rules and Showdown's validator |
| `npm run check-parser -- 1000` | Deep check of the log parser against simulator truth over many random battles |
| `npm run parse-log -- examples/sample-battle.log --turn 4` | Show what a player knows at a point in a battle (log, replay JSON or saved replay HTML; `--as p1`, `--json`) |

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
