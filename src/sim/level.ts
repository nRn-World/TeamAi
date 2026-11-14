// Level data + procedural building generator. Pure logic (no DOM / three.js).
export const OUT = 0, FLOOR = 1, WALL = 2, DOOR = 3, LOW = 4, HIGH = 5;

export interface Door { id: number; cx: number; cz: number; horiz: boolean; open: number; target: number; }
export type FloorKind = 'carpet' | 'tile' | 'concrete' | 'wood';
export type RoomKind = 'office' | 'corridor' | 'lobby' | 'warehouse' | 'bedroom' | 'storage';
export interface Room { id: number; name: string; x: number; z: number; w: number; h: number; floor: FloorKind; kind: RoomKind; spawn: boolean; }
export interface Prop { cx: number; cz: number; kind: 'desk' | 'shelf' | 'crate' | 'bed' | 'sofa' | 'plant' | 'locker'; rot: number; }
export interface Pt { x: number; z: number; }

export interface Level {
  index: number; name: string; brief: string; theme: 'office' | 'warehouse' | 'hotel';
  w: number; h: number; cells: Uint8Array;
  doors: Door[]; doorAt: Map<number, Door>;
  rooms: Room[]; props: Prop[];
  playerSpawn: Pt & { yaw: number };
  suspects: (Pt & { room: number })[]; civs: (Pt & { room: number })[];
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Builder {
  cells: Uint8Array; doors: Door[] = []; rooms: Room[] = []; props: Prop[] = [];
  constructor(public w: number, public h: number) {
    this.cells = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) { this.set(x, 0, WALL); this.set(x, h - 1, WALL); }
    for (let z = 0; z < h; z++) { this.set(0, z, WALL); this.set(w - 1, z, WALL); }
  }
  set(x: number, z: number, v: number) { this.cells[z * this.w + x] = v; }
  get(x: number, z: number) { return x < 0 || z < 0 || x >= this.w || z >= this.h ? WALL : this.cells[z * this.w + x]; }
  room(x: number, z: number, w: number, h: number, name: string, kind: RoomKind, floor: FloorKind, spawn = true) {
    for (let i = x; i < x + w; i++) for (let j = z; j < z + h; j++) {
      const edge = i === x || j === z || i === x + w - 1 || j === z + h - 1;
      this.set(i, j, edge ? WALL : FLOOR);
    }
    this.rooms.push({ id: this.rooms.length, name, x, z, w, h, floor, kind, spawn });
  }
  door(cx: number, cz: number) {
    const horiz = this.get(cx - 1, cz) === WALL && this.get(cx + 1, cz) === WALL;
    this.set(cx, cz, DOOR);
    this.doors.push({ id: this.doors.length, cx, cz, horiz, open: 0, target: 0 });
  }
  walkable(x: number, z: number) { const c = this.get(x, z); return c === FLOOR || c === OUT || c === DOOR; }
  connected(sx: number, sz: number) {
    const seen = new Uint8Array(this.w * this.h); const st = [sz * this.w + sx]; seen[st[0]] = 1; let n = 0, total = 0;
    for (let i = 0; i < this.cells.length; i++) { const c = this.cells[i]; if (c === FLOOR || c === OUT || c === DOOR) total++; }
    while (st.length) {
      const k = st.pop()!; n++; const x = k % this.w, z = (k / this.w) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (!this.walkable(nx, nz)) continue; const nk = nz * this.w + nx;
        if (!seen[nk]) { seen[nk] = 1; st.push(nk); }
      }
    }
    return n === total;
  }
  nearDoor(x: number, z: number, d = 2) { return this.doors.some(o => Math.abs(o.cx - x) + Math.abs(o.cz - z) <= d); }
  furnish(rng: () => number, spawn: Pt) {
    const sx = Math.floor(spawn.x), sz = Math.floor(spawn.z);
    for (const r of this.rooms) {
      const area = (r.w - 2) * (r.h - 2);
      let n = r.kind === 'corridor' ? Math.floor(area / 40) : r.kind === 'warehouse' ? Math.floor(area / 9) : r.kind === 'lobby' ? Math.floor(area / 10) : Math.floor(area / 6);
      for (let t = 0; t < n * 4 && n > 0; t++) {
        const x = r.x + 1 + Math.floor(rng() * (r.w - 2)), z = r.z + 1 + Math.floor(rng() * (r.h - 2));
        if (this.get(x, z) !== FLOOR || this.nearDoor(x, z)) continue;
        const atWall = this.get(x - 1, z) === WALL || this.get(x + 1, z) === WALL || this.get(x, z - 1) === WALL || this.get(x, z + 1) === WALL;
        let kind: Prop['kind']; let high = false;
        if (r.kind === 'warehouse') { kind = 'crate'; high = rng() < 0.65; }
        else if (r.kind === 'corridor') { if (!atWall) continue; kind = 'plant'; }
        else if (r.kind === 'storage') { kind = atWall ? 'shelf' : 'crate'; high = atWall || rng() < 0.5; }
        else if (r.kind === 'bedroom') { kind = atWall ? (rng() < 0.5 ? 'bed' : 'locker') : 'sofa'; high = kind === 'locker'; }
        else if (r.kind === 'lobby') { kind = atWall ? 'plant' : 'sofa'; }
        else { kind = atWall ? (rng() < 0.45 ? 'shelf' : 'desk') : 'desk'; high = kind === 'shelf'; }
        this.set(x, z, high ? HIGH : LOW);
        if (!this.connected(sx, sz)) { this.set(x, z, FLOOR); continue; }
        this.props.push({ cx: x, cz: z, kind, rot: Math.floor(rng() * 4) });
        n--;
      }
    }
  }
}

interface Spec { name: string; brief: string; theme: Level['theme']; suspects: number; civs: number; build(b: Builder): Pt & { yaw: number }; w: number; h: number; }

const SPECS: Spec[] = [
  {
    name: 'The Office Complex', theme: 'office', w: 32, h: 26, suspects: 5, civs: 3,
    brief: 'Armed suspects have entered an accounting office in Kista. At least three employees are being held inside. Go in through the main entrance, secure every room and arrest the suspects alive if possible.',
    build(b) {
      b.room(4, 10, 24, 5, 'Corridor', 'corridor', 'tile', false);
      b.room(10, 14, 10, 7, 'Reception', 'lobby', 'tile', false);
      b.room(4, 3, 7, 8, 'Office West', 'office', 'carpet');
      b.room(10, 3, 6, 8, 'Meeting Room', 'office', 'carpet');
      b.room(15, 3, 6, 8, 'Office Center', 'office', 'carpet');
      b.room(20, 3, 8, 8, "Manager's Office", 'office', 'wood');
      b.room(4, 14, 7, 7, 'Archive', 'storage', 'concrete');
      b.room(19, 14, 9, 7, 'Break Room', 'office', 'wood');
      for (const [x, z] of [[14, 20], [14, 14], [7, 10], [12, 10], [17, 10], [24, 10], [7, 14], [23, 14], [19, 17], [27, 12]]) b.door(x, z);
      return { x: 14.5, z: 23.2, yaw: 0 };
    },
  },
  {
    name: 'The Warehouse', theme: 'warehouse', w: 44, h: 32, suspects: 8, civs: 4,
    brief: 'An arms deal is under way in a warehouse at the docks. Warehouse workers are held hostage. The floor is large and full of cover – use your teams to cover several angles at once.',
    build(b) {
      b.room(4, 4, 26, 20, 'Warehouse Floor', 'warehouse', 'concrete');
      b.room(29, 4, 10, 7, 'Office', 'office', 'carpet');
      b.room(29, 10, 10, 7, 'Staff Room', 'office', 'tile');
      b.room(29, 16, 10, 8, 'Storage', 'storage', 'concrete');
      for (const [x, z] of [[16, 23], [4, 12], [29, 7], [29, 13], [29, 20], [33, 10], [33, 16], [38, 20]]) b.door(x, z);
      return { x: 16.5, z: 27.5, yaw: 0 };
    },
  },
  {
    name: 'Hotel North Star', theme: 'hotel', w: 46, h: 30, suspects: 10, civs: 6,
    brief: 'An armed group has barricaded itself in a hotel with guests as hostages. Many small rooms and one long corridor – stack up on the doors and clear room by room.',
    build(b) {
      b.room(4, 12, 38, 5, 'Corridor', 'corridor', 'carpet', false);
      b.room(16, 16, 13, 9, 'Lobby', 'lobby', 'tile', false);
      const xs = [4, 10, 16, 22, 28, 34];
      xs.forEach((x, i) => b.room(x, 4, i === 5 ? 8 : 7, 9, 'Room 10' + (i + 1), 'bedroom', i % 2 ? 'wood' : 'carpet'));
      b.room(4, 16, 7, 9, 'Room 107', 'bedroom', 'carpet'); b.room(10, 16, 7, 9, 'Linen Storage', 'storage', 'concrete');
      b.room(28, 16, 7, 9, 'Room 108', 'bedroom', 'wood'); b.room(34, 16, 8, 9, 'Suite', 'bedroom', 'carpet');
      for (const x of xs) b.door(x + 3, 12);
      for (const [x, z] of [[22, 24], [22, 16], [7, 16], [13, 16], [31, 16], [37, 16], [10, 8], [28, 8], [41, 14]]) b.door(x, z);
      return { x: 22.5, z: 27.3, yaw: 0 };
    },
  },
];

export const MISSIONS = SPECS.map(s => ({ name: s.name, brief: s.brief, suspects: s.suspects, civs: s.civs }));

export function buildLevel(index: number, seed: number): Level {
  const spec = SPECS[index % SPECS.length];
  const rng = mulberry32(seed * 7919 + index * 104729 + 13);
  const b = new Builder(spec.w, spec.h);
  const spawn = spec.build(b);
  b.furnish(rng, spawn);
  const doorAt = new Map<number, Door>();
  for (const d of b.doors) doorAt.set(d.cz * b.w + d.cx, d);
  const used = new Set<number>();
  const place = (count: number) => {
    const out: (Pt & { room: number })[] = [];
    const rooms = b.rooms.filter(r => r.spawn);
    for (let i = rooms.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rooms[i], rooms[j]] = [rooms[j], rooms[i]]; }
    let ri = 0, guard = 0;
    while (out.length < count && guard++ < 5000) {
      const r = rooms[ri % rooms.length];
      const x = r.x + 1 + Math.floor(rng() * (r.w - 2)), z = r.z + 1 + Math.floor(rng() * (r.h - 2));
      const k = z * b.w + x;
      if (b.get(x, z) !== FLOOR || used.has(k) || b.nearDoor(x, z, 1)) continue;
      if (Math.hypot(x + 0.5 - spawn.x, z + 0.5 - spawn.z) < 7) { ri++; continue; }
      used.add(k); out.push({ x: x + 0.5, z: z + 0.5, room: r.id }); ri++;
    }
    return out;
  };
  const suspects = place(spec.suspects), civs = place(spec.civs);
  return { index, name: spec.name, brief: spec.brief, theme: spec.theme, w: b.w, h: b.h, cells: b.cells, doors: b.doors, doorAt, rooms: b.rooms, props: b.props, playerSpawn: spawn, suspects, civs };
}

export function roomAt(l: Level, x: number, z: number): Room | null {
  for (const r of l.rooms) if (x > r.x + 1 - 1e-6 && x < r.x + r.w - 1 && z > r.z + 1 - 1e-6 && z < r.z + r.h - 1) return r;
  return null;
}
