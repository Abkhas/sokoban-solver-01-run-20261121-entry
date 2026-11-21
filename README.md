# Sokoban solver — make.fun sokoban-solver-01-run-20261121

A push-optimal Sokoban solver in a single TypeScript file (`main.ts`, Node 22,
no dependencies).

## How it works

A level is a one-wide hallway with a few small rooms off it (3–4 boxes each).
A box that leaves its room through the door can never come back, so every box
stays in its own room and the level's push-optimal count is the sum of the
rooms' optima. The solver therefore:

1. Splits the level into rooms by cutting the dead squares of the player's row
   (the hallway — a box there reaches no goal) out of the floor and
   flood-filling what is left.
2. Solves each room exactly with breadth-first search over *pushes*: a state
   is the boxes' squares plus the region the player can walk in (named by its
   lowest square). Pushes are generated in order, so the first solved state
   found uses the fewest pushes possible for that room.
3. Prunes only states that cannot lead to a solution: dead squares (a square
   from which no push can ever bring a box onto a goal) and frozen 2×2 blocks
   of walls and boxes holding a box off its goal.
4. Walks the player from room to room and concatenates the moves. Only pushes
   are scored, so the walking is free.

If a level does not split into rooms, the same push search runs over the whole
level. The search budget is counted in states, never in time, and all
tie-breaking is fixed, so two runs write the same bytes.

## Results

- Practice set: **1,000,000** — all 5 instances solved in exactly P* pushes
  (13, 16, 29, 47, 60), in ~1 s for the whole set.
- 14 freshly generated sets (kit generator, random seeds): **1,000,000** on
  every set, every instance at P*, each set in 0.7–1.2 s (budget: 60 s).
- Determinism verified: two runs on the practice set and on a generated set
  produce byte-identical outputs.

## License

MIT — see LICENSE.
