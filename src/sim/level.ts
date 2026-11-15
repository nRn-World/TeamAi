// Level data + procedural building generator. Pure logic (no DOM / three.js).
export const OUT = 0, FLOOR = 1, WALL = 2, DOOR = 3, LOW = 4, HIGH = 5, WINDOW = 6;

export interface Door {
  id: number; cx: number; cz: number; horiz: boolean;
  open: number; target: number;
  locked?: boolean; wedged?: boolean;
}
export type FloorKind = 'carpet' | 'tile' | 'concrete' | 'wood';
export type RoomKind = 'office' | 'corridor' | 'lobby' | 'warehouse' | 'bedroom' | 'storage' | 'vault' | 'club';
export interface Room { id: number; name: string; x: number; z: number; w: number; h: number; floor: FloorKind; kind: RoomKind; spawn: boolean; }
export interface Prop { cx: number; cz: number; kind: 'desk' | 'shelf' | 'crate' | 'bed' | 'sofa' | 'plant' | 'locker' | 'bar' | 'server'; rot: number; }
export interface Pt { x: number; z: number; }

export type LevelTheme = 'office' | 'warehouse' | 'hotel' | 'bank' | 'club' | 'raid';
export type ObjectiveKind = 'clear' | 'hostage' | 'bomb';

export interface Level {
  index: number; name: string; brief: string; theme: LevelTheme; objective: ObjectiveKind;
  w: number; h: number; cells: Uint8Array;
  doors: Door[]; doorAt: Map<number, Door>;
  windows: Pt[];
  rooms: Room[]; props: Prop[];
  breaker?: Pt;
  bomb?: Pt & { time: number };
  playerSpawn: Pt & { yaw: number };
  suspects: (Pt & { room: number; hostage?: boolean })[];
  civs: (Pt & { room: number; vip?: boolean })[];
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
  cells: Uint8Array; doors: Door[] = []; windows: Pt[] = []; rooms: Room[] = []; props: Prop[] = [];
  breaker?: Pt; bomb?: Pt & { time: number };
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
  door(cx: number, cz: number, locked = false) {
    if (this.doors.some(d => d.cx === cx && d.cz === cz)) return;
    const horiz = this.get(cx - 1, cz) === WALL && this.get(cx + 1, cz) === WALL;
    this.set(cx, cz, DOOR);
    this.doors.push({ id: this.doors.length, cx, cz, horiz, open: 0, target: 0, locked });
  }
  win(cx: number, cz: number) {
    if (this.get(cx, cz) !== WALL) return;
    this.set(cx, cz, WINDOW);
    this.windows.push({ x: cx + 0.5, z: cz + 0.5 });
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
  placeBreaker(x: number, z: number) { this.breaker = { x: x + 0.5, z: z + 0.5 }; }
  furnish(rng: () => number, spawn: Pt) {
    const sx = Math.floor(spawn.x), sz = Math.floor(spawn.z);
    for (const r of this.rooms) {
      const area = (r.w - 2) * (r.h - 2);
      let n = r.kind === 'corridor' ? Math.floor(area / 40)
        : r.kind === 'warehouse' ? Math.floor(area / 9)
        : r.kind === 'club' ? Math.floor(area / 11)
        : r.kind === 'vault' ? Math.floor(area / 8)
        : r.kind === 'lobby' ? Math.floor(area / 10)
        : Math.floor(area / 6);
      for (let t = 0; t < n * 4 && n > 0; t++) {
        const x = r.x + 1 + Math.floor(rng() * (r.w - 2)), z = r.z + 1 + Math.floor(rng() * (r.h - 2));
        if (this.get(x, z) !== FLOOR || this.nearDoor(x, z)) continue;
        if (this.bomb && Math.abs(x + 0.5 - this.bomb.x) < 1.5 && Math.abs(z + 0.5 - this.bomb.z) < 1.5) continue;
        const atWall = this.get(x - 1, z) === WALL || this.get(x + 1, z) === WALL || this.get(x, z - 1) === WALL || this.get(x, z + 1) === WALL;
        let kind: Prop['kind']; let high = false;
        if (r.kind === 'warehouse') { kind = 'crate'; high = rng() < 0.65; }
        else if (r.kind === 'corridor') { if (!atWall) continue; kind = 'plant'; }
        else if (r.kind === 'storage') { kind = atWall ? 'shelf' : 'crate'; high = atWall || rng() < 0.5; }
        else if (r.kind === 'vault') { kind = atWall ? 'locker' : 'crate'; high = kind === 'locker'; }
        else if (r.kind === 'club') { kind = atWall ? 'bar' : 'sofa'; }
        else if (r.kind === 'bedroom') { kind = atWall ? (rng() < 0.5 ? 'bed' : 'locker') : 'sofa'; high = kind === 'locker'; }
        else if (r.kind === 'lobby') { kind = atWall ? 'plant' : 'sofa'; }
        else { kind = atWall ? (rng() < 0.35 ? 'server' : rng() < 0.55 ? 'shelf' : 'desk') : 'desk'; high = kind === 'shelf' || kind === 'server'; }
        this.set(x, z, high ? HIGH : LOW);
        if (!this.connected(sx, sz)) { this.set(x, z, FLOOR); continue; }
        this.props.push({ cx: x, cz: z, kind, rot: Math.floor(rng() * 4) });
        n--;
      }
    }
  }
}

interface Spec {
  name: string; brief: string; theme: LevelTheme; objective: ObjectiveKind;
  suspects: number; civs: number; w: number; h: number;
  build(b: Builder, rng: () => number): Pt & { yaw: number };
}

const SPECS: Spec[] = [
  {
    name: 'The Office Complex', theme: 'office', objective: 'clear', w: 32, h: 29, suspects: 5, civs: 3,
    brief: 'Armed suspects have entered an accounting office in Kista. At least three employees are held inside. Glass partitions let you scout the meeting room — use your optiwand, breach or flashbangs to arrest everyone cleanly.',
    build(b) {
      b.room(4, 10, 24, 5, 'Corridor', 'corridor', 'tile', false);
      b.room(10, 14, 10, 7, 'Reception', 'lobby', 'tile', false);
      b.room(4, 3, 7, 8, 'Office West', 'office', 'carpet');
      b.room(10, 3, 6, 8, 'Meeting Room', 'office', 'carpet');
      b.room(15, 3, 6, 8, 'Office Center', 'office', 'carpet');
      b.room(20, 3, 8, 8, "Manager's Office", 'office', 'wood');
      b.room(4, 14, 7, 7, 'Archive', 'storage', 'concrete');
      b.room(19, 14, 9, 7, 'Break Room', 'office', 'wood');
      b.door(14, 20); b.door(14, 14); b.door(7, 10); b.door(12, 10); b.door(17, 10);
      b.door(24, 10, true); // Manager's Office locked
      b.door(7, 14, true);  // Archive locked
      b.door(23, 14); b.door(19, 17); b.door(27, 12);
      // Interior office glass + front floor-to-ceiling curtain-wall glass facade
      b.win(11, 10); b.win(14, 10); b.win(22, 10);
      b.win(6, 20); b.win(8, 20); b.win(11, 20); b.win(12, 20); b.win(13, 20);
      b.win(16, 20); b.win(17, 20); b.win(18, 20); b.win(22, 20); b.win(24, 20);
      b.placeBreaker(11, 19);
      return { x: 14.5, z: 24.4, yaw: 0 };
    },
  },
  {
    name: 'The Warehouse', theme: 'warehouse', objective: 'clear', w: 44, h: 33, suspects: 8, civs: 4,
    brief: 'An arms deal is under way in a dockside warehouse. Workers are trapped among high shipping crates. Watch your flanks, wedge side doors and cut the power breaker if you need the element of surprise.',
    build(b) {
      b.room(4, 4, 26, 20, 'Warehouse Floor', 'warehouse', 'concrete');
      b.room(29, 4, 10, 7, 'Office', 'office', 'carpet');
      b.room(29, 10, 10, 7, 'Staff Room', 'office', 'tile');
      b.room(29, 16, 10, 8, 'Storage', 'storage', 'concrete');
      b.door(16, 23); b.door(4, 12); b.door(29, 7); b.door(29, 13); b.door(29, 20, true);
      b.door(33, 10); b.door(33, 16); b.door(38, 20, true);
      b.win(29, 5); b.win(29, 12); b.win(10, 23); b.win(12, 23); b.win(20, 23); b.win(22, 23);
      b.placeBreaker(5, 22);
      return { x: 16.5, z: 29.0, yaw: 0 };
    },
  },
  {
    name: 'Hotel North Star', theme: 'hotel', objective: 'clear', w: 46, h: 32, suspects: 10, civs: 6,
    brief: 'An armed group has barricaded itself inside Hotel North Star with guests held across multiple rooms. Stack up on doors, peek with the optiwand and clear room by room.',
    build(b) {
      b.room(4, 12, 38, 5, 'Corridor', 'corridor', 'carpet', false);
      b.room(16, 16, 13, 9, 'Lobby', 'lobby', 'tile', false);
      const xs = [4, 10, 16, 22, 28, 34];
      xs.forEach((x, i) => b.room(x, 4, i === 5 ? 8 : 7, 9, 'Room 10' + (i + 1), 'bedroom', i % 2 ? 'wood' : 'carpet'));
      b.room(4, 16, 7, 9, 'Room 107', 'bedroom', 'carpet'); b.room(10, 16, 7, 9, 'Linen Storage', 'storage', 'concrete');
      b.room(28, 16, 7, 9, 'Room 108', 'bedroom', 'wood'); b.room(34, 16, 8, 9, 'Suite', 'bedroom', 'carpet');
      xs.forEach((x, i) => b.door(x + 3, 12, i === 4));
      b.door(22, 24); b.door(22, 16); b.door(7, 16); b.door(13, 16); b.door(31, 16); b.door(37, 16, true);
      b.door(10, 8); b.door(28, 8); b.door(41, 14);
      b.win(19, 16); b.win(25, 16);
      b.win(18, 24); b.win(19, 24); b.win(20, 24); b.win(24, 24); b.win(25, 24); b.win(26, 24);
      b.placeBreaker(11, 23);
      return { x: 22.5, z: 29.0, yaw: 0 };
    },
  },
  {
    name: 'Nordia Bank', theme: 'bank', objective: 'hostage', w: 44, h: 32, suspects: 9, civs: 5,
    brief: 'Armed robbers seized Nordia Bank during business hours. Teller glass shields the main hall and the vault door is locked. Rescue the Bank Director (VIP) and arrest the crew alive.',
    build(b) {
      b.room(4, 14, 24, 11, 'Main Hall', 'lobby', 'tile', false);
      b.room(4, 4, 13, 11, 'Teller Line', 'office', 'tile');
      b.room(16, 4, 12, 11, 'Security Wing', 'office', 'carpet');
      b.room(27, 4, 13, 11, 'Bank Vault', 'vault', 'concrete');
      b.room(27, 14, 13, 11, "Director's Suite", 'office', 'wood');
      b.door(15, 24);
      b.door(9, 14);
      b.door(21, 14);
      b.door(27, 9, true);  // Vault door locked
      b.door(27, 19);
      b.door(33, 14, true); // Vault rear access locked
      b.door(16, 9);
      // Teller glass + tall front granite bank windows
      b.win(6, 14); b.win(7, 14); b.win(12, 14); b.win(13, 14);
      b.win(8, 24); b.win(10, 24); b.win(20, 24); b.win(22, 24);
      b.placeBreaker(17, 5);
      return { x: 15.5, z: 29.0, yaw: 0 };
    },
  },
  {
    name: 'Club Eclipse', theme: 'club', objective: 'bomb', w: 40, h: 31, suspects: 9, civs: 6,
    brief: 'Extremists planted an improvised explosive inside Club Eclipse. Visibility is low and civilians are panicked across the dancefloor. Locate and defuse the bomb before the timer expires!',
    build(b) {
      b.room(4, 10, 20, 14, 'Dancefloor', 'club', 'concrete');
      b.room(4, 3, 11, 8, 'VIP Lounge', 'club', 'carpet');
      b.room(14, 3, 10, 8, 'DJ & Control', 'office', 'wood');
      b.room(23, 10, 13, 14, 'Backstage', 'storage', 'concrete');
      b.room(23, 3, 13, 8, 'Security Office', 'office', 'tile');
      b.door(13, 23);
      b.door(8, 10);
      b.door(18, 10);
      b.door(23, 17);
      b.door(23, 6, true);
      b.door(29, 10, true);
      b.door(14, 6);
      b.win(16, 10); b.win(20, 10); b.win(11, 23); b.win(15, 23);
      b.placeBreaker(24, 22);
      b.bomb = { x: 31.5, z: 16.5, time: 165 };
      return { x: 13.5, z: 27.8, yaw: 0 };
    },
  },
  {
    name: 'Random Raid', theme: 'raid', objective: 'clear', w: 40, h: 31, suspects: 7, civs: 4,
    brief: 'Dynamic tactical warrant in an unmapped compound. Every deployment generates a brand-new floorplan, locked doors, windows and threat positions. Expect the unexpected.',
    build(b, rng) {
      // Procedural BSP-style compound with central corridor + north/south wings
      const cw = 32, cz = 11, ch = 5;
      b.room(4, cz, cw, ch, 'Central Hall', 'corridor', 'tile', false);
      // Entry lobby on south
      const lx = 14 + Math.floor(rng() * 6);
      b.room(lx, cz + ch - 1, 10, 9, 'Entry Lobby', 'lobby', 'tile', false);
      b.door(lx + 4, cz + ch + 7);
      b.win(lx + 2, cz + ch + 7); b.win(lx + 6, cz + ch + 7);
      b.door(lx + 4, cz + ch - 1);

      // North rooms split dynamically
      const northNames = ['Office North', 'Server Room', 'Control', 'Conference', 'Vault', 'Lab'];
      const northKinds: RoomKind[] = ['office', 'storage', 'office', 'office', 'vault', 'office'];
      let x = 4;
      let ni = 0;
      while (x < 36) {
        const rem = 36 - x;
        const rw = rem <= 10 ? rem : 7 + Math.floor(rng() * 5);
        const kind = northKinds[(ni + Math.floor(rng() * 3)) % northKinds.length];
        const floor: FloorKind = kind === 'storage' || kind === 'vault' ? 'concrete' : rng() < 0.5 ? 'carpet' : 'wood';
        b.room(x, 3, rw, 9, northNames[ni % northNames.length], kind, floor, true);
        const dx = x + 2 + Math.floor(rng() * Math.max(1, rw - 4));
        b.door(dx, cz, rng() < 0.3);
        if (rw >= 7 && rng() < 0.65) {
          const wx = dx + (dx + 2 < x + rw - 1 ? 2 : -2);
          if (wx > x && wx < x + rw - 1) b.win(wx, cz);
        }
        if (x > 4 && rng() < 0.45) b.door(x, 6 + Math.floor(rng() * 3));
        x += rw - 1;
        ni++;
        if (rem <= 10) break;
      }

      // South left & right wings flanking Entry Lobby
      if (lx > 7) {
        b.room(4, cz + ch - 1, lx - 3, 9, 'West Wing', rng() < 0.5 ? 'storage' : 'office', 'concrete', true);
        b.door(5 + Math.floor(rng() * Math.max(1, lx - 6)), cz + ch - 1, rng() < 0.35);
        b.door(lx, cz + ch + 2);
      }
      const rx = lx + 9;
      if (36 - rx > 4) {
        b.room(rx, cz + ch - 1, 36 - rx, 9, 'East Wing', rng() < 0.5 ? 'bedroom' : 'storage', 'wood', true);
        b.door(rx + 2 + Math.floor(rng() * Math.max(1, 36 - rx - 4)), cz + ch - 1, rng() < 0.35);
        b.door(rx, cz + ch + 2);
      }

      // Side breach door
      b.door(4, cz + 2);
      b.placeBreaker(lx + 1, cz + ch + 1);
      if (rng() < 0.4) {
        b.bomb = { x: 6.5, z: 7.5, time: 180 };
      }
      return { x: lx + 4.5, z: cz + ch + 10.2, yaw: 0 };
    },
  },
];

export const MISSIONS = SPECS.map(s => ({ name: s.name, brief: s.brief, suspects: s.suspects, civs: s.civs, objective: s.objective }));

export function buildLevel(index: number, seed: number): Level {
  const spec = SPECS[index % SPECS.length];
  const rng = mulberry32(seed * 7919 + index * 104729 + 13);
  const b = new Builder(spec.w, spec.h);
  const spawn = spec.build(b, rng);
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
  const suspects = place(spec.suspects).map((s, i) => ({ ...s, hostage: spec.objective === 'hostage' && i === 0 }));
  const civs = place(spec.civs).map((c, i) => {
    if (spec.objective === 'hostage' && i === 0 && suspects[0]) {
      return { x: suspects[0].x, z: suspects[0].z, room: suspects[0].room, vip: true };
    }
    return { ...c, vip: false };
  });
  const objective: ObjectiveKind = b.bomb ? 'bomb' : spec.objective;
  return {
    index, name: spec.name, brief: spec.brief, theme: spec.theme, objective,
    w: b.w, h: b.h, cells: b.cells, doors: b.doors, doorAt, windows: b.windows,
    rooms: b.rooms, props: b.props, breaker: b.breaker, bomb: b.bomb,
    playerSpawn: spawn, suspects, civs,
  };
}

export function roomAt(l: Level, x: number, z: number): Room | null {
  for (const r of l.rooms) if (x > r.x + 1 - 1e-6 && x < r.x + r.w - 1 && z > r.z + 1 - 1e-6 && z < r.z + r.h - 1) return r;
  return null;
}
