// Sokoban solver v1 — a push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// How it works, in three ideas:
//
//  1. Rooms. A generated level is a 1-wide hallway with 1-4 rooms off it, and a box
//     pushed out of a room into the hallway can never come back, so every box stays
//     in its own room. The rooms are found by cutting the hallway row's dead squares
//     (floor squares no box can ever be pushed from onto a goal) out of the floor and
//     flood-filling what is left. Each room is then solved on its own, with the other
//     rooms' boxes standing as walls, and the moves are stitched together with the
//     player's walk between rooms. The rooms' push optima add up to the level's P*,
//     so solving every room push-optimally solves the level in P* pushes.
//
//  2. Push search. Inside a room the search is a breadth-first search over pushes:
//     a state is the boxes' squares plus the player's reachable region (named by its
//     lowest square), every edge is one push, so the first solved state found is
//     push-optimal. Two prunings keep it small: a box may only be pushed onto a live
//     square (one from which a box, alone, can still be pushed onto some goal, found
//     by pulling back from the goals), and a push that leaves a box in a frozen 2x2
//     block of walls and boxes is refused.
//
//  3. Determinism by work, not by the clock. Every budget is a fixed number of
//     states, never a time limit; ties break by insertion order, and nothing reads
//     the clock, the environment, or any randomness. Two runs write the same bytes.
//
// If a room's push search ever exhausts its state budget, a greedy best-first
// search (same states, ordered by a min-cost box-to-goal assignment) tries to find
// any valid solution for that room instead, so the level still gets answered.
// Local run: MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most push-states one room's breadth-first search keeps before it gives up. */
const ROOM_STATE_CAP = 1_000_000;
/** The most push-states the greedy fallback search expands for one room. */
const GREEDY_STATE_CAP = 400_000;
/** The most push-states the whole-level fallback search keeps. */
const WHOLE_STATE_CAP = 400_000;

interface Dir {
  dx: number;
  dy: number;
  step: string;
  push: string;
}
const DIRS: Dir[] = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface SearchOut {
  pushes: number;
  moves: string;
  endPlayer: number;
  states: number;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
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

/**
 * The live squares: every square from which a box, alone, can be pushed onto some
 * goal. Found by pulling back from the goals: a box on y can be pushed to x when
 * the player can stand on y - d, the square behind it.
 */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const dir of DIRS) {
      const d = dir.dy * w + dir.dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Whether the box just pushed onto `t` sits in a frozen 2x2 block: four squares of
 * walls and boxes, at least one box of them off its goal. Such a block can never
 * move again, so the push that made it is refused.
 */
function frozenBlock(w: number, wall: Uint8Array, occ: Uint8Array, goal: Uint8Array, t: number): boolean {
  const size = wall.length;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= size) continue;
    if (!(wall[a] || occ[a]) || !(wall[b] || occ[b]) || !(wall[c] || occ[c]) || !(wall[d] || occ[d])) continue;
    if ((occ[a] && !goal[a]) || (occ[b] && !goal[b]) || (occ[c] && !goal[c]) || (occ[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (u first on ties). */
function walkTo(w: number, wall: Uint8Array, occ: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how: string[] = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const dir of DIRS) {
      const q = p + dir.dy * w + dir.dx;
      if (q < 0 || q >= size) continue;
      if (wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = dir.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/**
 * A push search over one board: breadth-first over pushes when `greedy` is false
 * (the first solved state found is push-optimal), best-first by a min-cost
 * box-to-goal assignment when `greedy` is true (any valid solution, not optimal).
 * Returns null when the state budget runs out or the board has no solution.
 */
function searchPushes(
  w: number,
  wall: Uint8Array,
  goals: number[],
  boxes0: number[],
  player0: number,
  maxStates: number,
  greedy: boolean,
): SearchOut | null {
  const size = wall.length;
  const n = boxes0.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  for (const b of boxes0) if (!live[b]) return null;
  const solved = (bs: number[]): boolean => {
    for (const b of bs) if (!goal[b]) return false;
    return true;
  };

  // The states, in the order found: their sorted boxes, the player's square after
  // the push that made them, their parent, and that push's from- and to-squares.
  let cap = 4096;
  let bx = new Int32Array(cap * n);
  let pl = new Int32Array(cap);
  let par = new Int32Array(cap);
  let pf = new Int32Array(cap);
  let pt = new Int32Array(cap);
  let count = 0;
  const grow = (): void => {
    const next = cap * 2;
    const nbx = new Int32Array(next * n);
    nbx.set(bx);
    bx = nbx;
    const npl = new Int32Array(next);
    npl.set(pl);
    pl = npl;
    const npar = new Int32Array(next);
    npar.set(par);
    par = npar;
    const npf = new Int32Array(next);
    npf.set(pf);
    pf = npf;
    const npt = new Int32Array(next);
    npt.set(pt);
    pt = npt;
    cap = next;
  };
  const addState = (boxes: number[], player: number, parent: number, from: number, to: number): number => {
    if (count >= cap) grow();
    const s = count++;
    for (let i = 0; i < n; i++) bx[s * n + i] = boxes[i];
    pl[s] = player;
    par[s] = parent;
    pf[s] = from;
    pt[s] = to;
    return s;
  };
  const boxesOf = (s: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(bx[s * n + i]);
    return out;
  };

  // A state's key: its region's lowest square and its boxes, as digits in base
  // `size` (exact while size ** (n + 1) stays under 2 ** 53); a string key when
  // the board holds too many boxes for that.
  const numericKey = size ** (n + 1) < 2 ** 53;
  const keyOf = (bs: number[], low: number): number | string => {
    if (!numericKey) return low + ':' + bs.join(',');
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };
  const index = new Map<number | string, number>();

  // Flood-fill scratch: `seen` marks the current state's region, `mark` the
  // region a push would leave (a second array, so marking the child's region
  // never overwrites the current one's marks), `stack` the work list, `occ`
  // the boxes. regionLow returns the lowest square the player reaches.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  const occ = new Uint8Array(size);
  let stamp = 0;
  const regionLow = (marks: Int32Array, from: number, st: number): number => {
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    marks[from] = st;
    while (sp > 0) {
      const p = stack[--sp];
      if (p < low) low = p;
      const up = p - w;
      const down = p + w;
      const left = p - 1;
      const right = p + 1;
      if (up >= 0 && !wall[up] && !occ[up] && marks[up] !== st) {
        marks[up] = st;
        stack[sp++] = up;
      }
      if (down < size && !wall[down] && !occ[down] && marks[down] !== st) {
        marks[down] = st;
        stack[sp++] = down;
      }
      if (left >= 0 && !wall[left] && !occ[left] && marks[left] !== st) {
        marks[left] = st;
        stack[sp++] = left;
      }
      if (right < size && !wall[right] && !occ[right] && marks[right] !== st) {
        marks[right] = st;
        stack[sp++] = right;
      }
    }
    return low;
  };

  // The greedy heuristic: the cheapest way to match every box to a goal, over
  // BFS distances that ignore the other boxes (exact assignment up to 4 boxes,
  // a sum of nearest goals beyond that).
  let distToGoal: Int32Array[] | null = null;
  const heuristic = (bs: number[]): number => {
    if (distToGoal === null) {
      distToGoal = goals.map((g) => {
        const dist = new Int32Array(size).fill(-1);
        const q = [g];
        dist[g] = 0;
        for (let qi = 0; qi < q.length; qi++) {
          const p = q[qi];
          for (const dir of DIRS) {
            const nb = p + dir.dy * w + dir.dx;
            if (nb < 0 || nb >= size || wall[nb] || dist[nb] !== -1) continue;
            dist[nb] = dist[p] + 1;
            q.push(nb);
          }
        }
        return dist;
      });
    }
    if (n <= 4) {
      // Every matching, by permutation of the goals.
      const perm = goals.map((_, i) => i);
      let best = Infinity;
      const walk = (k: number, cost: number): void => {
        if (cost >= best) return;
        if (k === n) {
          best = cost;
          return;
        }
        for (let i = k; i < n; i++) {
          [perm[k], perm[i]] = [perm[i], perm[k]];
          const d = distToGoal![perm[k]][bs[k]];
          walk(k + 1, cost + (d < 0 ? 1000 : d));
          [perm[k], perm[i]] = [perm[i], perm[k]];
        }
      };
      walk(0, 0);
      return best;
    }
    let total = 0;
    for (const b of bs) {
      let m = Infinity;
      for (const dg of distToGoal) if (dg[b] >= 0 && dg[b] < m) m = dg[b];
      total += m === Infinity ? 1000 : m;
    }
    return total;
  };

  const startBoxes = boxes0.slice();
  const root = addState(startBoxes, player0, -1, -1, -1);
  for (const b of startBoxes) occ[b] = 1;
  const low0 = regionLow(seen, player0, ++stamp);
  for (const b of startBoxes) occ[b] = 0;
  index.set(keyOf(startBoxes, low0), root);
  if (solved(startBoxes)) return { pushes: 0, moves: '', endPlayer: player0, states: 1 };

  // Rebuild the moves of a solved state: walk to each push's square, then push.
  const reconstruct = (found: number): SearchOut => {
    const path: number[] = [];
    for (let s = found; s > 0; s = par[s]) path.push(s);
    path.reverse();
    let moves = '';
    let player = player0;
    const boxes = boxes0.slice();
    for (const s of path) {
      const from = pf[s];
      const to = pt[s];
      const d = to - from;
      const dir = DIRS.find((dd) => dd.dy * w + dd.dx === d)!;
      for (const b of boxes) occ[b] = 1;
      moves += walkTo(w, wall, occ, player, from - d);
      for (const b of boxes) occ[b] = 0;
      moves += dir.push;
      player = from;
      boxes[boxes.indexOf(from)] = to;
      boxes.sort((a, b) => a - b);
    }
    return { pushes: path.length, moves, endPlayer: player, states: count };
  };

  let gaveUp = false;
  let found = -1;
  // Enumerate the push-children of state `s`, calling `emit` for each new one.
  const childrenOf = (s: number, emit: (child: number) => void): void => {
    const bs = boxesOf(s);
    for (const b of bs) occ[b] = 1;
    const here = ++stamp;
    regionLow(seen, pl[s], here);
    for (let bi = 0; bi < n && found < 0 && !gaveUp; bi++) {
      const b = bs[bi];
      for (const dir of DIRS) {
        const d = dir.dy * w + dir.dx;
        const stand = b - d;
        const t = b + d;
        if (stand < 0 || stand >= size || t < 0 || t >= size) continue;
        if (seen[stand] !== here) continue;
        if (wall[t] || occ[t] || !live[t]) continue;
        occ[b] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(w, wall, occ, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          key = keyOf(next, regionLow(mark, b, ++stamp));
        }
        occ[t] = 0;
        occ[b] = 1;
        if (frozen || index.has(key)) continue;
        if (count >= maxStates) {
          gaveUp = true;
          break;
        }
        const child = addState(next!, b, s, b, t);
        index.set(key, child);
        emit(child);
      }
    }
    for (const b of bs) occ[b] = 0;
  };

  if (!greedy) {
    // Breadth-first: the queue, in insertion order, is push order, so the first
    // solved state met is push-optimal.
    const queue: number[] = [root];
    for (let head = 0; head < queue.length && found < 0 && !gaveUp; head++) {
      childrenOf(queue[head], (child) => {
        if (solved(boxesOf(child))) {
          found = child;
          return;
        }
        queue.push(child);
      });
    }
  } else {
    // Greedy best-first: a heap on the assignment heuristic, ties by insertion.
    const heap: [number, number, number][] = [[heuristic(startBoxes), 0, root]];
    let seq = 1;
    const less = (a: [number, number, number], b: [number, number, number]): boolean =>
      a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    const heapPush = (e: [number, number, number]): void => {
      let i = heap.length;
      heap.push(e);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(heap[i]!, heap[p]!)) break;
        [heap[i], heap[p]] = [heap[p]!, heap[i]!];
        i = p;
      }
    };
    const heapPop = (): [number, number, number] => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        for (let i = 0; ; ) {
          let c = 2 * i + 1;
          if (c >= heap.length) break;
          if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
          if (!less(heap[c]!, heap[i]!)) break;
          [heap[i], heap[c]] = [heap[c]!, heap[i]!];
          i = c;
        }
      }
      return top;
    };
    while (heap.length > 0 && found < 0 && !gaveUp) {
      const [, , s] = heapPop();
      childrenOf(s, (child) => {
        const bs = boxesOf(child);
        if (solved(bs)) {
          found = child;
          return;
        }
        heapPush([heuristic(bs), seq++, child]);
      });
    }
  }
  if (found < 0) return null;
  return reconstruct(found);
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the hallway row's dead squares out of the floor, and each
 * part left that holds a box is a room. Null when the level is no set of rooms
 * (a box in the hallway, or a room whose boxes and goals do not match).
 */
function roomsOf(lv: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = lv;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  for (const b of boxes) if (cut[b]) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const dir of DIRS) {
        const q = squares[i] + dir.dy * w + dir.dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  for (const r of rooms) if (r.boxes.length !== r.goals.length) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve one level: room by room, push-optimally; a whole-level search as fallback. */
function solveLevel(text: string): string {
  const lv = parseLevel(text);
  const rooms = roomsOf(lv);
  if (rooms !== null) {
    let player = lv.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      // The other rooms' boxes stand as walls (on their goals once done).
      const wall = lv.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      let solved = searchPushes(lv.w, wall, room.goals, room.boxes, player, ROOM_STATE_CAP, false);
      if (solved === null) solved = searchPushes(lv.w, wall, room.goals, room.boxes, player, GREEDY_STATE_CAP, true);
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved.moves;
      player = solved.endPlayer;
      room.done = true;
    }
    if (ok) return moves;
  }
  let solved = searchPushes(lv.w, lv.wall, lv.goals, lv.boxes, lv.player, WHOLE_STATE_CAP, false);
  if (solved === null) solved = searchPushes(lv.w, lv.wall, lv.goals, lv.boxes, lv.player, GREEDY_STATE_CAP, true);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
