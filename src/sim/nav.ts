import { Level, DOOR, FLOOR, OUT, Pt } from './level';

export function cellWalkable(l: Level, cx: number, cz: number) {
  if (cx < 0 || cz < 0 || cx >= l.w || cz >= l.h) return false;
  const c = l.cells[cz * l.w + cx];
  return c === FLOOR || c === OUT || c === DOOR;
}
const isDoor = (l: Level, cx: number, cz: number) => l.cells[cz * l.w + cx] === DOOR;

/** Straight-line path check with a 0.40m side-clearance probe for the actor's body. Door cells are only allowed at the endpoints. */
export function walkLine(l: Level, a: Pt, b: Pt) {
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
  if (d < 1e-4) return true;
  const clearance = 0.4;
  const n = Math.ceil(d / 0.15), px = (-dz / d) * clearance, pz = (dx / d) * clearance;
  const ac = Math.floor(a.z) * l.w + Math.floor(a.x), bc = Math.floor(b.z) * l.w + Math.floor(b.x);
  for (let i = 0; i <= n; i++) {
    const x = a.x + (dx * i) / n, z = a.z + (dz * i) / n;
    for (const s of [-1, 0, 1]) {
      const cx = Math.floor(x + px * s), cz = Math.floor(z + pz * s);
      if (!cellWalkable(l, cx, cz)) return false;
      if (isDoor(l, cx, cz)) { const k = cz * l.w + cx; if (k !== ac && k !== bc) return false; }
    }
  }
  return true;
}

export function nearestWalkable(l: Level, x: number, z: number, maxR = 4): Pt | null {
  const cx = Math.floor(x), cz = Math.floor(z);
  let best: Pt | null = null, bd = 1e9;
  for (let r = 0; r <= maxR && !best; r++)
    for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++) {
      if (!cellWalkable(l, i, j) || isDoor(l, i, j)) continue;
      const d = Math.hypot(i + 0.5 - x, j + 0.5 - z);
      if (d < bd) { bd = d; best = { x: i + 0.5, z: j + 0.5 }; }
    }
  return best;
}

const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];

/** A* over the grid. Doors are passable (actors open them) at extra cost. Returns smoothed waypoints. */
export function findPath(l: Level, from: Pt, to: Pt, blocked?: (cx: number, cz: number) => boolean): Pt[] | null {
  const w = l.w, sx = Math.floor(from.x), sz = Math.floor(from.z);
  let tx = Math.floor(to.x), tz = Math.floor(to.z);
  let end: Pt = to;
  if (!cellWalkable(l, tx, tz)) { const n = nearestWalkable(l, to.x, to.z); if (!n) return null; end = n; tx = Math.floor(n.x); tz = Math.floor(n.z); }
  if (sx === tx && sz === tz) return [end];
  const N = w * l.h, g = new Float32Array(N).fill(1e9), f = new Float32Array(N), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const open: number[] = []; const s = sz * w + sx, t = tz * w + tx;
  g[s] = 0; f[s] = Math.hypot(tx - sx, tz - sz); open.push(s);
  let found = false;
  while (open.length) {
    let bi = 0; for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
    const cur = open[bi]; open[bi] = open[open.length - 1]; open.pop();
    if (cur === t) { found = true; break; }
    if (closed[cur]) continue; closed[cur] = 1;
    const cx = cur % w, cz = (cur / w) | 0;
    for (const [dx, dz, c] of DIRS) {
      const nx = cx + dx, nz = cz + dz;
      if (!cellWalkable(l, nx, nz)) continue;
      const nk = nz * w + nx; if (closed[nk]) continue;
      if (blocked && nk !== t && blocked(nx, nz)) continue;
      if (dx && dz) { if (!cellWalkable(l, cx + dx, cz) || !cellWalkable(l, cx, cz + dz) || isDoor(l, nx, nz) || isDoor(l, cx, cz) || isDoor(l, cx + dx, cz) || isDoor(l, cx, cz + dz)) continue; }
      const ng = g[cur] + c + (isDoor(l, nx, nz) ? 2.5 : 0);
      if (ng < g[nk]) { g[nk] = ng; came[nk] = cur; f[nk] = ng + Math.hypot(tx - nx, tz - nz); open.push(nk); }
    }
  }
  if (!found) return null;
  const pts: Pt[] = [];
  for (let k = t; k !== -1 && k !== s; k = came[k]) pts.push({ x: (k % w) + 0.5, z: ((k / w) | 0) + 0.5 });
  pts.reverse(); pts[pts.length - 1] = end;
  // string pulling
  const out: Pt[] = []; let anchor: Pt = from, i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    for (; j > i; j--) if (walkLine(l, anchor, pts[j])) break;
    out.push(pts[j]); anchor = pts[j]; i = j + 1;
  }
  return out;
}
