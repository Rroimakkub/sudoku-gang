// Sudoku generator with unique-solution guarantee (bitmask solver, MRV heuristic).
const ROW = [], COL = [], BOX = [];
for (let i = 0; i < 81; i++) {
  ROW[i] = Math.floor(i / 9);
  COL[i] = i % 9;
  BOX[i] = Math.floor(ROW[i] / 3) * 3 + Math.floor(COL[i] / 3);
}

function popcount(x) {
  let n = 0;
  while (x) { x &= x - 1; n++; }
  return n;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Runs a backtracking search over grid g (array of 81 ints, 0 = empty).
// onSolution(grid) returns true to stop. randomize shuffles candidate order.
function search(g, onSolution, randomize) {
  const rows = new Int32Array(9), cols = new Int32Array(9), boxes = new Int32Array(9);
  for (let i = 0; i < 81; i++) {
    const v = g[i];
    if (!v) continue;
    const bit = 1 << v;
    if ((rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]) & bit) return;
    rows[ROW[i]] |= bit; cols[COL[i]] |= bit; boxes[BOX[i]] |= bit;
  }
  let stop = false;
  (function rec() {
    let best = -1, bestMask = 0, bestN = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const m = ~(rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]) & 0x3fe;
      const n = popcount(m);
      if (n < bestN) { best = i; bestMask = m; bestN = n; if (n <= 1) break; }
    }
    if (best < 0) { if (onSolution(g)) stop = true; return; }
    if (bestN === 0) return;
    const cands = [];
    for (let v = 1; v <= 9; v++) if (bestMask & (1 << v)) cands.push(v);
    if (randomize) shuffle(cands);
    const r = ROW[best], c = COL[best], b = BOX[best];
    for (const v of cands) {
      const bit = 1 << v;
      g[best] = v; rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
      rec();
      g[best] = 0; rows[r] &= ~bit; cols[c] &= ~bit; boxes[b] &= ~bit;
      if (stop) return;
    }
  })();
}

function countSolutions(grid, limit = 2) {
  let count = 0;
  search(grid.slice(), () => ++count >= limit, false);
  return count;
}

function fullGrid() {
  let out = null;
  search(new Array(81).fill(0), (g) => { out = g.slice(); return true; }, true);
  return out;
}

const TARGET_CLUES = { easy: 38, medium: 31, hard: 26, extreme: 22 };

function generate(difficulty) {
  const target = TARGET_CLUES[difficulty] || TARGET_CLUES.medium;
  const solution = fullGrid();
  const puzzle = solution.slice();
  let clues = 81;
  // Pass 1: symmetric pairs for a balanced look.
  for (const i of shuffle([...Array(41).keys()])) {
    if (clues <= target) break;
    const j = 80 - i;
    const a = puzzle[i], b = puzzle[j];
    puzzle[i] = 0; puzzle[j] = 0;
    if (countSolutions(puzzle) !== 1) { puzzle[i] = a; puzzle[j] = b; }
    else clues -= i === j ? 1 : 2;
  }
  // Pass 2: single cells, to reach low targets.
  for (const i of shuffle([...Array(81).keys()])) {
    if (clues <= target) break;
    if (!puzzle[i]) continue;
    const a = puzzle[i];
    puzzle[i] = 0;
    if (countSolutions(puzzle) !== 1) puzzle[i] = a;
    else clues--;
  }
  return { puzzle, solution };
}

module.exports = { generate, countSolutions };
