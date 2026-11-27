# Draft League Engine — Spec & Design (v8)

_Last updated: 2026-11-27. Repo: https://github.com/adokanchi/PokemonDraftLeagueEngine_

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
- The parser also records what the rebuild and the damage model need, each checked against the simulator (0 mismatches over ~9.6k checks, except 9 move-failure edge cases): hits taken since switching in (Rage Fist), type changes (Protean, Soak, Mimicry), Disable and its move, trapping and its source (Infestation, Spirit Shackle), charging and Outrage-style locks, Charge, Helping Hand/Roost for the turn, Glaive Rush, whether its last move failed (Stomping Tantrum), moves used since switching in (Last Resort), item changes after its last move (Choice lock after Trick), fainted allies when it came in (Supreme Overlord), changed abilities reverting on switch-out, Skill Swap between allies (whose ability it now has), Shed Tail's Substitute.
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
- **Illusion inference — built (P1)**, `src/belief/illusion.ts`, details in §5.4.1.
- Hard evidence: reveals, explicit exclusions, item clause, Mega designation, legality, knowledge from earlier games in the set (from 5.1's knowledge module).
- Soft evidence: damage vs predicted ranges (using Champions' floor-percent HP display and its 50%/20% hints), speed order, abilities/items that did or didn't trigger, how likely their move choices were under each hypothesis.
- **Rejuvenation:** when evidence falls outside the current hypotheses (a surprise tech), generate new hypotheses consistent with all evidence, drawn from the open-world space.

#### 5.4.1 Illusion (Zoroark / Zoroark-Hisui)
Active only when a Zoroark is in their team preview. For each opposing Pokémon on the field it gives P(it is Zoroark).
- **Exact structure, following Showdown's rules.** The hidden state covers which 4 of the 6 were brought and in what order (360 options) and which benched Pokémon came in at each switch. Showdown's disguise rule decides what each hypothesis would show: on switch-in, Zoroark copies the last non-fainted party member after its own position. Every hypothesis that reproduces what was shown survives. This alone covers:
  - "the real one came in while its copy was already out";
  - a lead Zoroark can only copy a Pokémon in their back;
  - 4 different species seen means Zoroark wasn't brought;
  - a Pokémon that "fainted" and later reappears must have been Zoroark.
- **Evidence while each Pokémon is out**, as likelihoods per hypothesis:
  - Moves: one the shown species can't learn but Zoroark can (Whimsicott using Bitter Malice) is certain. One it rarely runs is graded by the usage prior. A fifth distinct move rules a species out.
  - Abilities: any revealed ability means it's real, since Zoroark only has Illusion. A switch-in with **no** ability message counts against species whose abilities announce: Tyranitar's Sand Stream and Unnerve both always announce, so a silent Tyranitar is certain to be Zoroark. Which abilities announce on switch-in is *measured from the simulator* (`src/belief/announce.ts`), with exceptions for weather/terrain already up and Supersweet Syrup's first-entry-only behaviour.
  - Turn order: possible speeds come from base stats, stat points, nature, boosts, Scarf/Iron Ball, weather and terrain abilities, Tailwind, paralysis and Trick Room. Priority modifiers include Prankster, Gale Wings, Triage, Grassy Glide and Stall. Your own Pokémon use exact stats. Examples: Torkoal outspeeding a max-speed Sneasler is certain to be Zoroark. A Whimsicott Taunting after a +0 move is likely Zoroark, with the non-Prankster chance kept.
  - Types: our status/attack moves vs its types (Toxic failing on a "Kingambit" means real; Will-O-Wisp burning a "Torkoal" means Zoroark). Also sandstorm chip.
  - HP/status continuity: coming back with more HP than it left with, without possible Regenerator, means Zoroark. Same for losing a status without Natural Cure.
  - Items: item clause, items known from earlier games in the set, drafted Mega stones.
  - Mega Evolution, or taking an attack without the disguise breaking, means real.
- "Model says impossible" uses a likelihood of 1e-6 rather than 0, so a model gap can't wipe out every hypothesis; true contradictions are logged and skipped.
- **Validated against the simulator**: across 1,000 random battles where the opponent has a Zoroark (~23k slot checks), **0 wrong "certain" calls** (P > 0.999 or < 0.001), and well calibrated (Brier 0.02 vs 0.11 for the base rate). `npm run check-illusion` reruns this.
- Priors: `src/data/priors.ts`. With no usage file, every legal ability, item and move is equally likely, so the "rarely runs that move / that ability" evidence is weak. `npm run fetch-usage` downloads Smogon usage for the format into `data/usage/`, and it is then blended with a 3% open-world floor.
- Not yet used: damage dealt *by* the suspected Zoroark (STAB and stats via damage calcs), and Grassy Terrain healing.

#### 5.4.2 Opponent sets — **built (P1 v0)**, `src/belief/sets.ts`
- A pool of candidate full sets per species in their preview: moves, ability, item, stat points and nature. Sources:
  - Showdown's curated Champions random-doubles sets (moves, ability, item);
  - Smogon usage when downloaded;
  - spread templates (fast attacker, bulky attacker, support, Trick Room), or usage spreads when available.
- **Hard facts always hold**: revealed moves, ability and item; item clause; drafted Mega stones; earlier games in the set. Reveals are credited to Zoroark or to the shown species only when the Illusion posterior is clear (below 5% or above 95%).
- **Damage evidence**: every hit we land on them, and every hit they land on us, is scored against each candidate with Showdown's own damage formula (`src/belief/damage.ts`).
  - The calculation runs on the whole field at the moment of the hit, restored with the same code as battle reconstruction (`src/engine/restore.ts`): all four active Pokémon (allies matter: Friend Guard, auras, Power Spot), HP, status, boosts, Mega, type changes, abilities, items, volatiles (Helping Hand, Charge, Roost...), hit and faint counters (Rage Fist, Last Respects, Supreme Overlord), side conditions and field, and who still has to move this turn (Payback, Analytic, Bolt Beak).
  - `src/belief/hits.ts` turns the log into one observation per hit: which hit of a multi-hit move (Triple Axel, Parental Bond's second hit), a crit on that hit, an item the hit used up (resist berries), Fickle Beam's announced double power. Hits capped after the formula (KO, Focus Sash, Sturdy, Endure, False Swipe) count as "at least this much"; hits absorbed by Disguise/Ice Face are ignored.
  - With the true sets it explains **99.97% of hits** (9,803 of 9,806 over 500 fresh battles, multi-hit moves included; `npm run check-damage`). It is informative: a wrong defensive spread still fits only 25% of hits, a wrong attacker item 22%. A mismatch stays soft evidence (×0.05).
  - Effect on predictions (`npm run check-sets`): against opponents with realistic spreads, learning from the first four turns raises how often later hits land inside the predicted range from 80.5% to 85.6%. The limit now is the candidate pool (template spreads), not the calculation.
  - Fixed along the way: the calculation's scratch battle used to stop working after ~1,000 log lines (Showdown's loop guard), silently switching damage evidence off; resist berries were eaten during the min-roll calculation, so the max ignored them; cosmetic formes (Vivillon, Furfrou, Squawkabilly colours...) had no candidate sets.
- `sampleTeam()` draws a full four consistent with everything, including where a disguised Zoroark is.
- Not yet: speed-order evidence in the set model (only Illusion uses it so far), Bo3 opponent tendencies.

### 5.5 Turn solver (Goal 3)
**Built (P1 v0):**
- `src/engine/reconstruct.ts` rebuilds a simulator battle from the known state plus a sampled opponent team. It restores:
  - actives, HP (exact for us, middle of the shown percentage for them), status, boosts, Mega, items lost or swapped, PP, faints;
  - volatiles (Substitute, Taunt, Encore, Choice lock, Leech Seed...);
  - weather, terrain, rooms and side conditions with remaining turns;
  - Fake Out and turn counters;
  - disabled moves and trapping, recomputed.
  Checked against real battles (`npm run check-reconstruct`): **99.7% of 3,138 decision points match exactly**, including the full set of legal choices, abilities, types, volatiles, turn counters and hit counters (was 96.4%). Fixed: which move Disable hit; trapping (Infestation-style, Spirit Shackle); charging two-turn moves and Outrage locks; Transform into a Pokémon that has since fainted; Choice lock after Trick and with Klutz; Last Resort; Trace and other changed abilities; White Herb eaten when the rebuilt battle starts; Unburden; Charge; type changes; Glaive Rush; our own Zoroark (found by its exact HP, or by Showdown's disguise rule on our known party order: the Illusion tracker run on our side with the order fixed; when even that is ambiguous, e.g. equal HP, `advise` says so and takes `--zoroark`, and the practice bot uses what it knows); leads' turns-on-field counter (it was one short, so Speed Boost didn't fire at the end of turn 1 in simulations). What's left is mostly Revival Blessing edge cases.
- `src/engine/evaluate.ts`: hand-written score (Pokémon left, HP, status, boosts, Tailwind/screens, Trick Room vs team speed).
- `src/engine/solver.ts`: K determinizations. Each side's actions are narrowed per Pokémon against a few replies, then every pair is simulated (finishing the turn, forced switches included). The game "one mix for us vs the opponent best-responding in each guess" is solved by regret matching. Output: mixed strategy, values, and the opponent's likely actions.
- `src/engine/bots.ts`: `SolverBot` plays from its own view of the log only. `OracleGreedyBot` is a one-turn greedy baseline that sees both teams.
- Results (cloud sandbox, 1 thread, samples 2, keep 6, ≈1 s per decision): **16–0 vs random**, **7–3 vs the oracle greedy bot**. `npm run advise` defaults (samples 6, keep 12) take ≈9 s single-threaded.
- **Parallel search** (`src/engine/pool.ts`, `search-worker.ts`): the search is written as a sequence of batches of cells (one simulated turn each: guess k, our choice, theirs). `solveTurn` runs them in-process; `solveTurnParallel` sends the guesses to a pool of worker threads once (each rebuilds the same battles from the same seeds) and shares the batches out — identical results. `advise` uses all hardware threads but one by default; the arena plays whole games in parallel (`--jobs`). On the 2-core cloud sandbox the gain is ~1.5× (its raw ceiling is 1.4–2×); the laptop's bench scaled 4.2× on 16 threads, so `advise` should take ~2 s there instead of ~9.
- Next: speed evidence in the set model, deeper search, and tuning the evaluator by self-play.

**Original design:**
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
- **P1 Goal 3 v0 — done:** Illusion inference (§5.4.1), opponent set model with damage evidence (§5.4.2), battle reconstruction, heuristic evaluator, one-turn matrix solver, bot-vs-bot arena, `npm run advise`. Beats random 16–0 and an oracle greedy bot 7–3. Accuracy pass: damage model 99.97% of hits, rebuild 99.7% of decision points. Parallel search done. Follow-ups: speed evidence for sets, richer candidate spreads (solve for spreads that fit the observed damage).
- **P1b Practice mode — done:** `npm run server` + `npm run practice -- --team FILE`. The engine logs in to the local server as EngineBot (`src/practice/client.ts`), accepts challenges in the format (single games or Bo3: it confirms "ready" between games; Open Team Sheets prompts are ignored), and plays each battle with a `BattleSession` (`src/practice/session.ts`): it feeds its player view of the log to the opponent model, waits for each turn's log before answering a move request, searches with the worker pool, plays a draw from the recommended mix, and maps switch choices back to the server's party order (falling back to a legal choice if the server rejects one). What the opponent revealed carries over between games against the same user. Team preview is a random pick (or `--bring`) until P2. Tested end to end against a scripted player on a real local server (single games and a Bo3).
- **P2 Goal 2 v0:** preview solver from P1 simulations.
- **P3 Goal 1 v0:** set generator (5.3 layer 2) + spread tuning + teambuilder on shortlisted teams; team strength and variant deltas.
- **P4 Learning:** imitation from M-C replays → policy/value networks; plug into goals 1–3.
- **P5 Self-play** + per-matchup fine-tuning in the week before each match.
- **P6 Bo3 modeling** and opponent tendencies.

## 7. Environment & decisions

- **Hardware:** user's PC: Ryzen 7 7800X3D (8 cores/16 threads), RTX 4070 (12 GB), 32 GB DDR5. Temporarily a laptop (Ryzen 7 7730U, 16 GB): fine for development and tests; benchmarks there won't reflect the desktop. Enough for P0–P4 and modest P5. In P5 the bottleneck is CPU simulation, not GPU. If more is needed: a faster sim port first, renting many-core CPU machines second.
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
