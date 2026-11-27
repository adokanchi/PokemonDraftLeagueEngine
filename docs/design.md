# Draft League Engine — Spec & Design (v5)

_Last updated: 2026-11-26. Repo: https://github.com/adokanchi/PokemonDraftLeagueEngine_

## 0. Ground rules

- **Pokémon Showdown is the source of truth.** League matches are played on Showdown, and Showdown battles are the final measure of success. Any mechanic in Showdown's simulator counts as correct, even where it differs from in-game Champions. Mechanics data (moves, PP, abilities, items, legality) comes from Showdown, never from hand-maintained lists.
- Optimize for Reg M-C now. Keep format and legality data-driven so the engine carries over to future VGC regulations (see §9).

### Showdown specifics (pinned: smogon/pokemon-showdown c7fa6f1, 2026-11-25)
- **Target format: `[Gen 9 Champions] VGC 2026 Reg M-C`** (`gen9championsvgc2026regmc`), challenged as best-of-3. Ruleset: Flat Rules (Species Clause, Item Clause = 1, level 50, bring 6 pick 4, no Mythicals/Restricted), VGC Timer, optional Open Team Sheets.
- **Open team sheets are never used in the league** (players deny or ignore the prompt). The engine ignores that mechanic and always assumes closed sheets.
- Not `[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)`: that format *forces* open team sheets.
- The `champions` mod is currently Reg M-C. When a regulation is retired, Showdown freezes it into its own mod that inherits from `champions` (M-B now lives in `championsregmb`). **The Showdown commit is pinned (git submodule) and format/mod is a config value** (`src/config.ts`).
- Showdown doesn't enforce league draft rules (rosters, Mega designations). Our validator does.
- Things learned from Showdown's data/code (all handled):
  - M-C's item pool is small. No Assault Vest, Choice Band/Specs, Safety Goggles, etc. Showdown's data is authoritative.
  - Champions shows opponents' HP as **floor(percent)** (min 1). At exactly 50 a `g`/`y` suffix tells above/at-or-below 50%; at 20, `y`/`r` does the same for 20%.
  - Showdown's battle serializer returns the battle's own log array, so naive copies share logs. Our `cloneBattle` gives copies a fresh log.

## 1. Format rules (league-defined)

1. Each drafted team has 9–10 Pokémon.
2. Each drafted team has 1–2 Mega Evolutions.
3. A Pokémon drafted as a Mega must hold its Mega Stone. A Pokémon not drafted as a Mega cannot hold a Mega Stone.
4. No two Pokémon with the same National Dex number (e.g. Garchomp + Mega Garchomp, Slowbro + Galarian Slowbro).
5. All matches: best-of-three, Reg M-C doubles, bring 6 pick 4, **closed team sheets** (team preview shows species; moves/items/abilities/stats unknown until revealed).
6. No Z-moves, Dynamax, or Tera.
7. Everything else (moves, items, abilities, mechanics) follows Reg M-C as implemented on Showdown.

### League facts
- **Rosters are public.** Both coaches know each other's full 9–10 Pokémon roster, including Mega designations. Neither knows the other's moves, items, abilities or stats.
- **Teams are locked for the whole Bo3.** Pokémon, moves, items and stats can't change between games. Only which 4 are brought and the lead order can change. Anything learned about the opponent's team stays valid for the rest of the set. Same for what they learn about yours.

### Format details from Reg M-C (read from Showdown's format data)
- Doubles, level 50, bring 6 pick 4.
- Item clause: no two Pokémon may hold the same item.
- One Mega Evolution per battle.
- Stat Points instead of EVs/IVs: 66 total, max 32 per stat, each point = +1 stat, plus stat alignment (nature). In Showdown sets, the "EVs" field holds stat points.
- Damage rolls, PP (set move by move), status mechanics, abilities, etc.: whatever Showdown implements. (The "lowest damage roll removed" report was a since-fixed bug; 0.85× is a valid roll.)

## 2. Implications that shape the design

- **Mega items are public.** Rule 3 + public rosters: a drafted Mega's item is known as soon as it appears at preview, and no other Pokémon holds a stone.
- **Two Megas in the six give three valid lines:** bring only one of them in the 4; bring both and Mega one (which one can be decided mid-battle); or bring both and Mega neither. Preview and turn solvers model all three, and the belief engine tracks "has their Mega been used yet".
- **Item clause is a joint constraint.** Teambuilding assigns items across the six together. In battle it allows cross-Pokémon inference (a revealed Sitrus Berry rules out Sitrus on all their others).
- **The search spaces are enumerable.** At most C(10,6) = 210 sixes per side (84 for a 9-Pokémon roster). Preview is C(6,4)·C(4,2) = 90 options per side, so a 90×90 matrix game.
- **Spreads are linear** (1 point = 1 stat), so tuning spreads to hit benchmarks is a small integer program.
- **Closed sheets make belief tracking essential**, and with teams locked, beliefs carry across all three games of the set.

## 3. Product: an analysis and practice tool (not a game-playing bot for live matches)

**A. Matchup analysis (no matches played)**
- Evaluate the matchup between two rosters.
- Score any team sheet, find the best one, and show how much strength each alternative variation gives up.
- Team-preview recommendations for any preview, updated with known info (reveals, exclusions).
- Turn recommendations for any battle state, with input as a hand-entered state or a Showdown log/replay plus turn number.

**B. Practice matches against the engine**
- Preferred: on a local Showdown server, with the engine as a bot account the user challenges in the normal Showdown client. Fallback: a simpler built-in interface.
- The engine plays the opponent's roster, with sets drawn from its model of what that opponent would build.

### "Team strength" metric
- Sheets are closed, so the opponent can't respond to our actual sheet, only to our roster. A team's strength = its value in the teambuilding game: **expected Bo3 match-win probability against the opponent's equilibrium mix of teams and sets**.
- Also report the worst case against any single plausible opponent team, and the value against the prior (their history and tendencies).
- "Strength lost by a variation" = the difference in that value.
- v0: match-win probability ≈ p²(3−2p) from game win probability p. Later: model Bo3 information carry-over properly (preview re-solving with revealed info).

## 4. Goals and components

| Goal | Component | Output |
|---|---|---|
| 1. Best 6 + sets from my roster vs their roster | Teambuilder | Six, abilities/items/moves/stats/alignment, strength score, variant deltas, robustness report, prep sheet |
| 2. Correct leads/back from team preview, updated with revealed info | Preview solver | Mixed strategy over (4 brought, 2 leads), expected win rate, "switch plans if X" notes |
| 3. Correct move from any battle state (known info only) | Turn solver | Mixed strategy over joint actions (moves, targets, switches, Mega), expected value |

Dependency chain: Goal 1 needs Goal 2's preview values; Goal 2 needs Goal 3's battle win-probability estimates. **Build bottom-up**, shipping a cheap v0 of each early.

Shared infrastructure: format/data layer, simulator, set priors, belief engine, evaluator (heuristic → learned value network).

## 5. Component designs

### 5.1 Format & data layer — **built (P0)**
- `src/config.ts`: format ID → Showdown mod/dex.
- `src/draft/validator.ts`: roster rules 1–4 + team rules (roster membership, Mega stone rules) on top of Showdown's TeamValidator. Accepts "Mega Garchomp Z" style names; maps Megas to the forme used on a team (Floette-Mega → Floette-Eternal).
- `src/state/types.ts`: battle state = exactly what a player knows (field, HP as shown, boosts, statuses, volatiles, revealed moves/items/abilities, item history, Mega status, Illusion handling).
- `src/state/parser.ts`: Showdown protocol/replay → state; `--turn N` gives the state when choosing turn N. Checked against simulator truth: 0 mismatches over ~66k state checks (2,000 random battles × spectator/p1/p2 views). Known inherent limit: while an Illusion disguise is unbroken, the log attributes the Zoroark's actions to the disguise.
- `src/state/knowledge.ts`: per-team revealed facts for Bo3 carry-over, merging across games, item-clause exclusions. Manual exclusions ("not Sitrus") have fields; entering them is still TODO.

### 5.2 Simulator — **built (P0)**
- `src/sim/battle.ts`: Showdown's simulator in-process. Create, copy (`cloneBattle`), request, submit.
- `src/sim/choices.ts`: enumerates every legal choice (moves × targets × Mega, switches, forced switches, Revival Blessing, team preview 90 options). Tests: every enumerated choice is accepted (~750k checked), and the set matches a brute-force search of everything Showdown accepts.
- `src/sim/play.ts`: policies + game loop.

#### Benchmark (2026-11-26, cloud sandbox, Node 22, example teams, random legal play)
| Measure | 1 thread |
|---|---|
| Simulated turn | ~3.1 ms |
| Full battle | ~12 turns; ~27 battles/s |
| Copy battle state | ~1.1 ms |
| Copy + simulate one turn | ~4.7 ms |

`npm run bench` measures the user's PC (all threads) and prints what it means for search and preview budgets. Expect ~1.5–2× per thread and ~8–10× from parallelism on the 7800X3D.

### 5.3 Set priors: matchup-conditioned and open-world
Ladder usage is **not** the prior. Draft coaches tech against the specific opposing roster (e.g. fighting coverage into a Tyranitar; Low Kick Farigiraf is rare on ladder but entirely plausible in draft). Three layers:
1. **Open-world floor:** every legal move/item/ability/spread keeps nonzero probability, so an unexpected reveal is absorbed rather than treated as impossible.
2. **Matchup-driven proposals (main signal):** generate the sets a sensible coach would build *against my roster*: coverage for my key Pokémon, speed and bulk benchmarks against my threats, Mega choice. Weight each by how much it improves their matchup. This is the teambuilder run from the opponent's side, and it feeds the double oracle in 5.7.
3. **Weak base tilt:** ladder usage and replays (what's generally good) and that coach's history in the league.

### 5.4 Belief engine
- Particle filter over the opponent's **full team configuration**: six sets jointly (item clause), which 4 were brought, which 2 are in the back, Mega status.
- Hard evidence: reveals, explicit exclusions, item clause, Mega designation, legality, knowledge from earlier games in the set (from 5.1's knowledge module).
- Soft evidence: damage vs predicted ranges (using Champions' floor-percent HP display and its 50%/20% hints), speed order, abilities/items that did or didn't trigger, how likely their move choices were under each hypothesis.
- **Rejuvenation:** when evidence falls outside the current hypotheses (a surprise tech), generate new hypotheses consistent with all evidence, drawn from the open-world space.

### 5.5 Turn solver (Goal 3)
1. Prune each side's actions to plausible ones (heuristic or policy prior).
2. Sample K opponent configurations from the belief engine.
3. Per sample, build a joint-action payoff matrix: evaluator score averaged over chance outcomes.
4. Average over samples; solve for the Nash mixed strategy (LP / regret matching).
5. Output the strategy, expected value, main risks hedged.
- v0: one-turn lookahead + heuristic evaluator. v1: learned value network. v2: multi-turn simultaneous-move search.
- Budget: ~30×30 joint actions × 8 samples ≈ 7k simulated turns per decision ≈ a few seconds on all cores of the user's PC (copy-and-step cost dominates; reduce by pruning and by reusing copies).
- In practice matches it runs under Showdown's timer. In analysis mode there's no time limit (deeper search allowed).

### 5.6 Preview solver (Goal 2)
- Win-probability estimates for the 90×90 (bring, leads) pairs: turn-solver simulations with pruning and adaptive sampling (v0) → learned matchup network (v1).
- Opponent side weighted by the belief engine; mixed Nash, with an optional limited-exploitation mode.
- Re-solve when info changes (new reveal or exclusion, games 2/3).
- Sensitivity output: which hidden facts would flip the recommendation.
- Budget: with random playouts, one pairing of sixes (8,100 cells × 30 games) ≈ 10 minutes on the user's PC. With a search-based policy, far more. So prune dominated brings, sample adaptively, and move to a learned value network.

### 5.7 Teambuilder (Goal 1)
1. Opponent model over their sixes (≤210) and sets, from 5.3.
2. My candidates: sixes (≤210) × joint set assignments (item clause, Mega rules).
3. Spread tuning: benchmark list for the matchup → integer program over stat points + alignment.
4. Screen with a fast matchup estimator; finalists go to double oracle (both sides' team + set choices) using preview-solver values.
5. Report: best sheet, strength score, deltas for variations, robustness report, prep sheet.
- Budget: full 210×210 deep evaluation is out of reach; double oracle over tens of pairings ≈ an overnight run.

## 6. Build order

- **P0 Foundations — done except data ingest:** repo, pinned Showdown + in-process sim harness, legal-choice enumeration, benchmark script, draft validator, battle-state schema + Showdown log parser + Bo3 knowledge. Data ingest (usage stats, replays) moved to P3/P4, where it's first needed.
- **P1 Goal 3 v0:** belief tracker v0 (hard evidence) + heuristic one-turn matrix solver + bot-vs-bot harness. Milestone: beats simple baselines; sensible advice on hand-built states.
- **P1b Practice mode:** engine as a bot on a local Showdown server.
- **P2 Goal 2 v0:** preview solver from P1 simulations.
- **P3 Goal 1 v0:** set generator (5.3 layer 2) + spread tuning + teambuilder on shortlisted teams; team strength and variant deltas.
- **P4 Learning:** imitation from M-C replays → policy/value networks; plug into goals 1–3.
- **P5 Self-play** + per-matchup fine-tuning in the week before each match.
- **P6 Bo3 modeling** and opponent tendencies.

## 7. Environment & decisions

- **Hardware:** user's PC: Ryzen 7 7800X3D (8 cores/16 threads), RTX 4070 (12 GB), 32 GB DDR5. Enough for P0–P4 and modest P5. In P5 the bottleneck is CPU simulation, not GPU. If more is needed: a faster sim port first, renting many-core CPU machines second.
- **Stack:** TypeScript/Node 22 core with Showdown's simulator in-process; vitest for tests; tsx to run scripts. Python/PyTorch only for network training (P4+), with models exported for inference in Node.
- **Repo:** https://github.com/adokanchi/PokemonDraftLeagueEngine. Showdown is a pinned git submodule at `vendor/pokemon-showdown`; `npm run setup` builds it.

## 8. Open questions

None right now.

## 9. Generalizing to future regulations

**Changes automatically** (new Pokémon, Megas, items, moves, banlist, mechanic tweaks): all come from Showdown's data and simulator. The engine points at a format ID + pinned Showdown version. A new regulation = update the pin, set the new format ID, re-run the tests.

Design rules that keep it that way:
- **No hand-coded per-species or per-move knowledge** in the evaluator or set generator. Damage, speed, and effects come from the simulator and Showdown's data.
- **Action space read from Showdown's request** (e.g. `canMegaEvo`), so legal choices are never hard-coded.
- **Learned models describe Pokémon and moves by their properties** (types, base stats, move power/category/target/flags, ability and item effects), not just IDs, so they can handle species they haven't seen. Expect fine-tuning, not retraining from scratch, after a regulation adds Pokémon.
- **Set priors don't depend on ladder data.** The matchup-driven generator works on day one of a new regulation; ladder data only nudges it.

**Needs real work:**
- A **new battle gimmick** (e.g. Terastallization) adds new decisions (when to use it), new hidden information (Tera type), and new teambuilding choices. Showdown's simulator already handles the mechanics; the belief engine, solvers and network inputs need extending. (League rule 6 currently bans Tera.)
- **Trained networks** need fine-tuning on the new regulation (self-play + new replays).
- **League-rule changes** (roster size, number of Megas) are config changes to the draft validator.
