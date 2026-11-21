# Sokoban Solver v1 — Push-Optimal Solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/keepomakima/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/keepomakima/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, built for the make.fun bounty
`sokoban-solver-01-run-20261121`. One program answers all 5 instances of a set
in a single run, in as few pushes as possible.

## How it works

1. **Rooms.** A generated level is a 1-wide hallway with 1–4 rooms off it, and a
   box pushed out of a room into the hallway can never come back — so every box
   stays in its own room. The solver finds the rooms by cutting the hallway row's
   dead squares out of the floor and flood-filling what is left, then solves each
   room on its own with the other rooms' boxes standing as walls, stitching the
   moves together with the player's walk between rooms. The rooms' push optima
   add up to the level's P*, so solving every room push-optimally solves the level
   in P* pushes — 1,000 points per instance.
2. **Push search.** Inside a room the search is a breadth-first search over
   pushes: a state is the boxes' squares plus the player's reachable region
   (named by its lowest square), every edge is one push, so the first solved state
   found is push-optimal. Two prunings keep it small: a box may only be pushed
   onto a live square (one from which a box, alone, can still be pushed onto some
   goal, found by pulling back from the goals), and a push that leaves a box in a
   frozen 2×2 block of walls and boxes is refused.
3. **Determinism by work, not by the clock.** Every budget is a fixed number of
   states, never a time limit; ties break by insertion order, and nothing reads
   the clock, the environment, or any randomness. Two runs write the same bytes.

If a room's push search ever exhausts its state budget, a greedy best-first
search (same states, ordered by a min-cost box-to-goal assignment) tries to find
any valid solution for that room instead, so the level still gets answered.

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`), writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`) for each instance.
Node 22, no dependencies, no network.
