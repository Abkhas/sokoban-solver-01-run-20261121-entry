// Sokoban solver: push-optimal, room by room.
//
// Idea
// ----
// A level is a one-wide hallway with a few small rooms off it (3-4 boxes each).
// A box that leaves its room through the door can never come back, so every box
// stays in its own room and the level's push-optimal count is the sum of the
// rooms' optima. We therefore split the level into rooms and solve each room
// exactly, then walk the player from room to room and concatenate the moves.
// Only pushes are counted, so the walking between rooms is free.
//
// Exactness
// ---------
// Each room is solved by breadth-first search over *pushes*: a state is the
// boxes' squares plus the region the player can walk in (named by its lowest
// square, since the player moves inside a region for free). Pushes are
// generated in order, so the first solved state found uses the fewest pushes
// possible for that room. Two prunings keep the search small, and neither can
// cut a solvable state:
//   - dead squares: a square from which no push (ignoring the other boxes)
//     can ever bring a box onto a goal. A box pushed there is lost.
//   - frozen 2x2 blocks: four squares of walls and boxes holding a box off
//     its goal. No box inside such a block can ever move again.
// The search budget is counted in states, never in time, and the tie-breaking
// order is fixed, so two runs write the same bytes.
//
// The rooms are found by cutting the dead squares of the player's row (the
// hallway: a box there reaches no goal) out of the floor and flood-filling
// what is left; each part holding boxes is a room. If a level does not split
// that way, the same push search runs over the whole level instead. Any
// failure leaves that level with an empty (but well-formed) answer rather
// than breaking the other levels.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one push search keeps before it gives up (work, not time). */
const MAX_STATES = 2_000_000;

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text. Short rows and the outer frame count as walls. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** Squares a lone box can be pushed from onto some goal (pull the goals back). */
function liveSquares(w: number, h: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(w * h);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    const xx = x % w;
    const xy = (x / w) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = xx - DX[k];
      const ny = xy - DY[k];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const y = ny * w + nx; // a box here could be pushed onto x
      const bx = nx - DX[k];
      const by = ny - DY[k]; // where the player must stand to push it
      if (bx < 0 || bx >= w || by < 0 || by >= h) continue;
      const behind = by * w + bx;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood the squares the player reaches from `from` around walls and boxes.
 * Marks them with `stamp` in `seen` and returns the lowest such square.
 */
function flood(
  w: number,
  h: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const px = p % w;
    const py = (p / w) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = px + DX[k];
      const ny = py + DY[k];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const q = ny * w + nx;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** True when the box just pushed onto `t` sits in a frozen 2x2 block. */
function frozenBlock(
  w: number,
  h: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  goalSet: Uint8Array,
  t: number,
): boolean {
  const tx = t % w;
  const ty = (t / w) | 0;
  for (let oy = -1; oy <= 0; oy++) {
    for (let ox = -1; ox <= 0; ox++) {
      let blocked = 0;
      let bad = false;
      for (let cy = 0; cy < 2; cy++) {
        for (let cx = 0; cx < 2; cx++) {
          const x = tx + ox + cx;
          const y = ty + oy + cy;
          if (x < 0 || x >= w || y < 0 || y >= h) {
            blocked++;
            continue;
          }
          const c = y * w + x;
          if (wall[c] || occupied[c]) {
            blocked++;
            if (occupied[c] && !goalSet[c]) bad = true;
          }
        }
      }
      if (blocked === 4 && bad) return true;
    }
  }
  return false;
}

/** A state's key: its region's lowest square and its boxes, sorted. */
function stateKey(boxes: number[], low: number, size: number): number | string {
  if (boxes.length <= 5) {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  }
  return String.fromCharCode(low, ...boxes);
}

interface PushProblem {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/**
 * The push-optimal move string for one problem, or null when the search gives
 * up. Breadth-first over pushes; the first solved state generated is optimal.
 */
function solvePushes(prob: PushProblem): string | null {
  const { w, h, wall, goals, boxes: startBoxes, player: startPlayer } = prob;
  const size = w * h;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(w, h, wall, goals);
  const solved = (bs: number[]): boolean => bs.every((b) => goalSet[b]);
  if (startBoxes.some((b) => !live[b])) return null;
  if (solved(startBoxes)) return '';

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const stBoxes: number[][] = [startBoxes.slice()];
  const stPlayer: number[] = [startPlayer];
  const stParent: number[] = [-1];
  const stFrom: number[] = [-1];
  const stTo: number[] = [-1];
  const visited = new Map<number | string, number>();
  for (const b of startBoxes) occupied[b] = 1;
  const startLow = flood(w, h, wall, occupied, startPlayer, seen, ++stamp, stack);
  for (const b of startBoxes) occupied[b] = 0;
  visited.set(stateKey(startBoxes, startLow, size), 0);

  let found = -1;
  for (let head = 0; found < 0 && head < stBoxes.length; head++) {
    const boxes = stBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    const regionStamp = ++stamp;
    flood(w, h, wall, occupied, stPlayer[head], seen, regionStamp, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      const bx = b % w;
      const by = (b / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = bx + DX[k];
        const ny = by + DY[k];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const t = ny * w + nx; // where the box would land
        const px = bx - DX[k];
        const py = by - DY[k];
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        const behind = py * w + px; // where the player must stand
        if (seen[behind] !== regionStamp) continue; // player cannot get there
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(w, h, wall, occupied, goalSet, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, c) => a - c);
        // The new region's lowest square, flooded into a separate stamp array
        // so it cannot clobber the current region's marks used above.
        const low = flood(w, h, wall, occupied, b, mark, ++stamp, stack);
        occupied[t] = 0;
        occupied[b] = 1;
        const key = stateKey(next, low, size);
        if (visited.has(key)) continue;
        if (stBoxes.length >= MAX_STATES) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        const id = stBoxes.length;
        visited.set(key, id);
        stBoxes.push(next);
        stPlayer.push(b);
        stParent.push(head);
        stFrom.push(b);
        stTo.push(t);
        if (solved(next)) {
          found = id;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The pushes, earliest first, then the walk between them.
  const pushes: [number, number][] = [];
  for (let s = found; s > 0; s = stParent[s]) pushes.push([stFrom[s], stTo[s]]);
  pushes.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes.slice();
  for (const [from, to] of pushes) {
    const d = to - from;
    const k = d === -w ? 0 : d === w ? 1 : d === -1 ? 2 : 3;
    const stand = from - d;
    moves += walkTo(w, h, wall, boxes, player, stand);
    moves += LETTER[k].toUpperCase();
    player = from;
    boxes = boxes.map((b) => (b === from ? to : b));
    boxes.sort((a, c) => a - c);
  }
  return moves;
}

/** The shortest walk from `from` to `to` around walls and boxes (lower letters). */
function walkTo(
  w: number,
  h: number,
  wall: Uint8Array,
  boxes: number[],
  from: number,
  to: number,
): string {
  if (from === to) return '';
  const size = w * h;
  const blocked = new Uint8Array(size);
  for (let i = 0; i < size; i++) blocked[i] = wall[i];
  for (const b of boxes) blocked[b] = 1;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    const px = p % w;
    const py = (p / w) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = px + DX[k];
      const ny = py + DY[k];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const q = ny * w + nx;
      if (blocked[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = LETTER[k];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('no walk to the push square');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** Apply a move string to a level; throws on an illegal step (a bug, not input). */
function applyMoves(level: Level, moves: string): { player: number; boxes: number[] } {
  const boxAt = new Set(level.boxes);
  let player = level.player;
  const { w, wall } = level;
  for (const ch of moves.toLowerCase()) {
    const k = LETTER.indexOf(ch);
    if (k < 0) throw new Error('bad move letter ' + ch);
    const d = DY[k] * w + DX[k];
    const next = player + d;
    if (wall[next]) throw new Error('walk into a wall');
    if (boxAt.has(next)) {
      const beyond = next + d;
      if (wall[beyond] || boxAt.has(beyond)) throw new Error('push into a wall or a box');
      boxAt.delete(next);
      boxAt.add(beyond);
    }
    player = next;
  }
  return { player, boxes: [...boxAt].sort((a, b) => a - b) };
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/** Split a level into rooms by cutting the dead squares of the player's row. */
function roomsOf(level: Level): Room[] | null {
  const { w, h, wall, goals, boxes, player } = level;
  const live = liveSquares(w, h, wall, goals);
  const row = (player / w) | 0;
  const cut = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(w * h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const cells = [s];
    part[s] = rooms.length;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k];
        const ny = cy + DY[k];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const q = ny * w + nx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          cells.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length === 0 || r.boxes.length !== r.goals.length)) return null;
  if (rooms.some((r) => r.boxes.length > 4)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve one level: room by room, or whole-level when it does not split. */
function solveLevel(level: Level): string {
  const whole: PushProblem = {
    w: level.w,
    h: level.h,
    wall: level.wall,
    goals: level.goals,
    boxes: level.boxes,
    player: level.player,
  };
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushes(whole) ?? '';
  let moves = '';
  let player = level.player;
  for (const room of rooms) {
    // The other rooms' boxes stand as walls: solved ones on their goals,
    // unsolved ones where they started. This room's boxes are the only movers.
    const subWall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) subWall[b] = 1;
    }
    const solved = solvePushes({
      w: level.w,
      h: level.h,
      wall: subWall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    });
    if (solved === null) return solvePushes(whole) ?? '';
    moves += solved;
    // Every step moves the player one square in its letter's direction,
    // pushes included, so the player's new square follows from the letters.
    player = endPlayer(level.w, player, solved);
    room.done = true;
  }
  // Sanity: the stitched moves must solve the level from its start.
  const end = applyMoves(level, moves);
  if (!end.boxes.every((b) => level.goals.includes(b))) throw new Error('stitched moves do not solve the level');
  return moves;
}

/** Where the player stands after `moves` from `player`. */
function endPlayer(w: number, player: number, moves: string): number {
  let p = player;
  for (const ch of moves.toLowerCase()) {
    const k = LETTER.indexOf(ch);
    p += DY[k] * w + DX[k];
  }
  return p;
}

for (const id of readdirSync(INPUT).sort()) {
  let moves = '';
  try {
    const level = parseLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
    moves = solveLevel(level);
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
