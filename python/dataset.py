"""Reads the training data written by `npm run featurize` (see scripts/featurize.ts).

    from dataset import load
    d = load("data/features/gen9championsvgc2026regmc")
    d.ints      # (rows, 12, 9) int16: species, item, ability, move1-4, status, position per token
    d.floats    # (rows, 12 * mon floats + global floats) float32 in [-1, 1]
    d.mon_floats(), d.global_floats()
    d.labels    # (rows, 7) int8: action_a, target_a, mega_a, action_b, target_b, mega_b, result
    d.meta      # (rows, 5) int32: game, turn, side, rating, held_out

Tokens 0-5 are the deciding player's team, 6-11 the opponent's, each in team preview order.
Run directly to print a summary and a decoded example:  python python/dataset.py DIR
"""
import json
import os
import sys
from dataclasses import dataclass

import numpy as np


@dataclass
class Dataset:
    layout: dict
    vocab: dict
    games: list
    ints: np.ndarray
    floats: np.ndarray
    labels: np.ndarray
    meta: np.ndarray

    @property
    def n_mon_floats(self):
        return len(self.layout["mon_floats"])

    def mon_floats(self):
        t = self.layout["tokens"]
        return self.floats[:, : t * self.n_mon_floats].reshape(-1, t, self.n_mon_floats)

    def global_floats(self):
        return self.floats[:, self.layout["tokens"] * self.n_mon_floats :]

    def split(self):
        """Boolean masks (train, held_out)."""
        held = self.meta[:, 4] == 1
        return ~held, held

    def describe(self, row):
        v, L = self.vocab, self.layout
        names = lambda kind, ids: [v[kind][i] or "-" for i in ids]
        out = [f"game {self.games[self.meta[row, 0]]} turn {self.meta[row, 1]} side p{self.meta[row, 2] + 1} result {self.labels[row, 6]:+d}"]
        mf = self.mon_floats()[row]
        for t in range(L["tokens"]):
            sp, item, ab, *moves, status, pos = self.ints[row, t]
            if sp == 0:
                continue
            who = "me " if t < 6 else "foe"
            out.append(f"  {who} {v['species'][sp]:<18} {['-', 'back', 'active a', 'active b', 'fainted'][pos]:<8} hp {mf[t, 0]:.2f}  "
                       f"{v['items'][item]} / {v['abilities'][ab]} / {', '.join(names('moves', moves))}")
        for s, base in (("a", 0), ("b", 3)):
            a, tgt, mega = self.labels[row, base : base + 3]
            if a < 0:
                out.append(f"  chose ({s}): unknown")
                continue
            slot = 2 if s == "a" else 3
            me = [t for t in range(6) if self.ints[row, t, 8] == slot]
            if a >= 4:
                out.append(f"  chose ({s}): switch to {v['species'][self.ints[row, a - 4, 0]]}")
            elif me:
                move = v["moves"][self.ints[row, me[0], 3 + a]]
                out.append(f"  chose ({s}): {move} target {tgt}{' + mega' if mega else ''}")
        return "\n".join(out)


def load(path):
    layout = json.load(open(os.path.join(path, "layout.json")))
    vocab = json.load(open(os.path.join(path, "vocab.json")))
    games = open(os.path.join(path, "games.txt")).read().split()
    t, ni = layout["tokens"], len(layout["mon_ints"])
    nf = t * len(layout["mon_floats"]) + len(layout["global_floats"])
    parts = {"ints": [], "floats": [], "labels": [], "meta": []}
    for k in range(layout["shards"]):
        f = lambda name, dt: np.fromfile(os.path.join(path, f"{name}-{k}.{dt}"), dtype={"i16": np.int16, "i8": np.int8, "i32": np.int32}[dt])
        parts["ints"].append(f("ints", "i16").reshape(-1, t, ni))
        parts["floats"].append(f("floats", "i8").reshape(-1, nf))
        parts["labels"].append(f("labels", "i8").reshape(-1, len(layout["labels"])))
        parts["meta"].append(f("meta", "i32").reshape(-1, len(layout["meta"])))
    cat = {k: np.concatenate(v) for k, v in parts.items()}
    return Dataset(layout, vocab, games, cat["ints"], cat["floats"].astype(np.float32) / 127, cat["labels"], cat["meta"])


if __name__ == "__main__":
    d = load(sys.argv[1])
    train, held = d.split()
    known = (d.labels[:, [0, 3]] >= 0).sum()
    print(f"{len(d.labels)} positions from {len(set(d.meta[:, 0]))} games; {train.sum()} train, {held.sum()} held out")
    print(f"{known} choices with labels; result +1 in {(d.labels[:, 6] == 1).mean():.1%} of positions")
    print(d.describe(int(sys.argv[2]) if len(sys.argv) > 2 else 0))
