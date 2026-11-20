// Level data + procedural building generator. Pure logic (no DOM / three.js).
export const OUT = 0, FLOOR = 1, WALL = 2, DOOR = 3, LOW = 4, HIGH = 5, WINDOW = 6;

export interface Door {
  id: number; cx: number; cz: number; horiz: boolean; floorY?: number;
  open: number; target: number;
  locked?: boolean; wedged?: boolean;
  trapped?: boolean; trapKnown?: boolean;
}
export type FloorKind = 'carpet' | 'tile' | 'concrete' | 'wood';
export type RoomKind = 'office' | 'corridor' | 'lobby' | 'warehouse' | 'bedroom' | 'storage' | 'vault' | 'club';
export interface Room { id: number; name: string; x: number; z: number; w: number; h: number; floor: FloorKind; kind: RoomKind; spawn: boolean; floorY?: number; }
export type PropKind = 'desk' | 'pc' | 'shelf' | 'crate' | 'bed' | 'sofa' | 'chair' | 'plant' | 'locker' | 'bar' | 'server';
export interface Prop { cx: number; cz: number; kind: PropKind; rot: number; w?: number; d?: number; floorY?: number; }
export interface Pt { x: number; z: number; }
export interface Staircase { x0: number; z0: number; x1: number; z1: number; width: number; fromY: number; toY: number; steps: number; }
export interface ElevatorStop extends Pt { floorY: number; label: string; yaw: number; }
export interface ElevatorLink { id: number; name: string; stops: [ElevatorStop, ElevatorStop]; }
export interface BoxCollider { x: number; z: number; hx: number; hz: number; yaw?: number; h?: number; }
export interface CircleCollider { x: number; z: number; r: number; h?: number; }
export interface VehicleCollider { x: number; z: number; yaw: number; hx: number; hz: number; h: number; }

export type LevelTheme = 'office' | 'warehouse' | 'hotel' | 'bank' | 'club' | 'raid' | 'tower';
export type ObjectiveKind = 'clear' | 'hostage' | 'bomb';
export interface EntryPoint { name: string; x: number; z: number; yaw: number; }

export interface Level {
  index: number; name: string; brief: string; theme: LevelTheme; objective: ObjectiveKind;
  w: number; h: number; cells: Uint8Array; groundY: Float32Array;
  doors: Door[]; doorAt: Map<number, Door>;
  windows: (Pt & { floorY?: number })[];
  rooms: Room[]; props: Prop[]; propAt: Map<number, Prop>;
  staircases: Staircase[]; elevators: ElevatorLink[];
  breaker?: Pt & { floorY?: number };
  bomb?: Pt & { time: number; floorY?: number };
  vehicle?: VehicleCollider;
  extBoxes: BoxCollider[];
  extCircles: CircleCollider[];
  playerSpawn: Pt & { yaw: number };
  entries: EntryPoint[];
  suspects: (Pt & { room: number; hostage?: boolean })[];
  civs: (Pt & { room: number; vip?: boolean })[];
}

/** Physical floor height in world metres at any walkable plan position. Stair surfaces interpolate smoothly between their landings. */
export function groundHeightAt(l: Pick<Level, 'w' | 'h' | 'groundY' | 'staircases'>, x: number, z: number): number {
  for (const s of l.staircases) {
    const dx = s.x1 - s.x0, dz = s.z1 - s.z0, len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) continue;
    const t = ((x - s.x0) * dx + (z - s.z0) * dz) / len2;
    if (t < -0.03 || t > 1.03) continue;
    const lateral = Math.abs((x - s.x0) * dz - (z - s.z0) * dx) / Math.sqrt(len2);
    if (lateral <= s.width * 0.5) return s.fromY + Math.max(0, Math.min(1, t)) * (s.toY - s.fromY);
  }
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= l.w || cz >= l.h) return 0;
  return l.groundY[cz * l.w + cx] ?? 0;
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
  cells: Uint8Array; groundY: Float32Array; doors: Door[] = []; windows: (Pt & { floorY?: number })[] = []; rooms: Room[] = []; props: Prop[] = [];
  staircases: Staircase[] = []; elevators: ElevatorLink[] = [];
  breaker?: Pt & { floorY?: number }; bomb?: Pt & { time: number; floorY?: number };
  vehicle?: VehicleCollider;
  extBoxes: BoxCollider[] = [];
  extCircles: CircleCollider[] = [];
  entries: EntryPoint[] = [];
  constructor(public w: number, public h: number) {
    this.cells = new Uint8Array(w * h); this.groundY = new Float32Array(w * h);
    for (let x = 0; x < w; x++) { this.set(x, 0, WALL); this.set(x, h - 1, WALL); }
    for (let z = 0; z < h; z++) { this.set(0, z, WALL); this.set(w - 1, z, WALL); }
  }
  set(x: number, z: number, v: number) { this.cells[z * this.w + x] = v; }
  get(x: number, z: number) { return x < 0 || z < 0 || x >= this.w || z >= this.h ? WALL : this.cells[z * this.w + x]; }
  room(x: number, z: number, w: number, h: number, name: string, kind: RoomKind, floor: FloorKind, spawn = true, floorY = 0) {
    for (let i = x; i < x + w; i++) for (let j = z; j < z + h; j++) {
      const edge = i === x || j === z || i === x + w - 1 || j === z + h - 1;
      this.set(i, j, edge ? WALL : FLOOR);
      this.groundY[j * this.w + i] = floorY;
    }
    this.rooms.push({ id: this.rooms.length, name, x, z, w, h, floor, kind, spawn, floorY });
  }
  staircase(x0: number, z0: number, x1: number, z1: number, width: number, fromY: number, toY: number) {
    const length = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(4, Math.round(length / 0.36));
    const ramp = { x0, z0, x1, z1, width, fromY, toY, steps };
    this.staircases.push(ramp);
    const minX = Math.floor(Math.min(x0, x1) - width / 2), maxX = Math.ceil(Math.max(x0, x1) + width / 2);
    const minZ = Math.floor(Math.min(z0, z1) - width / 2), maxZ = Math.ceil(Math.max(z0, z1) + width / 2);
    for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
      if (x < 1 || z < 1 || x >= this.w - 1 || z >= this.h - 1) continue;
      const h = groundHeightAt({ w: this.w, h: this.h, groundY: this.groundY, staircases: [ramp] }, x + 0.5, z + 0.5);
      const dx = x + 0.5 - x0, dz = z + 0.5 - z0;
      const t = (dx * (x1 - x0) + dz * (z1 - z0)) / (length * length);
      const lateral = Math.abs(dx * (z1 - z0) - dz * (x1 - x0)) / (length || 1);
      if (t >= -0.1 && t <= 1.1 && lateral <= width / 2) { this.set(x, z, FLOOR); this.groundY[z * this.w + x] = h; }
    }
  }
  elevator(name: string, a: ElevatorStop, b: ElevatorStop) { this.elevators.push({ id: this.elevators.length, name, stops: [a, b] }); }
  door(cx: number, cz: number, locked = false) {
    if (this.doors.some(d => d.cx === cx && d.cz === cz)) return;
    const horiz = this.get(cx - 1, cz) === WALL && this.get(cx + 1, cz) === WALL;
    this.set(cx, cz, DOOR);
    this.doors.push({ id: this.doors.length, cx, cz, horiz, floorY: this.groundY[cz * this.w + cx], open: 0, target: 0, locked });
  }
  win(cx: number, cz: number) {
    if (this.get(cx, cz) !== WALL) return;
    this.set(cx, cz, WINDOW);
    this.windows.push({ x: cx + 0.5, z: cz + 0.5, floorY: this.groundY[cz * this.w + cx] });
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
  nearWindow(x: number, z: number) {
    return this.get(x + 1, z) === WINDOW || this.get(x - 1, z) === WINDOW
      || this.get(x, z + 1) === WINDOW || this.get(x, z - 1) === WINDOW;
  }
  nearBreaker(x: number, z: number) {
    return !!this.breaker && Math.abs(x + 0.5 - this.breaker.x) < 1.2 && Math.abs(z + 0.5 - this.breaker.z) < 1.2;
  }
  nearElevator(x: number, z: number) {
    return this.elevators.some(e => e.stops.some(s => Math.abs(x + 0.5 - s.x) < 1.3 && Math.abs(z + 0.5 - s.z) < 1.3));
  }
  /** True in the open floor in front of an elevator landing, which must stay clear for the doors. */
  nearElevatorLanding(x: number, z: number, deep = 2.8, wide = 1.4) {
    return this.elevators.some(e => e.stops.some(s => {
      const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
      const dx = x + 0.5 - s.x, dz = z + 0.5 - s.z;
      const along = dx * fx + dz * fz;
      const across = Math.abs(dx * fz - dz * fx);
      return along > -1.4 && along < deep && across < wide;
    }));
  }
  /** True around a stair landing, where furniture would crowd the squad queuing for the flight. */
  nearStairLanding(x: number, z: number, r = 3.4) {
    return this.staircases.some(s =>
      Math.hypot(x + 0.5 - s.x0, z + 0.5 - s.z0) < r || Math.hypot(x + 0.5 - s.x1, z + 0.5 - s.z1) < r);
  }
  /** True inside a stair flight plus a little shoulder room, where furniture would clip the treads or rails. */
  nearStair(x: number, z: number, clear = 1.1) {
    return this.staircases.some(s => {
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0, len2 = dx * dx + dz * dz;
      if (len2 < 1e-6) return false;
      const px = x + 0.5 - s.x0, pz = z + 0.5 - s.z0;
      const t = (px * dx + pz * dz) / len2, lat = Math.abs(px * dz - pz * dx) / Math.sqrt(len2);
      return t >= -0.15 && t <= 1.15 && lat <= s.width / 2 + clear;
    });
  }
  placeBreaker(x: number, z: number) {
    this.breaker = { x: x + 0.5, z: z + 0.5, floorY: this.groundY[z * this.w + x] };
  }
  private propSpan(kind: PropKind, rot: number): [number, number] {
    if (kind === 'pc' || kind === 'bed') return [2, 2];
    if (kind === 'sofa' || kind === 'desk' || kind === 'bar' || kind === 'locker') return rot % 2 === 0 ? [2, 1] : [1, 2];
    return [1, 1];
  }
  private frontClear(x: number, z: number, w: number, d: number, rot: number): boolean {
    if (rot === 0) {
      for (let ix = x; ix < x + w; ix++) if (this.get(ix, z + d) !== FLOOR) return false;
    } else if (rot === 2) {
      for (let ix = x; ix < x + w; ix++) if (this.get(ix, z - 1) !== FLOOR) return false;
    } else if (rot === 1) {
      for (let iz = z; iz < z + d; iz++) if (this.get(x + w, iz) !== FLOOR) return false;
    } else {
      for (let iz = z; iz < z + d; iz++) if (this.get(x - 1, iz) !== FLOOR) return false;
    }
    return true;
  }
  private boxWallRot(r: Room, x: number, z: number, w: number, d: number): number | null {
    let n = true, s = true, we = true, ea = true;
    for (let ix = x; ix < x + w; ix++) { if (this.get(ix, z - 1) !== WALL) n = false; if (this.get(ix, z + d) !== WALL) s = false; }
    for (let iz = z; iz < z + d; iz++) { if (this.get(x - 1, iz) !== WALL) we = false; if (this.get(x + w, iz) !== WALL) ea = false; }
    if (n && !s) return 0;
    if (s && !n) return 2;
    if (we && !ea) return 1;
    if (ea && !we) return 3;
    // Also check partial wall contact (e.g. corner) so furniture back never points into a wall
    if (z === r.z + 1) return 0;
    if (z + d === r.z + r.h - 1) return 2;
    if (x === r.x + 1) return 1;
    if (x + w === r.x + r.w - 1) return 3;
    return null;
  }
  private tryPlace(r: Room, x: number, z: number, kind: PropKind, high: boolean, rot: number, sx: number, sz: number, needFrontClear = true, requireWall = false): boolean {
    const [w, d] = this.propSpan(kind, rot);
    // Clamp multi-cell anchor inward by 1 cell if near room East/South wall so edge hits still succeed
    const cx = Math.min(x, r.x + r.w - 1 - w), cz = Math.min(z, r.z + r.h - 1 - d);
    if (cx < r.x + 1 || cz < r.z + 1) return false;
    // Align orientation to any contacted wall if square or compatible parity
    const wallSide = this.boxWallRot(r, cx, cz, w, d);
    if (wallSide === null && requireWall) return false;
    if (wallSide !== null) {
      const [ww, wd] = this.propSpan(kind, wallSide);
      if (ww === w && wd === d) rot = wallSide;
      else if (kind === 'pc' || kind === 'bed' || kind === 'chair' || kind === 'plant' || kind === 'shelf' || kind === 'server') rot = wallSide;
    }
    const blockWin = high || kind === 'sofa' || kind === 'desk' || kind === 'bed' || kind === 'bar' || kind === 'pc';
    const reserved = (ix: number, iz: number) => (Math.abs(ix - sx) <= 1 && Math.abs(iz - sz) <= 1)
      || this.entries.some(e => Math.abs(ix - Math.floor(e.x)) <= 1 && Math.abs(iz - Math.floor(e.z)) <= 1);
    for (let iz = cz; iz < cz + d; iz++) for (let ix = cx; ix < cx + w; ix++) {
      // Never furnish the player spawn or a co-op entry: actors start standing there.
      if (reserved(ix, iz)) return false;
      if (this.get(ix, iz) !== FLOOR || this.nearDoor(ix, iz) || this.nearBreaker(ix, iz) || this.nearElevator(ix, iz) || this.nearStair(ix, iz) || this.nearStairLanding(ix, iz) || this.nearElevatorLanding(ix, iz)) return false;
      if (blockWin && this.nearWindow(ix, iz)) return false;
      if (this.bomb && Math.abs(ix + 0.5 - this.bomb.x) < 1.5 && Math.abs(iz + 0.5 - this.bomb.z) < 1.5) return false;
    }
    if (needFrontClear && kind !== 'crate' && kind !== 'plant' && !this.frontClear(cx, cz, w, d, rot)) return false;
    const cell = high ? HIGH : LOW;
    for (let iz = cz; iz < cz + d; iz++) for (let ix = cx; ix < cx + w; ix++) this.set(ix, iz, cell);
    if (!this.connected(sx, sz)) {
      for (let iz = cz; iz < cz + d; iz++) for (let ix = cx; ix < cx + w; ix++) this.set(ix, iz, FLOOR);
      return false;
    }
    this.props.push({ cx, cz, kind, rot, w, d, floorY: this.groundY[cz * this.w + cx] });
    return true;
  }
  /** Rot that puts a prop's back against the wall on that side (0 north, 1 east, 2 south, 3 west). */
  private backToWall(side: number): number {
    return [0, 3, 2, 1][side] ?? 0;
  }
  /** Rot that turns a prop towards the middle of its room, so nothing stares at a wall. */
  private faceRoom(r: Room, x: number, z: number): number {
    const cx = r.x + r.w / 2 - (x + 0.5), cz = r.z + r.h / 2 - (z + 0.5);
    if (Math.abs(cx) > Math.abs(cz)) return cx > 0 ? 1 : 3;
    return cz > 0 ? 0 : 2;
  }
  /** Free floor cells of a room, split into cells that touch a wall and cells that do not. */
  private freeCells(r: Room, rng: () => number) {
    const wall: { x: number; z: number; side: number }[] = [];
    const open: { x: number; z: number }[] = [];
    for (let z = r.z + 1; z < r.z + r.h - 1; z++) {
      for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
        if (this.get(x, z) !== FLOOR) continue;
        const side = this.wallSide(x, z);
        if (side < 0) open.push({ x, z });
        else wall.push({ x, z, side });
      }
    }
    const shuffle = <T,>(a: T[]) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    return { wall: shuffle(wall), open: shuffle(open) };
  }
  /** The side a wall touches a free cell, or -1 when the cell stands in the open. */
  private wallSide(x: number, z: number): number {
    const n = this.get(x, z - 1) === WALL, e = this.get(x + 1, z) === WALL;
    const s = this.get(x, z + 1) === WALL, w = this.get(x - 1, z) === WALL;
    if (n && !s) return 0;
    if (s && !n) return 2;
    if (e && !w) return 1;
    if (w && !e) return 3;
    if (n) return 0;
    if (s) return 2;
    if (e) return 1;
    if (w) return 3;
    return -1;
  }
  /**
   * Furniture that belongs against a wall (sofas, desks, beds, shelves, lockers, bars) is only
   * ever placed on a cell that touches a wall, with its back to it and its front into the room.
   * Floor pieces (chairs, poufs, crates, plants) are placed afterwards and turn towards the room.
   */
  furnish(rng: () => number, spawn: Pt) {
    const sx = Math.floor(spawn.x), sz = Math.floor(spawn.z);
    /** What belongs against a wall, in the order we would like to see it. */
    const wallKit: Record<RoomKind, [PropKind, boolean][]> = {
      office: [['pc', true], ['desk', false], ['shelf', true], ['server', true], ['plant', false], ['chair', false], ['locker', true]],
      lobby: [['sofa', false], ['plant', false], ['shelf', true], ['chair', false], ['desk', false], ['locker', true]],
      club: [['bar', false], ['sofa', false], ['plant', false], ['chair', false], ['shelf', true]],
      bedroom: [['bed', false], ['locker', true], ['shelf', true], ['sofa', false], ['plant', false], ['desk', false], ['chair', false]],
      storage: [['shelf', true], ['shelf', true], ['crate', false], ['locker', true], ['plant', false]],
      vault: [['locker', true], ['locker', true], ['crate', false], ['shelf', true]],
      warehouse: [['crate', false], ['crate', false], ['shelf', true], ['locker', true]],
      // Corridors used to get one lonely plant; they now hold benches, lockers and greenery.
      corridor: [['plant', false], ['shelf', true], ['locker', true], ['chair', false], ['sofa', false], ['crate', false]],
    };
    /** Free-standing pieces that are happy in the middle of a room. */
    const floorKit: Record<RoomKind, [PropKind, boolean][]> = {
      office: [['chair', false], ['plant', false], ['crate', false]],
      lobby: [['chair', false], ['plant', false], ['sofa', false]],
      club: [['chair', false], ['plant', false]],
      bedroom: [['chair', false], ['plant', false]],
      storage: [['crate', false], ['crate', true], ['chair', false]],
      vault: [['crate', false], ['crate', true]],
      warehouse: [['crate', false], ['crate', true], ['chair', false]],
      corridor: [['plant', false], ['crate', false]],
    };
    for (const r of this.rooms) {
      const area = (r.w - 2) * (r.h - 2);
      let budget = r.kind === 'corridor' ? Math.floor(area / 12)
        : r.kind === 'warehouse' ? Math.floor(area / 7)
        : r.kind === 'club' ? Math.floor(area / 7)
        : r.kind === 'vault' ? Math.floor(area / 7)
        : r.kind === 'lobby' ? Math.floor(area / 6)
        : Math.floor(area / 4);
      if (budget <= 0) continue;
      const { wall, open } = this.freeCells(r, rng);

      // 1. wall furniture: back to the wall, facing the room
      for (const c of wall) {
        if (budget <= 0) break;
        if (this.get(c.x, c.z) !== FLOOR) continue;
        const kit = wallKit[r.kind];
        const start = Math.floor(rng() * kit.length);
        for (let i = 0; i < kit.length; i++) {
          const [kind, high] = kit[(start + i) % kit.length];
          // the first choice at a wall is usually the biggest piece that fits the room
          if (this.tryPlace(r, c.x, c.z, kind, high, this.backToWall(c.side), sx, sz, true, true)) {
            budget--;
            // a desk chair in front of a desk, turned towards it
            if (kind === 'desk' || kind === 'pc') this.addDeskChair(r, c.x, c.z, c.side, sx, sz);
            break;
          }
        }
      }

      // 2. free-standing pieces left over, facing into the room
      for (const c of open) {
        if (budget <= 0) break;
        if (this.get(c.x, c.z) !== FLOOR) continue;
        const kit = floorKit[r.kind];
        if (!kit.length) break;
        const start = Math.floor(rng() * kit.length);
        for (let i = 0; i < kit.length; i++) {
          const [kind, high] = kit[(start + i) % kit.length];
          if (this.tryPlace(r, c.x, c.z, kind, high, this.faceRoom(r, c.x, c.z), sx, sz, true, false)) {
            budget--;
            break;
          }
        }
      }
    }
  }
  /** Pulls a chair up to a desk that stands against a wall, facing the desk. */
  private addDeskChair(r: Room, x: number, z: number, side: number, sx: number, sz: number) {
    const [dx, dz] = side === 0 ? [0, 1] : side === 2 ? [0, -1] : side === 1 ? [-1, 0] : [1, 0];
    for (const [ox, oz] of [[0, 0], [dx, dz], [dx * 2, dz * 2]]) {
      const cx = x + ox, cz = z + oz;
      if (this.get(cx, cz) !== FLOOR || this.nearDoor(cx, cz)) continue;
      // chair looks back at the desk: face opposite the desk's facing direction
      const back = side === 0 ? 2 : side === 2 ? 0 : side === 1 ? 3 : 1;
      if (this.tryPlace(r, cx, cz, 'chair', false, back, sx, sz, false, false)) return;
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
    brief: 'Armed suspects have entered an accounting office in Kista. At least three employees are held inside. Glass partitions let you scout the meeting room — use your FiberCam, breach or flashbangs to arrest everyone cleanly.',
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
      // Exterior solid colliders + Marauder armored SWAT truck staged cleanly on the front plaza
      b.extCircles.push({ x: 12.5, z: 21.45, r: 0.34, h: 3.1 }, { x: 16.5, z: 21.45, r: 0.34, h: 3.1 }); // portico pillars
      for (const bx of [10.4, 11.7, 12.8, 16.2]) b.extCircles.push({ x: bx, z: 22.85, r: 0.16, h: 0.85 }); // bollards
      b.extBoxes.push({ x: 10.5, z: 21.45, hx: 0.61, hz: 0.28, h: 1.0 }, { x: 17.4, z: 21.45, hx: 0.61, hz: 0.28, h: 1.0 }); // planters
      b.extCircles.push({ x: 8.5, z: 22.0, r: 0.44, h: 2.6 }, { x: 27.0, z: 22.2, r: 0.44, h: 2.6 }); // courtyard trees
      b.extCircles.push({ x: 6.5, z: 25.4, r: 0.14, h: 4.6 }, { x: 27.5, z: 25.4, r: 0.14, h: 4.6 }); // street lamps
      b.vehicle = { x: 22.4, z: 25.4, yaw: -0.26, hx: 3.0, hz: 1.2, h: 2.43 };
      b.entries.push(
        { name: 'Front Plaza', x: 14.5, z: 24.4, yaw: 0 },
        { name: 'East Alley Door', x: 29.6, z: 12.5, yaw: Math.PI / 2 },
      );
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
      b.extBoxes.push(
        { x: 7.2, z: 27.6, hx: 2.9, hz: 1.2, yaw: 0.08, h: 5.0 },
        { x: 31.2, z: 28.0, hx: 2.9, hz: 1.2, yaw: -0.14, h: 2.5 },
      );
      b.vehicle = { x: 23.2, z: 28.2, yaw: -0.3, hx: 3.0, hz: 1.2, h: 2.43 };
      b.entries.push(
        { name: 'South Loading Dock', x: 16.5, z: 29.0, yaw: 0 },
        { name: 'West Loading Door', x: 2.0, z: 12.5, yaw: -Math.PI / 2 },
      );
      return { x: 16.5, z: 29.0, yaw: 0 };
    },
  },
  {
    name: 'Hotel North Star', theme: 'hotel', objective: 'clear', w: 46, h: 32, suspects: 10, civs: 6,
    brief: 'An armed group has barricaded itself inside Hotel North Star with guests held across multiple rooms. Stack up on doors, peek with the FiberCam and clear room by room.',
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
      b.extCircles.push({ x: 20.4, z: 25.4, r: 0.36, h: 3.3 }, { x: 24.6, z: 25.4, r: 0.36, h: 3.3 }); // brass columns
      b.extBoxes.push({ x: 18.6, z: 25.5, hx: 0.61, hz: 0.28, h: 1.0 }, { x: 26.4, z: 25.5, hx: 0.61, hz: 0.28, h: 1.0 }); // planters
      b.extCircles.push({ x: 16.2, z: 25.8, r: 0.45, h: 2.7 }, { x: 36.6, z: 26.2, r: 0.45, h: 2.7 }); // courtyard trees
      b.vehicle = { x: 31.8, z: 28.2, yaw: -0.25, hx: 3.0, hz: 1.2, h: 2.43 };
      b.entries.push(
        { name: 'Hotel Main Lobby', x: 22.5, z: 29.0, yaw: 0 },
        { name: 'East Fire Exit', x: 43.4, z: 14.5, yaw: Math.PI / 2 },
      );
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
      b.door(4, 19);
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
      for (const cx of [11.2, 13.4, 17.6, 19.8]) b.extCircles.push({ x: cx, z: 25.6, r: 0.46, h: 6.4 }); // fluted bank columns
      for (const bx of [9.6, 11.2, 12.8, 18.2, 19.8]) b.extCircles.push({ x: bx, z: 27.1, r: 0.16, h: 0.85 }); // bollards
      b.extBoxes.push({ x: 12.3, z: 25.7, hx: 0.61, hz: 0.28, h: 1.0 }, { x: 18.7, z: 25.7, hx: 0.61, hz: 0.28, h: 1.0 }); // planters
      b.extCircles.push({ x: 7.8, z: 26.2, r: 0.45, h: 2.7 }, { x: 30.8, z: 26.2, r: 0.45, h: 2.7 }); // courtyard trees
      b.vehicle = { x: 25.8, z: 28.3, yaw: -0.25, hx: 3.0, hz: 1.2, h: 2.43 };
      b.entries.push(
        { name: 'Bank Front Steps', x: 15.5, z: 29.0, yaw: 0 },
        { name: 'West Side Entrance', x: 2.0, z: 19.5, yaw: -Math.PI / 2 },
      );
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
      b.door(35, 17, true);
      b.win(16, 10); b.win(20, 10); b.win(11, 23); b.win(15, 23);
      b.placeBreaker(24, 22);
      b.bomb = { x: 31.5, z: 16.5, time: 165 };
      b.extBoxes.push(
        { x: 5.5, z: 27.0, hx: 0.6, hz: 3.0, h: 6.5 }, // left alley brick wall
        { x: 24.0, z: 27.0, hx: 0.6, hz: 3.0, h: 6.5 }, // right alley brick wall (widened so truck fits cleanly)
        { x: 7.6, z: 24.6, hx: 0.61, hz: 0.28, h: 1.0 },
        { x: 15.2, z: 24.6, hx: 0.61, hz: 0.28, h: 1.0 },
      );
      b.vehicle = { x: 19.2, z: 27.4, yaw: -0.38, hx: 3.0, hz: 1.2, h: 2.43 };
      b.entries.push(
        { name: 'Main Club Entrance', x: 13.5, z: 27.8, yaw: 0 },
        { name: 'Backstage Alley (Locked)', x: 37.5, z: 17.5, yaw: Math.PI / 2 },
      );
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
      while (x < 35) {
        const rem = 36 - x;
        const rw = rem <= 12 ? rem : 6 + Math.floor(rng() * Math.min(5, rem - 11));
        const kind = northKinds[(ni + Math.floor(rng() * 3)) % northKinds.length];
        const floor: FloorKind = kind === 'storage' || kind === 'vault' ? 'concrete' : rng() < 0.5 ? 'carpet' : 'wood';
        b.room(x, 3, rw, 9, northNames[ni % northNames.length], kind, floor, true);
        const dx = x + 2 + Math.floor(rng() * Math.max(1, rw - 4));
        b.door(dx, cz, rng() < 0.3);
        if (rw >= 7 && rng() < 0.65) {
          const wx = dx + (dx + 2 < x + rw - 1 ? 2 : -2);
          if (wx > x && wx < x + rw - 1) b.win(wx, cz);
        }
        if (x > 4 && rng() < 0.45) {
          const idz = 6 + Math.floor(rng() * 3);
          if (b.get(x - 1, idz) === FLOOR && b.get(x + 1, idz) === FLOOR) b.door(x, idz);
        }
        x += rw - 1;
        ni++;
        if (rem <= 12) break;
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
      const sx = lx + 4.5, sz = cz + ch + 10.2, fz = sz - 1.5;
      for (let fx = 3.0; fx <= 37.0; fx += 2.0) {
        if (Math.abs(fx - sx) < 2.6) continue;
        b.extBoxes.push({ x: fx, z: fz, hx: 1.0, hz: 0.08, h: 2.3 });
      }
      b.extBoxes.push({ x: 5.0, z: fz + 0.3, hx: 0.14, hz: 0.14, h: 7.5 }, { x: 36.2, z: fz + 0.3, hx: 0.14, hz: 0.14, h: 7.5 });
      b.extCircles.push({ x: 4.5, z: fz + 1.4, r: 0.44, h: 2.6 }, { x: 36.6, z: fz + 1.4, r: 0.44, h: 2.6 });
      b.vehicle = { x: Math.min(31.2, sx + 5.8), z: Math.min(b.h - 3.3, fz + 2.75), yaw: -0.25, hx: 3.0, hz: 1.2, h: 2.43 };
      b.entries.push(
        { name: 'South Plaza', x: sx, z: sz, yaw: 0 },
        { name: 'West Side Breach', x: 2.0, z: cz + 2.5, yaw: -Math.PI / 2 },
      );
      return { x: sx, z: sz, yaw: 0 };
    },
  },
  {
    name: 'Kista Tech Center', theme: 'tower', objective: 'hostage', w: 58, h: 40, suspects: 7, civs: 6,
    brief: 'A coordinated crew has seized the Kista Tech Center. Clear a dense ground-floor office, then push up the full stairwell or use the service elevator to reach the command floor and rescue the VIP.',
    build(b) {
      // Ground floor: six linked rooms around a service spine.
      b.room(3, 3, 11, 10, 'Main Atrium', 'lobby', 'tile', false, 0);
      b.room(13, 3, 13, 10, 'Records & HR', 'office', 'carpet', true, 0);
      b.room(3, 12, 11, 10, 'Briefing & Training', 'office', 'wood', true, 0);
      b.room(13, 12, 13, 10, 'Operations Floor', 'office', 'carpet', true, 0);
      b.room(3, 21, 11, 12, 'Evidence Intake', 'storage', 'concrete', true, 0);
      b.room(13, 21, 13, 12, 'Armory & Dispatch', 'office', 'tile', true, 0);
      b.room(25, 3, 8, 30, 'F1 Service Spine', 'corridor', 'tile', false, 0);

      // The command floor occupies the east wing at a real 3m elevation.
      b.room(33, 3, 11, 11, 'Control Room · F2', 'office', 'carpet', true, 3);
      b.room(43, 3, 13, 11, 'Executive Suite · F2', 'office', 'wood', true, 3);
      b.room(33, 13, 23, 5, 'Command Spine · F2', 'corridor', 'tile', false, 3);
      // Optional side wing: no objectives spawn here, so the sweep can end when the VIP wing is clear.
      b.room(33, 17, 11, 16, 'Server Farm · F2', 'storage', 'concrete', false, 3);
      b.room(43, 17, 13, 16, 'Hostage Wing · F2', 'bedroom', 'wood', true, 3);

      // A 7.5m stair flight rises 3m and lands flush with the F2 floor edge (x=33), so the top
      // step is not buried under the command floor. It is a real walkable route both ways.
      b.staircase(25.5, 15.5, 33.0, 15.5, 2.3, 0, 3);
      // Open the bottom landing into Operations Floor: without this the flight ends half a
      // metre from the service-spine wall with no exit. Three cells match the 2.3m flight.
      b.set(25, 14, FLOOR); b.set(25, 15, FLOOR); b.set(25, 16, FLOOR);
      // The F2 command spine starts at x = 33, so its west wall would cover the top tread.
      // Open the three cells the 2.3 m flight crosses, making the landing a real stair doorway.
      b.set(33, 14, FLOOR); b.set(33, 15, FLOOR); b.set(33, 16, FLOOR);

      // Door graph: several loops and side rooms on both storeys.
      b.door(8, 12); b.door(13, 7); b.door(13, 17); b.door(8, 21); b.door(13, 27);
      b.door(25, 7); b.door(25, 17); b.door(25, 27, true);
      b.door(8, 32); b.door(3, 17);
      b.door(43, 8); b.door(38, 13); b.door(49, 13);
      b.door(38, 17); b.door(49, 17); b.door(43, 24, true); b.door(55, 27);
      b.win(7, 32); b.win(10, 32); b.win(36, 32); b.win(48, 32); b.win(51, 32);

      // Paired stops are steel doors set into a wall, not a cabin standing on the floor: both face
      // south out of the north wall, clear of the stair landing at z = 15.5 on both storeys.
      b.elevator('Service elevator',
        { x: 30.5, z: 4.6, floorY: 0, label: 'FLOOR 1', yaw: Math.PI },
        { x: 37.5, z: 4.6, floorY: 3, label: 'FLOOR 2', yaw: Math.PI },
      );
      b.placeBreaker(5, 25);
      b.entries.push(
        { name: 'South Atrium Entrance', x: 8.5, z: 36.2, yaw: 0 },
        { name: 'West Emergency Door', x: 1.9, z: 17.5, yaw: Math.PI / 2 },
      );
      return { x: 8.5, z: 36.2, yaw: 0 };
    },
  },
];

export const MISSIONS = SPECS.map(s => ({ name: s.name, brief: s.brief, suspects: s.suspects, civs: s.civs, objective: s.objective }));

export function buildLevel(index: number, seed: number): Level {
  const spec = SPECS[index % SPECS.length];
  const rng = mulberry32(seed * 7919 + index * 104729 + 13);
  const b = new Builder(spec.w, spec.h);
  const spawn = spec.build(b, rng);
  const entries = b.entries.length ? b.entries : [{ name: 'Main Entrance', x: spawn.x, z: spawn.z, yaw: spawn.yaw }];
  b.furnish(rng, spawn);
  const doorAt = new Map<number, Door>();
  for (const d of b.doors) doorAt.set(d.cz * b.w + d.cx, d);
  const propAt = new Map<number, Prop>();
  for (const pr of b.props) {
    const pw = pr.w ?? 1, pd = pr.d ?? 1;
    for (let iz = 0; iz < pd; iz++) for (let ix = 0; ix < pw; ix++) {
      propAt.set((pr.cz + iz) * b.w + (pr.cx + ix), pr);
    }
  }
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
      if (b.get(x, z) !== FLOOR || used.has(k) || b.nearDoor(x, z, 1) || b.nearElevator(x, z)) continue;
      // Keep spawned people out of the bomb's collision footprint; the runtime physics layer also
      // enforces this for manual/extra spawns, but generated positions should start cleanly too.
      if (b.bomb && Math.hypot(x + 0.5 - b.bomb.x, z + 0.5 - b.bomb.z) < 0.82) continue;
      if (Math.hypot(x + 0.5 - spawn.x, z + 0.5 - spawn.z) < 7) { ri++; continue; }
      used.add(k); out.push({ x: x + 0.5, z: z + 0.5, room: r.id }); ri++;
    }
    return out;
  };
  const suspects = place(spec.suspects).map((s, i) => ({ ...s, hostage: spec.objective === 'hostage' && i === 0 }));
  // The Kista operation's VIP is always held in the upper-floor hostage wing, so the stair/elevator
  // route is part of the objective instead of optional scenery.
  if (spec.name === 'Kista Tech Center' && suspects[0]) {
    const hostRoom = b.rooms.find(r => r.name === 'Hostage Wing · F2');
    if (hostRoom) {
      const old = suspects[0]; used.delete(Math.floor(old.z) * b.w + Math.floor(old.x));
      const spots: { x: number; z: number; d: number }[] = [];
      for (let z = hostRoom.z + 1; z < hostRoom.z + hostRoom.h - 1; z++) for (let x = hostRoom.x + 1; x < hostRoom.x + hostRoom.w - 1; x++) {
        const key = z * b.w + x;
        if (b.get(x, z) !== FLOOR || used.has(key) || b.nearDoor(x, z, 1)) continue;
        const d = Math.hypot(x + 0.5 - (hostRoom.x + hostRoom.w / 2), z + 0.5 - (hostRoom.z + hostRoom.h / 2));
        spots.push({ x, z, d });
      }
      spots.sort((a, b) => a.d - b.d);
      const spot = spots[0];
      if (spot) {
        used.add(spot.z * b.w + spot.x);
        suspects[0] = { x: spot.x + 0.5, z: spot.z + 0.5, room: hostRoom.id, hostage: true };
      }
    }
  }
  const civs = place(spec.civs).map((c, i) => {
    if (spec.objective === 'hostage' && i === 0 && suspects[0]) {
      return { x: suspects[0].x, z: suspects[0].z, room: suspects[0].room, vip: true };
    }
    return { ...c, vip: false };
  });
  const objective: ObjectiveKind = b.bomb ? 'bomb' : spec.objective;
  return {
    index, name: spec.name, brief: spec.brief, theme: spec.theme, objective,
    w: b.w, h: b.h, cells: b.cells, groundY: b.groundY, doors: b.doors, doorAt, windows: b.windows,
    rooms: b.rooms, props: b.props, propAt, staircases: b.staircases, elevators: b.elevators, breaker: b.breaker, bomb: b.bomb,
    vehicle: b.vehicle, extBoxes: b.extBoxes, extCircles: b.extCircles,
    playerSpawn: spawn, entries, suspects, civs,
  };
}

export function roomAt(l: Level, x: number, z: number): Room | null {
  for (const r of l.rooms) if (x > r.x + 1 - 1e-6 && x < r.x + r.w - 1 && z > r.z + 1 - 1e-6 && z < r.z + r.h - 1) return r;
  return null;
}
