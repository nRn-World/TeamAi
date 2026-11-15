// TeamAi tactical simulation. Pure logic: no DOM, no three.js – runs headless in tests.
import { Level, Door, Pt, Room, buildLevel, mulberry32, roomAt, OUT, WALL, DOOR, LOW, HIGH, WINDOW } from './level';
import { findPath, nearestWalkable, walkLine } from './nav';
import { buildLocalReport } from './context';

export type Team = 'A' | 'B';
export type Action =
  | 'follow' | 'hold' | 'move' | 'cover' | 'stack' | 'breach' | 'bang'
  | 'open' | 'close' | 'restrain' | 'fireFree' | 'fireHold' | 'report'
  | 'shout' | 'joinTeam' | 'peek' | 'c2' | 'wedge' | 'defuse';
export type Dir = 'left' | 'right' | 'forward' | 'back' | 'there';
export type PrimaryLoadout = 'carbine' | 'shotgun' | 'beanbag' | 'shield';
export type SecondaryLoadout = 'pistol' | 'taser';
export interface Loadout { primary: PrimaryLoadout; secondary: SecondaryLoadout; }

/** `who` = one officer (index into Sim.officers) instead of a whole team. */
export interface Command { team: Team | 'ALL'; action: Action; dir?: Dir; who?: number; }
export const OFFICER_NAMES = ['Ken', 'Maya', 'Jack', 'Zoe']; // A1, A2, B1, B2
export const OFFICER_ROLES = ['Pointman', 'Breacher', 'Marksman', 'Negotiator'] as const;
export type OfficerRole = typeof OFFICER_ROLES[number];
/** A team, or one officer working on an order of their own. */
type Grp = Team | Actor;
export type Kind = 'player' | 'officer' | 'suspect' | 'civ';

export interface Order {
  type: 'follow' | 'hold' | 'move' | 'cover' | 'stack' | 'breach' | 'door' | 'restrain' | 'peek' | 'defuse';
  pts?: Pt[]; face?: number; door?: Door; bang?: boolean; c2?: boolean; open?: boolean;
  off?: number; leader?: Actor; phase: number; t: number; side?: number; prev?: Order;
}

export interface BombState {
  x: number; z: number; time: number; defused: boolean; defuseT: number;
  warned60?: boolean; warned20?: boolean;
}

export type Ev =
  | { t: 'shot'; by: Actor; x: number; y: number; z: number; x2: number; y2: number; z2: number; hit: 'wall' | 'actor' | 'none' }
  | { t: 'hurt'; a: Actor; head: boolean } | { t: 'death'; a: Actor }
  | { t: 'door'; door: Door; open: boolean; kick?: boolean } | { t: 'say'; a: Actor; text: string; shout?: boolean }
  | { t: 'shout'; a: Actor } | { t: 'bang'; x: number; z: number } | { t: 'throw'; x: number; z: number }
  | { t: 'c2'; x: number; z: number } | { t: 'glass'; x: number; z: number }
  | { t: 'break'; kind: 'pc' | 'server' | 'glass'; x: number; y: number; z: number }
  | { t: 'power'; on: boolean }
  | { t: 'phone'; x: number; z: number }
  | { t: 'taser'; x: number; y: number; z: number; x2: number; y2: number; z2: number }
  | { t: 'bomb'; kind: 'defused' | 'detonate'; x: number; z: number }
  | { t: 'cuff'; a: Actor; by: Actor } | { t: 'surrender'; a: Actor } | { t: 'marker'; x: number; z: number; team: Team }
  | { t: 'bark'; a: Actor; kind: 'spot' | 'surrender' | 'pain' | 'die' | 'panic' | 'unrest' }
  | { t: 'info'; text: string } | { t: 'end'; win: boolean };

export interface ReplayActor {
  id: number; kind: Kind; team: Team; x: number; z: number; alive: boolean; down: boolean; restrained: boolean;
}
export interface ReplayFrame { t: number; actors: ReplayActor[]; }
export interface ReplayEvent {
  t: number; kind: 'shot' | 'bang' | 'c2' | 'death' | 'arrest' | 'bomb';
  x: number; z: number; x2?: number; z2?: number; team?: Team;
}

export class Actor {
  x = 0; z = 0; yaw = 0; r = 0.3; hp = 100; alive = true; speed = 3.2;
  path: Pt[] | null = null; goal: Pt | null = null; repathT = 0; moving = false; stuckT = 0; walk = 0;
  stun = 0; surrendered = false; restrained = false; armed = false; morale = 0.5; rolls = 0; lastRoll = -9;
  fakeSurrender = false; fakeT = 0; wasFake = false; vip = false; hostage = false;
  target: Actor | null = null; aimT = 0; fireCd = 0; burst = 0; ammo = 30; reloadT = 0; lastShotT = -9;
  hostile = false; hasFired = false; react = -1; alertT = 0; lastSeen: Pt | null = null; hunter = false; timer = 0; lostT = 0;
  challengeT = -9; firstChallengeT = Infinity; unwatchedT = 0; panicT = 0; seeT = 0; room = -1;
  /** An order given to this officer alone; until the team gets a new order they act apart from it. */
  solo: { order: Order; cuffSay?: number } | null = null;
  role: OfficerRole = 'Pointman';
  team: Team = 'A'; ti = 0; slot = 0; cuff: Actor | null = null; cuffT = 0; claimedBy: Actor | null = null;
  defusing = false; defuseT = 0;
  prone = false; jumpY = 0; /** footstep-noise bookkeeping */ nx = 0; nz = 0; nd = 0; nt = 0;
  percT = 0; deadT = 0; crouch = false; variant = 0; flash = 0; pitch = 0; trail: Pt[] = [];
  bangs = 3; c2 = 2; wedges = 2; shield = false; nvg = false; pi = 0;
  lastCallT = -99;
  constructor(public id: number, public kind: Kind, public name: string) { }
  get down() { return this.surrendered || this.restrained; }
  get active() { return this.alive && !this.restrained; }
}

export const fwd = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
export const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz);
export const angDiff = (a: number, b: number) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const turn = (a: number, b: number, max: number) => { const d = angDiff(a, b); return a + Math.max(-max, Math.min(max, d)); };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z);

/** World-space hinged door leaf segment matching LevelView's 3D pivot & swing angle. */
export function doorLeafSegment(d: Door) {
  const hx = d.horiz ? d.cx + 0.03 : d.cx + 0.5;
  const hz = d.horiz ? d.cz + 0.5 : d.cz + 0.03;
  const theta = (d.horiz ? 0 : -Math.PI / 2) + d.open * 1.62;
  const tx = hx + Math.cos(theta) * 0.94;
  const tz = hz - Math.sin(theta) * 0.94;
  return { hx, hz, tx, tz, theta };
}

function closestOnSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const abx = bx - ax, abz = bz - az, len2 = abx * abx + abz * abz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / len2));
  const qx = ax + abx * t, qz = az + abz * t;
  const dx = px - qx, dz = pz - qz;
  return { qx, qz, dx, dz, d: Math.hypot(dx, dz) };
}

function pointInOBB(px: number, pz: number, bx: number, bz: number, hx: number, hz: number, yaw = 0, pad = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const dx = px - bx, dz = pz - bz;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) < hx + pad && Math.abs(lz) < hz + pad;
}

export interface Stats {
  shotsFired: number; suspectsKilled: number; suspectsArrested: number;
  civsSecured: number; civsKilled: number; civsKilledByPolice: number;
  officersDown: number; unauthorized: number; c2Used: number; nonLethalHits: number;
  bangsUsed?: number;
}

export class Sim {
  level: Level; rng: () => number; actors: Actor[] = []; player: Actor; officers: Actor[] = []; suspects: Actor[] = []; civs: Actor[] = [];
  events: Ev[] = []; time = 0; trail: Pt[] = []; over: { win: boolean; reason?: string } | null = null;
  teams: Record<Team, { order: Order; fire: 'free' | 'hold'; cuffSay?: number }>;
  grenades: { x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number }[] = [];
  brokenWindows = new Set<number>();
  brokenProps = new Set<number>();
  brokenDoorGlass = new Set<number>();
  powerOn = true;
  bomb: BombState | null = null;
  stats: Stats = { shotsFired: 0, suspectsKilled: 0, suspectsArrested: 0, civsSecured: 0, civsKilled: 0, civsKilledByPolice: 0, officersDown: 0, unauthorized: 0, c2Used: 0, nonLethalHits: 0, bangsUsed: 0 };
  players: Actor[] = []; private checkT = 0;
  replayFrames: ReplayFrame[] = [];
  replayEvents: ReplayEvent[] = [];
  private replayT = 0;
  private banterT = -20;
  private soloWarnT = -30;
  private lowHpWarned = false;
  private arrestStreak = 0;
  private phoneT = 10;

  constructor(public mission: number, seed: number, public difficulty = 1, nPlayers = 1) {
    this.level = buildLevel(mission, seed); this.rng = mulberry32(seed + 99);
    if (this.level.bomb) {
      this.bomb = { x: this.level.bomb.x, z: this.level.bomb.z, time: this.level.bomb.time, defused: false, defuseT: 0 };
    }
    const l = this.level, sp = l.playerSpawn; let id = 0;
    this.player = new Actor(id++, 'player', 'You'); Object.assign(this.player, { x: sp.x, z: sp.z, yaw: sp.yaw, armed: true });
    this.actors.push(this.player); this.players.push(this.player); this.player.trail.push({ x: sp.x, z: sp.z });
    OFFICER_NAMES.forEach((n, i) => {
      const o = new Actor(id++, 'officer', n);
      o.team = i < 2 ? 'A' : 'B'; o.ti = i % 2; o.slot = i; o.role = OFFICER_ROLES[i];
      o.armed = true; o.speed = i === 0 ? 4.25 : 3.9;
      if (i === 1) { o.bangs = 4; o.c2 = 3; } // Maya (Breacher) carries extra breach gear
      const p = nearestWalkable(l, sp.x + (i % 2 ? 0.9 : -0.9), sp.z + 1.1 + Math.floor(i / 2) * 1.0) ?? sp;
      o.x = sp.x + (i % 2 ? 0.8 : -0.8); o.z = sp.z + 1.0 + Math.floor(i / 2) * 0.9; if (this.solidCell(Math.floor(o.x), Math.floor(o.z))) { o.x = p.x; o.z = p.z; }
      o.yaw = sp.yaw; this.officers.push(o); this.actors.push(o);
    });
    for (const s of l.suspects) {
      const a = new Actor(id++, 'suspect', 'Suspect'); Object.assign(a, { x: s.x, z: s.z, room: s.room, armed: true, yaw: this.rng() * 6.28, speed: 3.0 });
      a.morale = 0.2 + this.rng() * 0.75 + (difficulty - 1) * 0.1; a.hunter = this.rng() < 0.45; a.variant = Math.floor(this.rng() * 6); a.timer = this.rng() * 5;
      a.hostage = !!s.hostage;
      this.suspects.push(a); this.actors.push(a);
    }
    for (const s of l.civs) {
      const a = new Actor(id++, 'civ', s.vip ? 'VIP Hostage' : 'Civilian'); Object.assign(a, { x: s.x, z: s.z, room: s.room, yaw: this.rng() * 6.28, speed: 3.4 });
      a.variant = Math.floor(this.rng() * 6); a.morale = this.rng(); a.vip = !!s.vip;
      this.civs.push(a); this.actors.push(a);
    }
    this.teams = { A: { order: { type: 'follow', phase: 0, t: 0 }, fire: 'free' }, B: { order: { type: 'follow', phase: 0, t: 0 }, fire: 'free' } };
    // extra co-op players are appended last so ids/RNG of everything else stay identical
    for (let i = 1; i < nPlayers; i++) {
      const a = new Actor(id++, 'player', 'Player ' + (i + 1)); a.pi = i; a.armed = true; a.yaw = sp.yaw;
      const q = nearestWalkable(l, sp.x + (i % 2 ? 1.6 : -1.6) * Math.ceil(i / 2), sp.z - 0.6) ?? sp; a.x = q.x; a.z = q.z; a.trail.push({ x: a.x, z: a.z });
      this.players.push(a); this.actors.push(a);
    }
    this.trail = this.player.trail;
  }
  /** Leader an order refers to; falls back to any living player. */
  private leaderOf(o: Order) { const l = o.leader; return l && l.alive ? l : (this.players.find(p => p.alive) ?? this.player); }

  // ---------- grid queries ----------
  cell(cx: number, cz: number) { const l = this.level; return cx < 0 || cz < 0 || cx >= l.w || cz >= l.h ? WALL : l.cells[cz * l.w + cx]; }
  doorAtCell(cx: number, cz: number) { return this.level.doorAt.get(cz * this.level.w + cx); }
  solidCell(cx: number, cz: number) {
    const c = this.cell(cx, cz);
    if (c === WALL || c === LOW || c === HIGH || c === WINDOW) return true;
    if (c === DOOR) return this.doorAtCell(cx, cz)!.open < 0.7;
    return false;
  }
  opaqueCell(cx: number, cz: number) {
    const c = this.cell(cx, cz);
    if (c === WALL || c === HIGH) return true;
    if (c === DOOR) return this.doorAtCell(cx, cz)!.open < 0.5;
    return false; // WINDOW and LOW allow line of sight!
  }
  isGlassDoor(d: Door) {
    const t = this.level.theme;
    return (t === 'office' || t === 'hotel' || t === 'bank') && (this.cell(d.cx, d.cz + 1) === OUT || this.cell(d.cx, d.cz - 1) === OUT);
  }
  breakWindow(cx: number, cz: number) {
    const k = cz * this.level.w + cx;
    if (this.cell(cx, cz) !== WINDOW || this.brokenWindows.has(k)) return false;
    this.brokenWindows.add(k);
    this.events.push({ t: 'glass', x: cx + 0.5, z: cz + 0.5 });
    this.noise(cx + 0.5, cz + 0.5, 16);
    return true;
  }
  private breakProp(cx: number, cz: number, x: number, y: number, z: number): boolean {
    const prop = this.level.propAt.get(cz * this.level.w + cx);
    if (!prop) return false;
    const pk = prop.cz * this.level.w + prop.cx;
    if (this.brokenProps.has(pk)) return false;
    if (prop.kind === 'pc' || prop.kind === 'desk') {
      if (y < 0.72 || y > 1.38) return false;
      this.brokenProps.add(pk);
      this.events.push({ t: 'break', kind: 'pc', x, y, z });
      this.noise(x, z, 12);
      return true;
    }
    if (prop.kind === 'server') {
      if (y < 0.35 || y > 2.2) return false;
      this.brokenProps.add(pk);
      this.events.push({ t: 'break', kind: 'server', x, y, z });
      this.noise(x, z, 14);
      return true;
    }
    if (prop.kind === 'plant') {
      if (y < 0.1 || y > 1.65) return false;
      this.brokenProps.add(pk);
      this.events.push({ t: 'break', kind: 'glass', x, y, z });
      this.noise(x, z, 10);
      return true;
    }
    return false;
  }
  los(x1: number, z1: number, x2: number, z2: number) {
    const dx = x2 - x1, dz = z2 - z1, d = Math.hypot(dx, dz), n = Math.ceil(d / 0.2);
    for (let i = 1; i < n; i++) if (this.opaqueCell(Math.floor(x1 + (dx * i) / n), Math.floor(z1 + (dz * i) / n))) return false;
    return true;
  }
  sees(a: Actor, b: Actor, range: number, fov: number) {
    let effRange = range;
    if (!this.powerOn && a.kind === 'suspect') effRange *= 0.62;
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
    if (d > effRange) return false;
    if (d > 2.5 && Math.abs(angDiff(a.yaw, yawTo(dx, dz))) > fov / 2) return false;
    return this.los(a.x, a.z, b.x, b.z);
  }
  height(a: Actor) { return a.down ? 1.15 : a.prone ? 0.55 : a.crouch ? 1.25 : 1.8; }

  private solidBodyCell(cx: number, cz: number) {
    const c = this.cell(cx, cz);
    return c === WALL || c === LOW || c === HIGH || c === WINDOW;
  }
  private hitDoorLeaf3D(x: number, y: number, z: number): Door | null {
    if (y >= 2.2) return null;
    for (const d of this.level.doors) {
      if (Math.abs(d.cx + 0.5 - x) > 1.6 || Math.abs(d.cz + 0.5 - z) > 1.6) continue;
      const seg = doorLeafSegment(d);
      if (closestOnSeg(x, z, seg.hx, seg.hz, seg.tx, seg.tz).d < 0.042) return d;
    }
    return null;
  }
  private hitExterior3D(x: number, y: number, z: number, forRay = false) {
    const l = this.level;
    if (l.vehicle) {
      let vh = l.vehicle.h;
      if (forRay) {
        const c = Math.cos(l.vehicle.yaw), s = Math.sin(l.vehicle.yaw);
        const lx = (x - l.vehicle.x) * c - (z - l.vehicle.z) * s;
        if (lx > l.vehicle.hx * 0.35) vh = Math.min(vh, 1.42); // sloping front hood
      }
      if (y < vh && pointInOBB(x, z, l.vehicle.x, l.vehicle.z, l.vehicle.hx, l.vehicle.hz, l.vehicle.yaw)) return true;
    }
    for (const b of l.extBoxes) {
      if (y < (b.h ?? 3) && pointInOBB(x, z, b.x, b.z, b.hx, b.hz, b.yaw ?? 0)) return true;
    }
    for (const cr of l.extCircles) {
      const h = cr.h ?? 3;
      if (y >= h) continue;
      if (forRay && cr.r >= 0.4 && h >= 2.5 && h <= 2.85) {
        // Courtyard tree: narrow trunk below crown, open canopy gaps above
        const r = y < 1.45 ? 0.15 : 0.3;
        if (Math.hypot(x - cr.x, z - cr.z) < r) return true;
      } else if (Math.hypot(x - cr.x, z - cr.z) < cr.r) return true;
    }
    return false;
  }
  private isCurtainWindow(cx: number, cz: number) {
    const t = this.level.theme;
    if (t !== 'office' && t !== 'hotel' && t !== 'club') return false;
    return this.cell(cx, cz + 1) === OUT || this.cell(cx, cz - 1) === OUT || this.cell(cx + 1, cz) === OUT || this.cell(cx - 1, cz) === OUT;
  }
  private rayPropHit(cx: number, cz: number, x: number, y: number, z: number, breakGlass: boolean): boolean {
    const pr = this.level.propAt.get(cz * this.level.w + cx);
    if (!pr) return y < 0.85;
    const pk = pr.cz * this.level.w + pr.cx;
    const broken = this.brokenProps.has(pk);
    const pcx = pr.cx + (pr.w ?? 1) / 2, pcz = pr.cz + (pr.d ?? 1) / 2;
    if (pr.kind === 'pc' || pr.kind === 'desk') {
      if (y <= 0.78) return true;
      if (!broken && y <= 1.24 && Math.hypot(x - pcx, z - pcz) < 0.34) {
        if (breakGlass) this.breakProp(cx, cz, x, y, z);
        return true;
      }
      return false;
    }
    if (pr.kind === 'plant') {
      const hit = broken ? (y < 0.28 && Math.hypot(x - pcx, z - pcz) < 0.34) : (y < 0.78 && Math.hypot(x - pcx, z - pcz) < 0.28);
      if (hit && breakGlass && !broken) this.breakProp(cx, cz, x, y, z);
      return hit;
    }
    if (pr.kind === 'bed') return y < 0.58;
    if (pr.kind === 'chair' || pr.kind === 'sofa') return y < 0.56;
    if (pr.kind === 'bar') return y < 1.08;
    if (pr.kind === 'server' || pr.kind === 'shelf' || pr.kind === 'locker') {
      if (y >= 2.08) return false;
      if (breakGlass && pr.kind === 'server' && !broken) this.breakProp(cx, cz, x, y, z);
      return true;
    }
    return y < 2.2;
  }
  private raySolidAt(x: number, y: number, z: number, breakGlass: boolean): boolean {
    if (y <= 0) return true;
    const l = this.level;
    const cx = Math.floor(x), cz = Math.floor(z);
    if (cx < 0 || cz < 0 || cx >= l.w || cz >= l.h) return false; // open sky/street outside bounds
    const c = l.cells[cz * l.w + cx];
    const perim = cx === 0 || cz === 0 || cx === l.w - 1 || cz === l.h - 1;
    if (perim) return y < (l.theme === 'club' ? 2.6 : 0.85);
    if (y >= 3) return c !== OUT;
    if (c === WINDOW) {
      const cw = this.isCurtainWindow(cx, cz);
      const minY = cw ? 0.12 : 0.9, maxY = cw ? 2.75 : 2.3;
      if (y >= minY && y <= maxY) {
        if (breakGlass) this.breakWindow(cx, cz);
        return false; // bullets pass through window glass!
      }
      return true;
    }
    if (c === WALL) return true;
    if (c === DOOR && y >= 2.2) return true;
    if (c === LOW || c === HIGH) return this.rayPropHit(cx, cz, x, y, z, breakGlass);
    const hitDoor = this.hitDoorLeaf3D(x, y, z);
    if (hitDoor) {
      if (this.isGlassDoor(hitDoor) && y >= 0.08 && y <= 2.12) {
        const seg = doorLeafSegment(hitDoor);
        const distHinge = Math.hypot(x - seg.hx, z - seg.hz);
        if (distHinge > 0.07 && distHinge < 0.87) {
          if (breakGlass && !this.brokenDoorGlass.has(hitDoor.id)) {
            this.brokenDoorGlass.add(hitDoor.id);
            this.events.push({ t: 'glass', x, z });
            this.noise(x, z, 16);
          }
          return false; // bullets pass through shattered door glass pane!
        }
      }
      return true;
    }
    if (this.hitExterior3D(x, y, z, true)) return true;
    return false;
  }

  /** 3D ray march against walls, props, floor/ceiling, glass windows, solid door leaves, exterior objects and actors. */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number, ignore?: Actor, breakGlass = true) {
    const step = 0.06; let x = ox, y = oy, z = oz;
    const cand = this.actors.filter(a => a.alive && a !== ignore);
    for (let d = 0; d < maxD; d += step) {
      x += dx * step; y += dy * step; z += dz * step;
      if (y > 12) break;
      if (this.raySolidAt(x, y, z, breakGlass)) {
        // Refine impact surface to < 1mm so bullet holes & sparks never float in midair
        let lo = d, hi = d + step;
        for (let i = 0; i < 6; i++) {
          const mid = (lo + hi) * 0.5;
          if (this.raySolidAt(ox + dx * mid, oy + dy * mid, oz + dz * mid, false)) hi = mid;
          else lo = mid;
        }
        const hx = ox + dx * hi, hy = Math.max(0, oy + dy * hi), hz = oz + dz * hi;
        return { kind: 'wall' as const, x: hx, y: hy, z: hz, d: hi, actor: null, head: false };
      }
      for (const a of cand) {
        const ex = x - a.x, ez = z - a.z;
        if (ex * ex + ez * ez < 0.1 && y < this.height(a)) return { kind: 'actor' as const, x, y, z, d, actor: a, head: y > this.height(a) - 0.3 };
      }
    }
    return { kind: 'none' as const, x, y, z, d: maxD, actor: null, head: false };
  }

  // ---------- movement ----------
  moveCircle(a: Actor, dx: number, dz: number) {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.15));
    for (let s = 0; s < steps; s++) { a.x += dx / steps; a.z += dz / steps; this.resolve(a); }
  }
  private resolveBox(a: Actor, bx: number, bz: number, hx: number, hz: number, yaw = 0) {
    const r = a.r, c = Math.cos(yaw), s = Math.sin(yaw);
    const dx = a.x - bx, dz = a.z - bz;
    let lx = dx * c - dz * s, lz = dx * s + dz * c;
    if (Math.abs(lx) >= hx + r || Math.abs(lz) >= hz + r) return;
    const clx = Math.max(-hx, Math.min(lx, hx)), clz = Math.max(-hz, Math.min(lz, hz));
    const ex = lx - clx, ez = lz - clz, d2 = ex * ex + ez * ez;
    if (d2 >= r * r) return;
    if (d2 < 1e-9) {
      const px = hx - Math.abs(lx), pz = hz - Math.abs(lz);
      if (px < pz) lx = (lx >= 0 ? 1 : -1) * (hx + r);
      else lz = (lz >= 0 ? 1 : -1) * (hz + r);
    } else {
      const d = Math.sqrt(d2);
      lx = clx + (ex / d) * r;
      lz = clz + (ez / d) * r;
    }
    a.x = bx + lx * c + lz * s;
    a.z = bz - lx * s + lz * c;
  }
  private resolveCirclePt(a: Actor, cx: number, cz: number, cr: number) {
    const min = a.r + cr, dx = a.x - cx, dz = a.z - cz, d2 = dx * dx + dz * dz;
    if (d2 >= min * min) return;
    if (d2 < 1e-9) { a.x = cx + min; return; }
    const d = Math.sqrt(d2);
    a.x = cx + (dx / d) * min;
    a.z = cz + (dz / d) * min;
  }
  private resolve(a: Actor, ignoreDoor?: Door) {
    const r = a.r, x0 = Math.floor(a.x - r), x1 = Math.floor(a.x + r), z0 = Math.floor(a.z - r), z1 = Math.floor(a.z + r);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      if (!this.solidBodyCell(cx, cz)) continue;
      const nx = Math.max(cx, Math.min(a.x, cx + 1)), nz = Math.max(cz, Math.min(a.z, cz + 1));
      let ex = a.x - nx, ez = a.z - nz; const d2 = ex * ex + ez * ez;
      if (d2 >= r * r) continue;
      if (d2 < 1e-9) {
        const opts: [number, number, number][] = [[a.x - cx, -1, 0], [cx + 1 - a.x, 1, 0], [a.z - cz, 0, -1], [cz + 1 - a.z, 0, 1]];
        opts.sort((p, q) => p[0] - q[0]);
        for (const [d, sx, sz] of opts) if (!this.solidBodyCell(cx + sx, cz + sz)) { a.x += sx * (d + r); a.z += sz * (d + r); break; }
        continue;
      }
      const d = Math.sqrt(d2); ex /= d; ez /= d; a.x = nx + ex * r; a.z = nz + ez * r;
    }
    // Solid hinged door leaves & door frame jambs
    for (const dr of this.level.doors) {
      if (Math.abs(dr.cx + 0.5 - a.x) > 1.8 || Math.abs(dr.cz + 0.5 - a.z) > 1.8) continue;
      if (dr.horiz) {
        this.resolveBox(a, dr.cx + 0.015, dr.cz + 0.5, 0.02, 0.5);
        this.resolveBox(a, dr.cx + 0.985, dr.cz + 0.5, 0.02, 0.5);
      } else {
        this.resolveBox(a, dr.cx + 0.5, dr.cz + 0.015, 0.5, 0.02);
        this.resolveBox(a, dr.cx + 0.5, dr.cz + 0.985, 0.5, 0.02);
      }
      if (dr === ignoreDoor) continue;
      const seg = doorLeafSegment(dr), leafR = 0.04, minD = r + leafR;
      const c = closestOnSeg(a.x, a.z, seg.hx, seg.hz, seg.tx, seg.tz);
      if (c.d >= minD) continue;
      if (c.d < 1e-5) {
        const nx = -Math.sin(seg.theta), nz = -Math.cos(seg.theta);
        a.x += nx * minD; a.z += nz * minD;
      } else {
        a.x = c.qx + (c.dx / c.d) * minD;
        a.z = c.qz + (c.dz / c.d) * minD;
      }
    }
    // Solid exterior vehicle, boxes, pillars, bollards, planters & trees
    const l = this.level;
    if (l.vehicle) this.resolveBox(a, l.vehicle.x, l.vehicle.z, l.vehicle.hx, l.vehicle.hz, l.vehicle.yaw);
    for (const b of l.extBoxes) this.resolveBox(a, b.x, b.z, b.hx, b.hz, b.yaw ?? 0);
    for (const cr of l.extCircles) this.resolveCirclePt(a, cr.x, cr.z, cr.r);
    if (this.bomb && !this.bomb.defused) this.resolveBox(a, this.bomb.x, this.bomb.z, 0.28, 0.19);
  }
  private giveWay(k: Actor, o: Actor) {
    const min = k.r + o.r; let dx = k.x - o.x, dz = k.z - o.z, d = Math.hypot(dx, dz); if (d < 1e-5) { dx = 1; dz = 0; d = 1; }
    dx /= d; dz /= d; const x0 = k.x, z0 = k.z, need = min - d;
    let best = { x: x0, z: z0, d };
    for (const [sx, sz] of [[dx, dz], [-dz, dx], [dz, -dx]]) {
      k.x = x0 + sx * need * 1.5; k.z = z0 + sz * need * 1.5; this.resolve(k);
      const e = Math.hypot(k.x - o.x, k.z - o.z); if (e > best.d + 1e-4 && !this.solidCell(Math.floor(k.x), Math.floor(k.z))) best = { x: k.x, z: k.z, d: e };
      if (sx === dx && sz === dz && e >= min - 1e-3) break;
    }
    k.x = best.x; k.z = best.z;
  }
  movePlayer(dx: number, dz: number) {
    const p = this.player; if (!p.alive) return;
    if (p.cuff || p.defusing) { dx *= 0.2; dz *= 0.2; }
    if (p.shield) { dx *= 0.78; dz *= 0.78; }
    this.moveCircle(p, dx, dz);
    for (const b of this.actors) {
      if (b === p || !b.alive) continue;
      const ox = p.x - b.x, oz = p.z - b.z, d = Math.hypot(ox, oz), min = p.r + b.r;
      if (d >= min || d < 1e-6) continue;
      if (b.down) {
        this.giveWay(b, p);
        const nd = Math.hypot(p.x - b.x, p.z - b.z);
        if (nd < min && nd > 1e-5) {
          p.x += ((p.x - b.x) / nd) * (min - nd); p.z += ((p.z - b.z) / nd) * (min - nd);
          this.resolve(p);
        }
        continue;
      }
      if (b.kind === 'officer') {
        const push = min - d;
        b.x -= (ox / d) * push * 0.35; b.z -= (oz / d) * push * 0.35;
        this.resolve(b);
      }
      const nx = p.x - b.x, nz = p.z - b.z, nd = Math.hypot(nx, nz);
      if (nd < min && nd > 1e-5) {
        p.x += (nx / nd) * (min - nd); p.z += (nz / nd) * (min - nd);
        this.resolve(p);
      }
    }
    this.pushTrail(p);
  }
  pushTrail(p: Actor) {
    const last = p.trail[p.trail.length - 1];
    if (!last || dist(last, p) > 0.5) { p.trail.push({ x: p.x, z: p.z }); if (p.trail.length > 60) p.trail.shift(); }
  }
  private trailPoint(back: number, p: Actor): Pt {
    let prev: Pt = p, acc = 0;
    for (let i = p.trail.length - 1; i >= 0; i--) {
      const t = p.trail[i], d = dist(prev, t);
      if (acc + d >= back) { const k = (back - acc) / (d || 1); return { x: prev.x + (t.x - prev.x) * k, z: prev.z + (t.z - prev.z) * k }; }
      acc += d; prev = t;
    }
    const f = fwd(p.yaw), q = { x: p.x - f.x * back, z: p.z - f.z * back };
    return walkLine(this.level, p, q) ? q : prev;
  }
  private goTo(a: Actor, x: number, z: number, dt: number, speedMul = 1, tol = 0.3): boolean {
    const d = Math.hypot(x - a.x, z - a.z);
    if (d < tol) { a.path = null; a.goal = null; a.moving = false; return true; }
    a.repathT -= dt;
    const need = !a.path || !a.goal || dist(a.goal, { x, z }) > 0.7;
    if ((need && a.repathT <= 0) || a.stuckT > 1.2) {
      const self = a;
      const blocked = a.stuckT > 1.2 ? (cx: number, cz: number) => this.actors.some(o => o !== self && o.alive && o.down && Math.floor(o.x) === cx && Math.floor(o.z) === cz) : undefined;
      a.path = findPath(this.level, a, { x, z }, blocked); a.goal = { x, z }; a.repathT = 0.35; a.stuckT = 0;
    }
    if (!a.path) { a.moving = false; return false; }
    this.followPath(a, dt, speedMul);
    return false;
  }
  private followPath(a: Actor, dt: number, speedMul: number) {
    const path = a.path; if (!path || !path.length) { a.moving = false; return; }
    const wp = path[0], dx = wp.x - a.x, dz = wp.z - a.z, d = Math.hypot(dx, dz);
    if (d < 0.18 || (path.length > 1 && d < 0.75 && walkLine(this.level, a, path[1]))) { path.shift(); if (!path.length) { a.path = null; a.moving = false; } return; }
    // doors in the way
    const f = { x: dx / d, z: dz / d };
    for (const probe of [0.5, 1.0]) {
      if (probe > d + 0.5) break;
      const cx = Math.floor(a.x + f.x * probe), cz = Math.floor(a.z + f.z * probe);
      if (this.cell(cx, cz) === DOOR) {
        const door = this.doorAtCell(cx, cz)!;
        if (door.open < 0.7) {
          if (door.wedged || (door.locked && a.kind !== 'officer')) { a.moving = false; a.path = null; a.goal = null; return; }
          const opened = this.setDoor(door, true, a.kind === 'officer' && !!door.locked, false, true);
          if (!opened && a.kind === 'officer' && door.locked && this.time - a.lastCallT > 5) {
            a.lastCallT = this.time; this.say(a, 'Door is locked!');
          }
          a.moving = false; a.yaw = turn(a.yaw, yawTo(dx, dz), 8 * dt); return;
        }
      }
    }
    // doorway etiquette: one at a time, the closest goes first
    const dw = this.cell(Math.floor(wp.x), Math.floor(wp.z)) === DOOR ? wp : path[1] && this.cell(Math.floor(path[1].x), Math.floor(path[1].z)) === DOOR ? path[1] : null;
    if (dw) {
      const md = Math.hypot(a.x - dw.x, a.z - dw.z);
      if (md < 2) for (const o of this.actors) {
        if (o === a || !o.alive || o.down || !o.moving || o.kind === 'player') continue;
        const od = Math.hypot(o.x - dw.x, o.z - dw.z);
        if (od < 1.5 && (od < md - 0.08 || (od <= md + 0.08 && o.id < a.id))) { a.moving = false; a.yaw = turn(a.yaw, yawTo(dx, dz), 6 * dt); return; }
      }
    }
    a.yaw = turn(a.yaw, yawTo(dx, dz), 9 * dt);
    const sp = a.speed * speedMul * dt, mv = Math.min(sp, d), bx = a.x, bz = a.z;
    this.moveCircle(a, f.x * mv, f.z * mv);
    const moved = Math.hypot(a.x - bx, a.z - bz);
    a.moving = true; a.walk += moved * 2.4;
    if (moved < mv * 0.3) a.stuckT += dt; else a.stuckT = Math.max(0, a.stuckT - dt * 0.5);
  }
  setDoor(door: Door, open: boolean, kick = false, force = false, quiet = false): boolean {
    const t = open ? 1 : 0;
    if (door.wedged && !force) {
      if (open && !quiet) this.events.push({ t: 'info', text: 'Door is wedged shut! Remove the wedge or blow with C2.' });
      return false;
    }
    if (door.locked && open && !kick && !force) {
      if (!quiet) this.events.push({ t: 'info', text: 'Door is locked — breach/kick it or deploy C2.' });
      return false;
    }
    if (kick || force) { door.locked = false; door.wedged = false; }
    if (door.target === t) return true;
    if (!open && this.actors.some(a => a.alive && Math.floor(a.x) === door.cx && Math.floor(a.z) === door.cz)) return false;
    door.target = t; this.events.push({ t: 'door', door, open, kick });
    return true;
  }

  // ---------- tactical door / breaker / bomb interactions ----------
  playerPeek(p = this.player): string | null {
    const it = this.interactTarget(p);
    const door = it?.door ?? this.nearestDoor(p, 2.5);
    return door ? this.peekDoor(door, p) : null;
  }
  playerWedge(p = this.player): boolean {
    const it = this.interactTarget(p);
    const door = it?.door ?? this.nearestDoor(p, 2.5);
    return door ? this.wedgeDoor(door, p) : false;
  }
  playerC2(p = this.player): boolean {
    const it = this.interactTarget(p);
    const door = it?.door ?? this.nearestDoor(p, 2.5);
    return door ? this.c2Door(door, p) : false;
  }
  peekDoor(door: Door, by: Actor): string {
    const side = this.doorSide(door, by);
    const c = { x: door.cx + 0.5, z: door.cz + 0.5 };
    const beyond = door.horiz ? { x: c.x, z: c.z - side } : { x: c.x - side, z: c.z };
    const r = roomAt(this.level, beyond.x, beyond.z);
    const inTarget = (a: Actor) => {
      if (!a.alive || a.restrained) return false;
      if (r) return roomAt(this.level, a.x, a.z)?.id === r.id;
      return dist(a, beyond) < 7;
    };
    const armed = this.suspects.filter(s => !s.down && inTarget(s)).length;
    const surr = this.suspects.filter(s => s.down && inTarget(s)).length;
    const civs = this.civs.filter(c0 => inTarget(c0)).length;
    const roomName = r?.name ?? 'beyond the door';
    const lockNote = door.locked ? ' (LOCKED)' : door.wedged ? ' (WEDGED)' : '';
    const msg = armed || civs || surr
      ? `Optiwand [${roomName}]${lockNote}: ${armed} armed suspect${armed === 1 ? '' : 's'}, ${civs} civilian${civs === 1 ? '' : 's'}${surr ? `, ${surr} surrendered` : ''}.`
      : `Optiwand [${roomName}]${lockNote}: looks clear.`;
    if (by.kind === 'officer') this.say(by, msg);
    else this.events.push({ t: 'info', text: msg });
    return msg;
  }
  wedgeDoor(door: Door, by: Actor): boolean {
    if (door.open > 0.35) {
      this.events.push({ t: 'info', text: 'Close the door before wedging it.' });
      return false;
    }
    if (door.wedged) {
      door.wedged = false;
      if (by.kind === 'player') by.wedges++;
      const msg = 'Wedge removed from door.';
      if (by.kind === 'officer') this.say(by, msg); else this.events.push({ t: 'info', text: msg });
      return true;
    }
    if (by.kind === 'player' && by.wedges <= 0) {
      this.events.push({ t: 'info', text: 'No door wedges left!' });
      return false;
    }
    if (by.kind === 'player') by.wedges--;
    door.wedged = true; door.target = 0;
    const msg = 'Door wedged — flanks blocked.';
    if (by.kind === 'officer') this.say(by, msg); else this.events.push({ t: 'info', text: msg });
    return true;
  }
  c2Door(door: Door, by: Actor): boolean {
    if (by.c2 <= 0) {
      if (by.kind === 'player') this.events.push({ t: 'info', text: 'No C2 charges left!' });
      else this.say(by, 'Out of C2!');
      return false;
    }
    by.c2--;
    this.stats.c2Used++;
    const x = door.cx + 0.5, z = door.cz + 0.5;
    this.replayEvents.push({ t: this.time, kind: 'c2', x, z });
    this.setDoor(door, true, true, true);
    this.events.push({ t: 'c2', x, z });
    this.events.push({ t: 'bang', x, z });
    this.noise(x, z, 28);
    // Concussive shockwave stuns / forces surrender near the door on the far side
    const side = this.doorSide(door, by);
    const dir = door.horiz ? { x: 0, z: -side } : { x: -side, z: 0 };
    for (const a of this.actors) {
      if (!a.alive) continue;
      const d = Math.hypot(a.x - x, a.z - z);
      if (d > 6.5) continue;
      const onFarSide = (a.x - x) * dir.x + (a.z - z) * dir.z >= -0.4;
      if (!onFarSide && a.kind === 'player') continue;
      const k = 1 - d / 7;
      if (a.kind === 'suspect' || a.kind === 'civ') {
        a.stun = Math.max(a.stun, 4 + 4 * k); a.path = null; a.moving = false;
        if (d < 3.2 && a.kind === 'suspect') this.damage(a, 45 * k, by, false);
        if (a.alive && (a.kind === 'civ' || this.rng() < 0.72)) this.surrender(a);
      } else if (a.kind === 'officer' && d < 2.5) {
        a.stun = Math.max(a.stun, 0.8);
      }
    }
    return true;
  }
  togglePower(by: Actor = this.player): boolean {
    if (!this.level.breaker) return false;
    this.powerOn = !this.powerOn;
    this.events.push({ t: 'power', on: this.powerOn });
    this.events.push({ t: 'info', text: this.powerOn ? 'Power restored.' : 'Building power cut! Use NVG (N) or Flashlight (T).' });
    const o = this.officers.find(m => m.alive);
    if (o && !this.powerOn) this.say(o, 'Power is out — switching to optics.');
    void by;
    return true;
  }

  // ---------- combat ----------
  playerNoise(p: Actor, radius: number) { this.noise(p.x, p.z, radius); }
  private noise(x: number, z: number, radius: number) {
    for (const s of this.suspects) if (s.active && !s.surrendered && Math.hypot(s.x - x, s.z - z) < radius) { if (s.alertT <= 0) s.lastSeen = { x, z }; s.alertT = Math.max(s.alertT, 8); }
  }
  fire(by: Actor, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, dmg: number, opts: boolean | { nonLethal?: boolean; taser?: boolean } = false, taserArg = false) {
    const nonLethal = typeof opts === 'boolean' ? opts : !!opts.nonLethal;
    const taser = typeof opts === 'boolean' ? taserArg : !!opts.taser;
    const maxD = taser ? 9.5 : 70;
    const h = this.ray(ox, oy, oz, dx, dy, dz, maxD, by, !taser);
    if (taser) this.events.push({ t: 'taser', x: ox, y: oy, z: oz, x2: h.x, y2: h.y, z2: h.z });
    else {
      this.events.push({ t: 'shot', by, x: ox, y: oy, z: oz, x2: h.x, y2: h.y, z2: h.z, hit: h.kind });
      if (this.replayEvents.length < 800) this.replayEvents.push({ t: this.time, kind: 'shot', x: ox, z: oz, x2: h.x, z2: h.z, team: by.kind === 'officer' ? by.team : undefined });
    }
    by.lastShotT = this.time; by.hasFired = true; this.stats.shotsFired += by.kind === 'suspect' ? 0 : 1;
    if (!taser) this.noise(ox, oz, 20);
    if (by.kind !== 'suspect' && !taser) for (const c of this.civs) if (c.active && !c.surrendered && Math.hypot(c.x - ox, c.z - oz) < 12 && this.rng() < 0.2) c.panicT = 0;
    if (h.actor) this.damage(h.actor, dmg * (h.head && !nonLethal ? 3 : 1), by, h.head && !nonLethal, nonLethal);
    return h;
  }
  private aiFire(a: Actor, tg: Actor, spread: number, dmg: number) {
    if (a.reloadT > 0 || a.fireCd > 0) return;
    if (a.ammo <= 0) { a.reloadT = 2.2; a.ammo = 30; return; }
    const ty = tg.down ? 0.8 : tg.kind === 'player' && tg.prone ? 0.3 : tg.kind === 'player' && tg.crouch ? 0.9 : 1.2;
    let dx = tg.x - a.x, dy = ty - 1.4, dz = tg.z - a.z; const d = Math.hypot(dx, dy, dz); dx /= d; dy /= d; dz /= d;
    if (a.kind === 'officer') {
      for (const o of this.actors) {
        if (o === a || o === tg || !o.alive || (o.kind === 'suspect' && !o.down)) continue;
        const t = (o.x - a.x) * dx + (o.z - a.z) * dz; if (t < 0 || t > d + 1.5) continue;
        if (Math.hypot(a.x + dx * t - o.x, a.z + dz * t - o.z) < 0.6) return;
      }
    }
    const g = () => (this.rng() + this.rng() + this.rng() - 1.5) * spread;
    dx += g(); dy += g() * 0.6; dz += g(); const n = Math.hypot(dx, dy, dz);
    a.ammo--; a.burst++; a.fireCd = a.burst >= 3 ? (a.burst = 0, 0.4 + this.rng() * 0.4) : 0.11;
    this.fire(a, a.x + dx * 0.4, 1.4, a.z + dz * 0.4, dx / n, dy / n, dz / n, dmg);
  }
  damage(a: Actor, dmg: number, by: Actor, head: boolean, nonLethal = false) {
    if (!a.alive) return;
    if (a.kind === 'officer') dmg *= 0.42;
    if (a.kind === 'player') {
      dmg *= [0.25, 0.36, 0.55][this.difficulty] ?? 0.36;
      if (a.shield && Math.abs(angDiff(a.yaw, yawTo(by.x - a.x, by.z - a.z))) < 1.15) {
        dmg *= 0.25;
      }
      if (a.hp - dmg < 35 && a.hp - dmg > 0 && !this.lowHpWarned) {
        this.lowHpWarned = true;
        this.banter("Lead's bleeding! Cover the boss!");
      }
    }
    if (nonLethal) {
      this.stats.nonLethalHits++;
      a.hp = Math.max(15, a.hp - dmg * 0.35);
      this.events.push({ t: 'hurt', a, head: false });
      if (a.kind === 'suspect' || a.kind === 'civ') {
        a.stun = Math.max(a.stun, 5.0);
        a.fakeSurrender = false;
        this.surrender(a);
      }
      return;
    }
    a.hp -= dmg; this.events.push({ t: 'hurt', a, head });
    if (a.kind !== 'player') this.events.push({ t: 'bark', a, kind: a.hp <= 0 ? 'die' : 'pain' });
    const police = by.kind === 'player' || by.kind === 'officer';
    if (a.hp <= 0) {
      a.alive = false; a.hp = 0; a.moving = false; a.path = null; this.events.push({ t: 'death', a });
      this.replayEvents.push({ t: this.time, kind: 'death', x: a.x, z: a.z });
      if (a.kind === 'suspect') {
        this.stats.suspectsKilled++;
        if (a.wasFake && police) this.banter('Nice catch — he had a piece tucked!');
        if (police && (a.down || (!a.hostile && !a.hasFired && a.firstChallengeT === Infinity))) { this.stats.unauthorized++; this.events.push({ t: 'info', text: 'Unauthorized force: suspect shot without warning' }); }
      }
      if (a.kind === 'civ') { this.stats.civsKilled++; if (police) { this.stats.civsKilledByPolice++; this.events.push({ t: 'info', text: 'A civilian was killed by police!' }); } }
      if (a.kind === 'officer') { this.stats.officersDown++; const m = this.officers.find(o => o.alive && o.team === a.team) ?? this.officers.find(o => o.alive); if (m) this.say(m, `${a.name} is down!`); }
      if (a.kind === 'player') { if (!this.players.some(p => p.alive)) this.finish(false, 'All officers down.'); else this.events.push({ t: 'info', text: `${a.name} is down!` }); }
      if (a.claimedBy) { a.claimedBy.cuff = null; a.claimedBy = null; }
      return;
    }
    if (a.kind === 'suspect' && !a.down) {
      a.alertT = 8; if (!a.lastSeen) a.lastSeen = { x: by.x, z: by.z }; a.stun = Math.max(a.stun, 0.25);
      if (this.rng() < 0.22) this.surrender(a);
    }
    if (a.kind === 'officer' && a.hp < 45 && this.rng() < 0.5) this.say(a, "I'm hit!");
  }
  private banter(text: string, actor?: Actor) {
    if (this.time - this.banterT < 12) return;
    const o = actor && actor.alive ? actor : this.officers.find(m => m.alive);
    if (!o) return;
    this.banterT = this.time;
    this.say(o, text);
  }
  private surrender(a: Actor, allowFake = false) {
    if (a.surrendered) return;
    a.surrendered = true; a.armed = false; a.path = null; a.moving = false; a.target = null; a.unwatchedT = 0;
    if (allowFake && a.kind === 'suspect' && a.morale > 0.56 && this.rng() < 0.26) {
      a.fakeSurrender = true; a.wasFake = true; a.fakeT = 3.0 + this.rng() * 2.4;
    }
    this.events.push({ t: 'surrender', a }); this.events.push({ t: 'bark', a, kind: 'surrender' });
  }
  /** Compliance check when police shout at someone. */
  challenge(a: Actor, bonus: number) {
    if (!a.active || a.surrendered) return;
    if (a.firstChallengeT === Infinity) a.firstChallengeT = this.time;
    a.challengeT = this.time;
    if (this.time - a.lastRoll < 1.1) return; a.lastRoll = this.time;
    if (a.kind === 'civ') { if (this.rng() < 0.8 + bonus || a.stun > 0) this.surrender(a); else { a.panicT = 3 + this.rng() * 2; this.events.push({ t: 'bark', a, kind: 'panic' }); } return; }
    let p = a.rolls < 2 ? (1 - a.morale) * 0.85 : 0; a.rolls++;
    p += bonus; if (a.stun > 0.5) p += 0.5; if (a.hp < 60) p += 0.25;
    if (this.time - a.lastShotT < 1) p -= 0.2;
    if (this.rng() < p) this.surrender(a, true); else a.alertT = 8;
  }
  playerShout(p: Actor = this.player) {
    const f = fwd(p.yaw); this.events.push({ t: 'shout', a: p }); let n = 0;
    const zoeBonus = this.officers[3]?.alive && dist(this.officers[3], p) < 8 ? 0.12 : 0;
    for (const a of this.actors) {
      if ((a.kind !== 'suspect' && a.kind !== 'civ') || !a.active || a.surrendered) continue;
      const dx = a.x - p.x, dz = a.z - p.z, d = Math.hypot(dx, dz);
      if (d > 14 || !this.los(p.x, p.z, a.x, a.z)) continue;
      if (d > 3 && (dx * f.x + dz * f.z) / d < 0.25) continue;
      this.challenge(a, 0.05 + zoeBonus); n++;
    }
    this.noise(p.x, p.z, 9);
    return n;
  }
  throwBang(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, speed = 11) {
    this.stats.bangsUsed = (this.stats.bangsUsed ?? 0) + 1;
    this.grenades.push({ x: ox, y: oy, z: oz, vx: dx * speed, vy: dy * speed + 1.5, vz: dz * speed, t: 1.5 });
    this.events.push({ t: 'throw', x: ox, z: oz });
  }
  private updateGrenades(dt: number) {
    for (const g of this.grenades) {
      g.t -= dt; g.vy -= 9.8 * dt;
      const nx = g.x + g.vx * dt, nz = g.z + g.vz * dt;
      const blk = (x: number, z: number) => {
        const cx = Math.floor(x), cz = Math.floor(z), c = this.cell(cx, cz);
        if (c === WINDOW && g.y >= 0.9 && g.y <= 2.3) { this.breakWindow(cx, cz); return false; }
        return c === WALL || (c === WINDOW && (g.y < 0.9 || g.y > 2.3)) || (c === HIGH && g.y < 2.2) || (c === LOW && g.y < 0.85) || (c === DOOR && g.y >= 2.2) || this.hitDoorLeaf3D(x, g.y, z) || this.hitExterior3D(x, g.y, z);
      };
      if (blk(nx, g.z)) g.vx *= -0.35; else g.x = nx;
      if (blk(g.x, nz)) g.vz *= -0.35; else g.z = nz;
      g.y += g.vy * dt; if (g.y < 0.06) { g.y = 0.06; g.vy *= -0.3; g.vx *= 0.6; g.vz *= 0.6; }
      if (g.y > 2.9) { g.y = 2.9; g.vy = -Math.abs(g.vy) * 0.3; }
      if (g.t <= 0) this.detonate(g.x, g.z);
    }
    this.grenades = this.grenades.filter(g => g.t > 0);
  }
  private detonate(x: number, z: number) {
    this.events.push({ t: 'bang', x, z }); this.noise(x, z, 25);
    this.replayEvents.push({ t: this.time, kind: 'bang', x, z });
    for (const w of this.level.windows) {
      if (Math.hypot(w.x - x, w.z - z) < 4.5) this.breakWindow(Math.floor(w.x), Math.floor(w.z));
    }
    let flashedOfficer: Actor | null = null;
    for (const a of this.actors) {
      if (!a.alive) continue; const d = Math.hypot(a.x - x, a.z - z);
      if (d > 9 || !this.los(x, z, a.x, a.z)) continue;
      const k = 1 - d / 10;
      if (a.kind === 'player') { const facing = Math.abs(angDiff(a.yaw, yawTo(x - a.x, z - a.z))) < 1.2; a.flash = Math.max(a.flash, facing ? k : k * 0.4); }
      else if (a.kind === 'officer') { a.stun = Math.max(a.stun, 1.5 * k); if (d < 5.5 && !flashedOfficer) flashedOfficer = a; }
      else { a.stun = Math.max(a.stun, 2.5 + 4.5 * k); a.path = null; a.moving = false; a.fakeSurrender = false; if (a.kind === 'civ' || this.rng() < 0.45) this.surrender(a); }
    }
    if (flashedOfficer) this.banter('Seriously boss?! My retinas!', flashedOfficer);
  }

  // ---------- speech ----------
  say(a: Actor, text: string, shout = false) { this.events.push({ t: 'say', a, text, shout }); }
  private lead(team: Team) { return this.officers.find(o => o.alive && o.team === team); }
  members(g: Grp) { return typeof g === 'string' ? this.officers.filter(o => o.alive && o.team === g && !o.solo) : g.alive ? [g] : []; }
  private st(g: Grp) { return typeof g === 'string' ? this.teams[g] : g.solo!; }
  private idx(m: Actor) { return m.solo ? 0 : m.ti; }
  reindexTeams() {
    let ia = 0, ib = 0;
    for (const o of this.officers) o.ti = o.team === 'A' ? ia++ : ib++;
  }

  // ---------- orders ----------
  nearestDoor(to: Pt, maxD: number): Door | null {
    let best: Door | null = null, bd = maxD;
    for (const d of this.level.doors) { const dd = Math.hypot(d.cx + 0.5 - to.x, d.cz + 0.5 - to.z); if (dd < bd) { bd = dd; best = d; } }
    return best;
  }
  /** Door the player is looking at (within range), else nearest door. */
  aimedDoor(p: Actor = this.player, maxD = 14): Door | null {
    const f = fwd(p.yaw);
    for (let d = 0.3; d < maxD; d += 0.2) {
      const cx = Math.floor(p.x + f.x * d), cz = Math.floor(p.z + f.z * d), c = this.cell(cx, cz);
      if (c === DOOR) return this.doorAtCell(cx, cz)!;
      if (c === WALL || c === HIGH) break;
    }
    let best: Door | null = null, bs = 0.5;
    for (const d of this.level.doors) {
      const dx = d.cx + 0.5 - p.x, dz = d.cz + 0.5 - p.z, dd = Math.hypot(dx, dz); if (dd > maxD) continue;
      const s = (dx * f.x + dz * f.z) / dd - dd * 0.03; if (s > bs) { bs = s; best = d; }
    }
    return best ?? this.nearestDoor(p, 12);
  }
  private doorSide(door: Door, from: Pt) { return door.horiz ? (from.z > door.cz + 0.5 ? 1 : -1) : (from.x > door.cx + 0.5 ? 1 : -1); }
  private stackPts(door: Door, side: number, offset: number, count = 2): Pt[] {
    const out: Pt[] = []; const c = { x: door.cx + 0.5, z: door.cz + 0.5 };
    const mk = (lat: number, row: number) => door.horiz ? { x: c.x + lat, z: c.z + side * row } : { x: c.x + side * row, z: c.z + lat };
    for (const [lat, row] of [[-1, 1], [1, 1], [-1, 2], [1, 2], [0, 2.2], [0, 3.2], [-1, 3], [1, 3]]) {
      const p = mk(lat, row); if (!this.solidCell(Math.floor(p.x), Math.floor(p.z)) && this.cell(Math.floor(p.x), Math.floor(p.z)) !== DOOR) out.push(p);
    }
    while (out.length < offset + count) out.push(mk(0, 1.2 + out.length));
    return out.slice(offset, offset + count);
  }
  private clearPts(door: Door, side: number, offset: number, count = 2): Pt[] {
    const c = { x: door.cx + 0.5, z: door.cz + 0.5 };
    const beyond = door.horiz ? { x: c.x, z: c.z - side } : { x: c.x - side, z: c.z };
    const room: Room | null = roomAt(this.level, beyond.x, beyond.z);
    let pts: Pt[] = [];
    if (room) {
      const x0 = room.x + 1.5, x1 = room.x + room.w - 1.5, z0 = room.z + 1.5, z1 = room.z + room.h - 1.5;
      const ix = Math.min(1.5, (x1 - x0) / 3), iz = Math.min(1.5, (z1 - z0) / 3);
      for (const [x, z] of [[x0 + ix, z0 + iz], [x1 - ix, z0 + iz], [x0 + ix, z1 - iz], [x1 - ix, z1 - iz]]) {
        let q = { x, z }; const dd = dist(q, beyond); if (dd > 9) q = { x: beyond.x + ((x - beyond.x) * 9) / dd, z: beyond.z + ((z - beyond.z) * 9) / dd };
        const n = nearestWalkable(this.level, q.x, q.z, 3); if (n) pts.push(n);
      }
      pts.sort((a, b) => dist(a, beyond) - dist(b, beyond));
    } else {
      const mk = (lat: number, row: number) => door.horiz ? { x: c.x + lat, z: c.z - side * row } : { x: c.x - side * row, z: c.z + lat };
      for (const [lat, row] of [[-1.5, 2], [1.5, 2], [-1.5, 4], [1.5, 4]]) { const n = nearestWalkable(this.level, mk(lat, row).x, mk(lat, row).z, 2); if (n) pts.push(n); }
    }
    while (pts.length < offset + count) pts.push(beyond);
    return pts.slice(offset, offset + count);
  }
  private dirTarget(dir: Dir, aim: Pt | null, p: Actor): { p: Pt; face: number } | null {
    if (dir === 'there') { if (!aim) return null; const n = nearestWalkable(this.level, aim.x, aim.z, 3); return n ? { p: n, face: yawTo(n.x - p.x, n.z - p.z) } : null; }
    const yaw = p.yaw + (dir === 'left' ? Math.PI / 2 : dir === 'right' ? -Math.PI / 2 : dir === 'back' ? Math.PI : 0);
    const f = fwd(yaw); let d = 0;
    for (; d < 9; d += 0.25) { const cx = Math.floor(p.x + f.x * (d + 0.6)), cz = Math.floor(p.z + f.z * (d + 0.6)); if (this.solidCell(cx, cz)) break; }
    d = Math.max(0.5, d - 0.2);
    const n = nearestWalkable(this.level, p.x + f.x * d, p.z + f.z * d, 2);
    return n ? { p: n, face: yaw } : null;
  }

  command(cmd: Command, aim: Pt | null = null, by: Actor = this.player, opts: { quiet?: boolean } = {}): boolean {
    if (this.over) return false;
    const reply = (a: Actor, text: string) => { if (!opts.quiet) this.say(a, text); };
    if (cmd.action === 'joinTeam') {
      const targetTeam: Team = cmd.team === 'B' ? 'B' : 'A';
      if (cmd.who != null) {
        const one = this.officers[cmd.who];
        if (!one || !one.alive) return false;
        one.team = targetTeam; one.solo = null; one.path = null; one.goal = null;
        this.reindexTeams();
        reply(one, `Copy, joining Team ${targetTeam}.`);
        return true;
      }
      const moving = this.officers.filter(o => o.alive);
      if (!moving.length) return false;
      for (const o of moving) { o.team = targetTeam; o.solo = null; o.path = null; o.goal = null; }
      this.reindexTeams();
      reply(moving[0], `Everyone moving to Team ${targetTeam}.`);
      return true;
    }
    let any = false; const one = cmd.who != null ? this.officers[cmd.who] : null, soloOrder = cmd.action !== 'report' && cmd.action !== 'fireHold' && cmd.action !== 'fireFree' && cmd.action !== 'shout';
    if (cmd.who != null && (!one || !one.alive)) return false;
    const groups: Grp[] = one ? [soloOrder ? one : one.team] : cmd.team === 'ALL' ? ['A', 'B'] : [cmd.team];
    for (const g of groups) {
      const team = typeof g === 'string' ? g : g.team;
      if (typeof g === 'string') { if (soloOrder) for (const o of this.officers) if (o.team === g) o.solo = null; }
      else if (!g.solo) g.solo = { order: { type: 'follow', phase: 0, t: 0, leader: by } };
      const lead = typeof g === 'string' ? this.lead(g) : g; if (!lead) continue; any = true;
      const off = !one && cmd.team === 'ALL' && team === 'B' ? this.officers.filter(o => o.alive && o.team === 'A').length : 0, T = this.st(g);
      const count = typeof g === 'string' ? Math.max(2, this.officers.filter(o => o.team === team).length) : 1;
      const set = (o: Order) => { for (const m of this.members(g)) { m.path = null; m.goal = null; if (m.cuff && o.type !== 'restrain') { m.cuff.claimedBy = null; m.cuff = null; } } T.order = o; };
      const tag = typeof g === 'string' ? `Team ${team}: ` : '';
      switch (cmd.action) {
        case 'follow': set({ type: 'follow', phase: 0, t: 0, leader: by }); reply(lead, tag + 'Copy, following you.'); break;
        case 'cover': set({ type: 'cover', phase: 0, t: 0, leader: by }); reply(lead, tag + 'Covering you.'); break;
        case 'hold': set({ type: 'hold', phase: 0, t: 0, pts: (typeof g === 'string' ? this.officers.filter(o => o.team === team) : [g]).map(o => ({ x: o.x, z: o.z })) }); reply(lead, tag + 'Holding position.'); break;
        case 'move': {
          const tg = this.dirTarget(cmd.dir ?? 'forward', aim, by);
          if (!tg) { reply(lead, tag + "Can't get there."); break; }
          const f = fwd(tg.face), side = { x: -f.z, z: f.x }; const pts: Pt[] = [];
          for (let i = 0; i < count; i++) { const k = count === 1 ? 0 : (i - (count - 1) / 2) * (off ? 1.4 : 1.2); const q = { x: tg.p.x + side.x * k, z: tg.p.z + side.z * k }; pts.push(!this.solidCell(Math.floor(q.x), Math.floor(q.z)) && walkLine(this.level, tg.p, q) ? q : tg.p); }
          set({ type: 'move', phase: 0, t: 0, pts, face: tg.face }); this.events.push({ t: 'marker', x: tg.p.x, z: tg.p.z, team });
          reply(lead, tag + ({ left: 'Moving left.', right: 'Moving right.', forward: 'Moving up.', back: 'Falling back.', there: 'Moving to that position.' } as const)[cmd.dir ?? 'forward']); break;
        }
        case 'stack': case 'breach': case 'bang': case 'c2': case 'open': case 'close': case 'peek': case 'wedge': {
          const door = this.aimedDoor(by);
          if (!door && typeof g !== 'string' && cmd.action === 'bang' && aim && dist(g, aim) > 2.5 && this.los(g.x, g.z, aim.x, aim.z)) {
            const d = dist(g, aim), dx = (aim.x - g.x) / d, dz = (aim.z - g.z) / d; g.yaw = Math.atan2(dx, dz); this.throwBang(g.x + dx * 0.4, 1.4, g.z + dz * 0.4, dx, 0.1, dz, Math.min(11, 3 + d * 0.9)); reply(g, 'Flashbang out!'); break;
          }
          if (!door) { reply(lead, tag + "I don't see a door."); break; }
          const side = this.doorSide(door, by), pts = this.stackPts(door, side, off, count);
          const c = { x: door.cx + 0.5, z: door.cz + 0.5 }; this.events.push({ t: 'marker', x: c.x, z: c.z, team });
          if (cmd.action === 'stack') { set({ type: 'stack', phase: 0, t: 0, pts, door, side }); reply(lead, tag + 'Stacking up on the door.'); }
          else if (cmd.action === 'peek') { set({ type: 'peek', phase: 0, t: 0, pts, door, side }); reply(lead, tag + 'Checking under the door.'); }
          else if (cmd.action === 'wedge') { set({ type: 'door', phase: 0, t: 0, pts, door, side, open: false, prev: { type: 'wedge' as any, phase: 0, t: 0 } }); reply(lead, tag + 'Wedging the door.'); }
          else if (cmd.action === 'open' || cmd.action === 'close') { set({ type: 'door', phase: 0, t: 0, pts, door, side, open: cmd.action === 'open' }); reply(lead, tag + (cmd.action === 'open' ? 'Opening the door.' : 'Closing the door.')); }
          else { set({ type: 'breach', phase: 0, t: 0, pts, door, side, off, bang: cmd.action === 'bang', c2: cmd.action === 'c2' }); reply(lead, tag + (cmd.action === 'c2' ? 'Setting C2 charge!' : cmd.action === 'bang' ? 'Bang and clear!' : 'Breaching!')); }
          break;
        }
        case 'defuse': {
          if (!this.bomb || this.bomb.defused) { reply(lead, tag + 'No active bomb to defuse.'); break; }
          set({ type: 'defuse', phase: 0, t: 0, pts: [{ x: this.bomb.x, z: this.bomb.z }] });
          reply(lead, tag + 'Moving to defuse the bomb!');
          break;
        }
        case 'restrain': {
          const n = this.assignCuffs(g, 16);
          if (n) { if (T.order.type !== 'restrain') set({ type: 'restrain', phase: 0, t: 0, prev: T.order }); this.assignCuffs(g, 16); reply(lead, tag + 'Securing.'); }
          else reply(lead, tag + 'Nobody to secure here.');
          break;
        }
        case 'fireHold': this.teams[team].fire = 'hold'; reply(lead, tag + 'Cease fire. Returning fire only.'); break;
        case 'fireFree': this.teams[team].fire = 'free'; reply(lead, tag + 'Weapons free.'); break;
        case 'report': reply(lead, tag + buildLocalReport(this, team, cmd.who)); break;
        case 'shout': break;
      }
    }
    return any;
  }
  private assignCuffs(g: Grp, range: number) {
    let n = 0;
    for (const o of this.members(g)) {
      if (o.cuff && o.cuff.alive && !o.cuff.restrained) { n++; continue; }
      o.cuff = null;
      let best: Actor | null = null, bd = range;
      for (const a of this.actors) {
        if (!a.alive || !a.surrendered || a.restrained || a.claimedBy || this.players.some(pl => pl.cuff === a)) continue;
        const d = dist(a, o); if (d < bd && (this.los(o.x, o.z, a.x, a.z) || this.players.some(pl => pl.alive && this.los(pl.x, pl.z, a.x, a.z)) || d < 6)) { bd = d; best = a; }
      }
      if (best) { o.cuff = best; best.claimedBy = o; o.cuffT = 0; o.path = null; n++; }
    }
    return n;
  }

  private updateGroup(g: Grp, dt: number) {
    const T = this.st(g), o = T.order, mem = this.members(g), tag = typeof g === 'string' ? `Team ${g}: ` : '', alone = typeof g !== 'string'; if (!mem.length) return;
    o.t += dt;
    if ((o.type === 'follow' || o.type === 'hold' || o.type === 'cover' || o.type === 'move') && Math.floor(this.time * 2) !== Math.floor((this.time - dt) * 2) && !mem.some(m => m.target)) {
      const had = mem.filter(m => m.cuff).length; if (this.assignCuffs(g, 7) > had && this.time - (T.cuffSay ?? -99) > 6) { T.cuffSay = this.time; this.say(mem[0], tag + 'Securing them.'); }
    }
    const arrived = () => mem.every(m => dist(m, o.pts![this.idx(m)] ?? m) < 0.7);
    if (o.type === 'door') {
      if (arrived() || o.t > 6) {
        if (o.prev && (o.prev.type as string) === 'wedge') {
          this.setDoor(o.door!, false, false, true);
          this.wedgeDoor(o.door!, mem[0]);
        } else {
          this.setDoor(o.door!, !!o.open, o.open && o.door!.locked);
        }
        T.order = { type: 'stack', phase: 0, t: 0, pts: o.pts, door: o.door, side: o.side };
      }
    } else if (o.type === 'peek') {
      if (arrived() || o.t > 6) {
        this.peekDoor(o.door!, mem[0]);
        T.order = { type: 'stack', phase: 0, t: 0, pts: o.pts, door: o.door, side: o.side };
      }
    } else if (o.type === 'defuse') {
      if (!this.bomb || this.bomb.defused) {
        T.order = { type: 'hold', phase: 0, t: 0, pts: mem.map(m => ({ x: m.x, z: m.z })) };
      } else if (dist(mem[0], this.bomb) < 1.3) {
        this.bomb.defuseT += dt;
        if (this.bomb.defuseT >= 3.5) {
          this.bomb.defused = true;
          this.events.push({ t: 'bomb', kind: 'defused', x: this.bomb.x, z: this.bomb.z });
          this.say(mem[0], tag + 'Bomb defused!');
          T.order = { type: 'hold', phase: 0, t: 0, pts: mem.map(m => ({ x: m.x, z: m.z })) };
        }
      }
    } else if (o.type === 'breach') {
      const door = o.door!, c = { x: door.cx + 0.5, z: door.cz + 0.5 }, side = o.side!;
      const breacher = mem.find(m => m.role === 'Breacher');
      const prepDelay = o.c2 ? (breacher ? 0.55 : 0.8) : o.bang ? 1.45 : 0.45;
      if (o.phase === 0 && (arrived() || o.t > 6)) {
        o.phase = 1; o.t = 0;
        if (o.c2) {
          const ok = this.c2Door(door, breacher ?? mem[0]);
          if (!ok) this.setDoor(door, true, true);
        } else {
          this.setDoor(door, true, true);
          if (o.bang) { const d = door.horiz ? { x: 0, z: -side } : { x: -side, z: 0 }; this.grenades.push({ x: c.x + d.x * 0.7, y: 1.0, z: c.z + d.z * 0.7, vx: d.x * 5.5, vy: 1, vz: d.z * 5.5, t: 1.3 }); this.events.push({ t: 'throw', x: c.x, z: c.z }); this.say(mem[0], 'Flashbang out!'); }
        }
      } else if (o.phase === 1 && alone && o.bang && o.t > prepDelay) {
        T.order = { type: 'stack', phase: 0, t: 0, pts: o.pts, door, side };
      } else if (o.phase === 1 && o.t > prepDelay) {
        const count = alone ? 1 : Math.max(2, this.officers.filter(m => m.team === (g as Team)).length);
        o.phase = 2; o.t = 0; o.pts = this.clearPts(door, side, o.off ?? 0, count);
        for (const m of mem) { m.path = null; m.goal = null; }
      } else if (o.phase === 2 && ((arrived() && o.t > 1.5) || o.t > 9) && !mem.some(m => m.target)) {
        const got = this.assignCuffs(g, 9);
        this.say(mem[0], tag + 'Room clear.' + (got ? ' Securing them.' : ''));
        const hold: Order = { type: 'hold', phase: 0, t: 0, pts: o.pts };
        T.order = got ? { type: 'restrain', phase: 0, t: 0, prev: hold } : hold;
      }
    } else if (o.type === 'restrain') {
      if (!mem.some(m => m.cuff) && !this.assignCuffs(g, 9)) { T.order = o.prev ?? { type: 'follow', phase: 0, t: 0, leader: o.leader }; T.order.t = 0; for (const m of mem) { m.path = null; m.goal = null; } }
    }
  }

  private pickThreat(o: Actor): Actor | null {
    const range = o.role === 'Marksman' ? 48 : 40;
    let best: Actor | null = null, bd = 1e9;
    for (const s of this.suspects) {
      if (!s.alive || s.down || !s.armed) continue;
      const d = dist(o, s); if (d > range || d >= bd) continue;
      const recent = this.time - s.lastShotT < 2.5;
      if (recent ? this.los(o.x, o.z, s.x, s.z) : this.sees(o, s, range, 3.4)) { bd = d; best = s; }
    }
    return best;
  }
  private updateOfficer(o: Actor, dt: number) {
    if (o.stun > 0) { o.stun -= dt; o.moving = false; return; }
    const T = this.teams[o.team], ord = (o.solo ?? T).order;
    o.percT -= dt; if (o.percT <= 0) { o.percT = 0.12; o.target = this.pickThreat(o); }
    const th = o.target;
    if (th && th.alive && !th.down) {
      const want = yawTo(th.x - o.x, th.z - o.z); o.yaw = turn(o.yaw, want, 10 * dt); o.moving = false;
      if (this.time - th.challengeT > 2.5) {
        const bonus = (dist(o, th) < 8 ? 0.05 : 0) + (o.role === 'Negotiator' ? 0.18 : 0);
        this.say(o, 'Police! Drop the weapon!', true);
        this.challenge(th, bonus);
        if (th.down) return;
      }
      const mayFire = th.hasFired || (T.fire === 'free' && (th.hostile || this.time - th.firstChallengeT > 0.9));
      if (Math.abs(angDiff(o.yaw, want)) < 0.12) o.aimT += dt; else o.aimT = 0;
      if (mayFire && o.aimT > 0.22) this.aiFire(o, th, o.role === 'Marksman' ? 0.022 : 0.035, 34);
      return;
    }
    o.aimT = 0;
    if (o.cuff) {
      const c = o.cuff;
      if (!c.alive || c.restrained || !c.surrendered) { c.claimedBy = null; o.cuff = null; }
      else if (dist(o, c) > 1.0) { this.goTo(o, c.x, c.z, dt, 1, 0.95); return; }
      else {
        o.moving = false; o.yaw = turn(o.yaw, yawTo(c.x - o.x, c.z - o.z), 8 * dt);
        o.cuffT += dt;
        const needT = o.role === 'Negotiator' ? 1.3 : 2.0;
        if (o.cuffT > needT) { this.restrain(c, o); o.cuff = null; o.cuffT = 0; }
        return;
      }
    }
    // Proactive bomb callout if close
    if (this.bomb && !this.bomb.defused && dist(o, this.bomb) < 8 && this.los(o.x, o.z, this.bomb.x, this.bomb.z) && this.time - o.lastCallT > 18) {
      o.lastCallT = this.time;
      this.say(o, `Eyes on the bomb! ${Math.ceil(this.bomb.time)} seconds left!`);
    }
    let dest: Pt | null = null, face: number | null = null;
    const p = this.leaderOf(ord.type === 'restrain' && ord.prev ? ord.prev : ord);
    if (ord.type === 'follow' || ord.type === 'restrain') { dest = this.trailPoint(1.4 + o.slot * 1.05, p); if (dist(o, p) < 1.3 + o.slot * 0.5 && !o.path) dest = null; }
    else if (ord.type === 'cover') { const ang = [-0.9, 0.9, -1.5, 1.5][o.ti % 4] ?? 0; dest = this.trailPoint(1.1 + o.ti * 0.85, p); face = p.yaw + Math.PI + ang; if (dist(o, p) < 1.4 + o.ti * 0.55 && !o.path) dest = null; }
    else if (ord.pts) { dest = ord.pts[this.idx(o)] ?? ord.pts[0]; face = ord.face ?? null; }
    if (ord.type === 'breach' && ord.phase === 1) { dest = null; }
    if ((ord.type === 'stack' || ord.type === 'door' || ord.type === 'peek' || (ord.type === 'breach' && ord.phase < 2)) && ord.door) face = yawTo(ord.door.cx + 0.5 - o.x, ord.door.cz + 0.5 - o.z);
    const arrived = dest ? this.goTo(o, dest.x, dest.z, dt, ord.type === 'breach' && ord.phase === 2 ? 1.15 : 1) : (o.moving = false, true);
    if (arrived && face !== null) o.yaw = turn(o.yaw, face, 5 * dt);
    else if (arrived && (ord.type === 'follow') && dist(o, p) < 4) o.yaw = turn(o.yaw, p.yaw + (o.slot % 2 ? -0.5 : 0.5) * (o.slot > 1 ? 2.2 : 1), 3 * dt);
  }
  private restrain(c: Actor, by: Actor) {
    c.restrained = true; c.surrendered = true; c.armed = false; c.fakeSurrender = false; c.claimedBy = null; this.events.push({ t: 'cuff', a: c, by });
    this.replayEvents.push({ t: this.time, kind: 'arrest', x: c.x, z: c.z });
    if (c.kind === 'suspect') {
      this.stats.suspectsArrested++;
      this.arrestStreak++;
      if (this.arrestStreak >= 2 && by.kind === 'officer') this.banter('Textbook arrest, clean.', by);
    } else this.stats.civsSecured++;
    if (by.kind === 'officer') this.say(by, c.kind === 'suspect' ? 'Suspect secured.' : (c.vip ? 'VIP secured!' : 'Civilian secured.'));
  }

  private nearestPolice(s: Actor, range: number, fov: number): Actor | null {
    let best: Actor | null = null, bd = 1e9;
    for (const o of this.actors) {
      if ((o.kind !== 'player' && o.kind !== 'officer') || !o.alive) continue;
      const d = dist(s, o); if (d >= bd) continue;
      if (this.sees(s, o, range, fov)) { bd = d; best = o; }
    }
    return best;
  }
  private randomRoomPoint(roomId: number): Pt | null {
    const r = this.level.rooms[roomId]; if (!r) return null;
    for (let i = 0; i < 8; i++) { const x = r.x + 1 + Math.floor(this.rng() * (r.w - 2)), z = r.z + 1 + Math.floor(this.rng() * (r.h - 2)); if (!this.solidCell(x, z)) return { x: x + 0.5, z: z + 0.5 }; }
    return null;
  }
  private updateSuspect(s: Actor, dt: number) {
    if (s.stun > 0) { s.stun -= dt; s.moving = false; return; }
    if (s.surrendered) {
      if (s.fakeSurrender && !s.claimedBy && !this.players.some(pl => pl.cuff === s)) {
        s.fakeT -= dt;
        const nearPolice = this.actors.find(o => (o.kind === 'player' || o.kind === 'officer') && o.alive && dist(o, s) < 7 && this.los(o.x, o.z, s.x, s.z));
        if (s.fakeT <= 0 && nearPolice) {
          s.fakeSurrender = false; s.surrendered = false; s.armed = true; s.hostile = true; s.alertT = 8; s.rolls = 2; s.react = 0.25;
          this.events.push({ t: 'bark', a: s, kind: 'unrest' });
          this.events.push({ t: 'info', text: 'Watch out — suspect faked surrender and pulled a concealed pistol!' });
          return;
        }
      }
      const watched = this.actors.some(o => (o.kind === 'player' || o.kind === 'officer') && o.alive && dist(o, s) < 14 && this.los(o.x, o.z, s.x, s.z));
      s.unwatchedT = watched ? 0 : s.unwatchedT + dt;
      if (s.unwatchedT > 10 && s.morale > 0.65 && !s.claimedBy) { s.surrendered = false; s.fakeSurrender = false; s.armed = true; s.unwatchedT = 0; s.alertT = 8; s.rolls = 2; this.events.push({ t: 'bark', a: s, kind: 'unrest' }); }
      return;
    }
    s.percT -= dt; if (s.percT <= 0) { s.percT = 0.15; s.target = this.nearestPolice(s, 32, s.alertT > 0 ? 4.2 : 2.6); }
    const e = s.target;
    if (e && e.alive) {
      s.lastSeen = { x: e.x, z: e.z }; s.alertT = 8; s.lostT = 0; s.moving = false; s.path = null;
      const want = yawTo(e.x - s.x, e.z - s.z); s.yaw = turn(s.yaw, want, 7 * dt);
      if (s.react < 0) { s.react = (0.55 + this.rng() * 0.7) * [1.5, 1, 0.7][this.difficulty]; this.events.push({ t: 'bark', a: s, kind: 'spot' }); }
      s.react -= dt;
      if (s.react <= 0 && Math.abs(angDiff(s.yaw, want)) < 0.2) { s.hostile = true; this.aiFire(s, e, [0.085, 0.06, 0.045][this.difficulty] * (1 + dist(s, e) / 30), 30); }
      return;
    }
    s.lostT += dt; if (s.lostT > 2.5) s.react = -1;
    if (s.alertT > 0) {
      s.alertT -= dt;
      if (s.lastSeen) {
        if (s.hunter && !s.hostage && s.lostT > 1.2) { if (this.goTo(s, s.lastSeen.x, s.lastSeen.z, dt, 0.8, 0.8)) s.lastSeen = null; }
        else { s.moving = false; s.yaw = turn(s.yaw, yawTo(s.lastSeen.x - s.x, s.lastSeen.z - s.z), 4 * dt); }
      } else s.moving = false;
      return;
    }
    if (s.hostage) { s.moving = false; return; }
    s.timer -= dt;
    if (s.timer <= 0) { s.timer = 4 + this.rng() * 8; s.goal = null; s.path = null; s.lastSeen = this.rng() < 0.6 ? this.randomRoomPoint(s.room) : null; }
    if (s.lastSeen) { if (this.goTo(s, s.lastSeen.x, s.lastSeen.z, dt, 0.4)) s.lastSeen = null; } else s.moving = false;
  }
  private updateCiv(c: Actor, dt: number) {
    if (c.stun > 0) { c.stun -= dt; c.moving = false; return; }
    const police = (r: number) => this.actors.some(o => (o.kind === 'player' || o.kind === 'officer') && o.alive && dist(o, c) < r && this.los(o.x, o.z, c.x, c.z));
    if (c.surrendered) {
      c.unwatchedT = c.claimedBy || this.players.some(pl => pl.cuff === c) || police(11) ? 0 : c.unwatchedT + dt;
      if (c.unwatchedT > 7) { c.surrendered = false; c.unwatchedT = 0; c.seeT = -4; c.panicT = 6 + this.rng() * 4; c.lastSeen = this.randomRoomPoint(Math.floor(this.rng() * this.level.rooms.length)); this.events.push({ t: 'bark', a: c, kind: 'panic' }); this.events.push({ t: 'info', text: 'A civilian without handcuffs ran off.' }); }
      return;
    }
    if (c.panicT > 0) {
      c.panicT -= dt;
      if (!c.lastSeen) c.lastSeen = this.randomRoomPoint(c.room);
      if (!c.lastSeen || this.goTo(c, c.lastSeen.x, c.lastSeen.z, dt, 1)) c.lastSeen = null;
      return;
    }
    c.moving = false; c.path = null;
    c.seeT = police(8) ? c.seeT + dt : Math.min(0, c.seeT); if (c.seeT > 0.9) { c.seeT = 0; this.surrender(c); }
  }

  // ---------- player interaction ----------
  interactTarget(p: Actor = this.player): { actor?: Actor; door?: Door; breaker?: Pt; bomb?: BombState } | null {
    const f = fwd(p.yaw);
    if (this.bomb && !this.bomb.defused) {
      const dx = this.bomb.x - p.x, dz = this.bomb.z - p.z, d = Math.hypot(dx, dz);
      if (d < 2.1 && (d < 0.8 || (dx * f.x + dz * f.z) / d > 0.5)) return { bomb: this.bomb };
    }
    if (this.level.breaker) {
      const dx = this.level.breaker.x - p.x, dz = this.level.breaker.z - p.z, d = Math.hypot(dx, dz);
      if (d < 2.1 && (d < 0.8 || (dx * f.x + dz * f.z) / d > 0.5)) return { breaker: this.level.breaker };
    }
    let best: Actor | null = null, bd = 2.0;
    for (const a of this.actors) {
      if (!a.alive || !a.surrendered || a.restrained) continue;
      const dx = a.x - p.x, dz = a.z - p.z, d = Math.hypot(dx, dz);
      if (d < bd && (d < 0.6 || (dx * f.x + dz * f.z) / d > 0.6)) { bd = d; best = a; }
    }
    if (best) return { actor: best };
    let bdoor: Door | null = null; bd = 2.4;
    for (const dr of this.level.doors) {
      const dx = dr.cx + 0.5 - p.x, dz = dr.cz + 0.5 - p.z, d = Math.hypot(dx, dz);
      if (d < bd && (d < 0.8 || (dx * f.x + dz * f.z) / d > 0.55)) { bd = d; bdoor = dr; }
    }
    return bdoor ? { door: bdoor } : null;
  }
  playerUse(p: Actor = this.player) {
    if (!p.alive || this.over) return;
    const t = this.interactTarget(p); if (!t) return;
    if (t.bomb) { p.defusing = true; p.defuseT = 0; }
    else if (t.breaker) this.togglePower(p);
    else if (t.door) this.setDoor(t.door, t.door.target === 0);
    else if (t.actor) { if (t.actor.claimedBy) { t.actor.claimedBy.cuff = null; t.actor.claimedBy = null; } p.cuff = t.actor; p.cuffT = 0; }
  }

  checkPlayers() { if (!this.players.some(p => p.alive)) this.finish(false, 'All officers down.'); }
  private finish(win: boolean, reason?: string) {
    if (this.over) return;
    this.recordReplay();
    this.over = { win, reason };
    this.events.push({ t: 'end', win });
  }
  remaining() {
    return {
      suspects: this.suspects.filter(s => s.alive && !s.restrained).length,
      civs: this.civs.filter(c => c.alive && !c.restrained).length,
      bomb: this.bomb && !this.bomb.defused ? Math.ceil(this.bomb.time) : 0,
    };
  }
  score() {
    const s = this.stats, ns = Math.max(1, this.suspects.length), nc = Math.max(1, this.civs.length), done = this.over?.win ? 1 : 0;
    const parts = [
      { label: 'Mission completed', pts: 40 * done, max: 40 },
      { label: `Suspects arrested alive (${s.suspectsArrested}/${this.suspects.length})`, pts: Math.round((25 * s.suspectsArrested) / ns), max: 25 },
      { label: `Civilians secured (${this.civs.filter(c => c.alive && c.restrained).length}/${this.civs.length})`, pts: Math.round((20 * this.civs.filter(c => c.alive && c.restrained).length) / nc), max: 20 },
      { label: `Team unharmed (${4 - s.officersDown}/4)`, pts: Math.round((15 * (4 - s.officersDown)) / 4), max: 15 },
      { label: `Unauthorized force (${s.unauthorized})`, pts: -10 * s.unauthorized, max: 0 },
      { label: `Civilians killed by police (${s.civsKilledByPolice})`, pts: -20 * s.civsKilledByPolice, max: 0 },
    ];
    const total = Math.max(0, Math.min(100, parts.reduce((a, p) => a + p.pts, 0)));
    const letter = total >= 98 && s.officersDown === 0 && s.unauthorized === 0 ? 'S+' : total >= 92 ? 'S' : total >= 80 ? 'A' : total >= 65 ? 'B' : total >= 45 ? 'C' : 'F';
    const rank = total >= 90 ? 'Commander' : total >= 75 ? 'Veteran' : total >= 55 ? 'Operator' : total >= 35 ? 'Recruit' : 'Failed';
    return { parts, total, letter, rank };
  }
  awards(): { title: string; desc: string }[] {
    const s = this.stats, out: { title: string; desc: string }[] = [];
    if (!this.over?.win) {
      if (s.shotsFired > 50) out.push({ title: 'BLAZE OF GLORY', desc: `${s.shotsFired} rounds fired` });
      return out;
    }
    if (s.suspectsArrested === this.suspects.length && s.unauthorized === 0) out.push({ title: 'TEXTBOOK ARREST', desc: '100% suspects arrested alive' });
    if (s.shotsFired <= 4 && s.unauthorized === 0) out.push({ title: 'GHOST SQUAD', desc: 'Minimal gunfire & silent entry' });
    else if (s.shotsFired >= 60) out.push({ title: 'TRIGGER HAPPY', desc: `${s.shotsFired} rounds expended` });
    if ((s.bangsUsed ?? 0) >= 3) out.push({ title: 'FLASH MASTER', desc: `${s.bangsUsed} flashbangs deployed` });
    if (s.nonLethalHits >= 2) out.push({ title: 'PACIFIST', desc: 'Non-lethal compliance pro' });
    if (s.c2Used >= 2) out.push({ title: 'DOOR KICKER', desc: `${s.c2Used} C2 breaches` });
    if (this.bomb?.defused) out.push({ title: 'BOMB TECH', desc: `${Math.ceil(this.bomb.time)}s left on clock` });
    if (s.officersDown === 0) out.push({ title: 'NO ONE LEFT BEHIND', desc: 'Full squad survived' });
    if (this.player.hp >= 95) out.push({ title: 'UNTOUCHABLE', desc: 'Took almost zero damage' });
    return out.slice(0, 4);
  }
  dispatchAction(kind: 'blackout' | 'panic' | 'rush' | 'false_alarm' | 'vip_name', payload?: string): string {
    if (this.over) return 'Operation already ended.';
    if (kind === 'blackout') {
      if (this.powerOn) {
        this.powerOn = false;
        this.events.push({ t: 'power', on: false });
      }
      this.events.push({ t: 'info', text: 'DISPATCH: Sector power grid failure!' });
      return 'Power grid cut.';
    }
    if (kind === 'panic') {
      let n = 0;
      for (const c of this.civs) {
        if (!c.alive || c.restrained) continue;
        c.surrendered = false; c.panicT = 6; c.lastSeen = this.randomRoomPoint(c.room);
        this.events.push({ t: 'bark', a: c, kind: 'panic' });
        n++; if (n >= 2) break;
      }
      this.events.push({ t: 'info', text: 'DISPATCH: Hostage panic reported inside!' });
      return 'Hostage panic triggered.';
    }
    if (kind === 'rush') {
      const cand = this.suspects.filter(s => s.alive && !s.down).sort((a, b) => dist(a, this.player) - dist(b, this.player));
      const s = cand[0];
      if (!s) return 'No active suspects left.';
      s.hunter = true; s.alertT = 14; s.lastSeen = { x: this.player.x, z: this.player.z };
      this.events.push({ t: 'bark', a: s, kind: 'spot' });
      this.events.push({ t: 'info', text: 'DISPATCH: Suspect flanking towards lead!' });
      return 'Suspect flanking.';
    }
    if (kind === 'false_alarm') {
      const rm = this.level.rooms[Math.floor(Math.random() * this.level.rooms.length)];
      const px = rm ? rm.x + rm.w / 2 : this.player.x, pz = rm ? rm.z + rm.h / 2 : this.player.z;
      this.events.push({ t: 'phone', x: px, z: pz });
      this.events.push({ t: 'info', text: 'DISPATCH: Burner phone ringing inside the building!' });
      return 'Caller pinged.';
    }
    if (kind === 'vip_name') {
      const clean = String(payload || 'VIP').replace(/[<>&]/g, '').trim().slice(0, 14) || 'VIP';
      const target = this.civs.find(c => c.vip && c.alive) ?? this.civs.find(c => c.alive) ?? this.suspects.find(s => s.alive);
      if (!target) return 'No target available.';
      target.name = clean;
      this.events.push({ t: 'info', text: `DISPATCH: Subject identified as "${clean}".` });
      return `Renamed subject to ${clean}.`;
    }
    return '';
  }
  debriefNotes(): string[] {
    const s = this.stats, notes: string[] = [];
    if (!this.over?.win) {
      notes.push(this.over?.reason ?? 'Operation aborted before all objectives were secured.');
      return notes;
    }
    if (s.suspectsArrested === this.suspects.length && s.unauthorized === 0) {
      notes.push('Textbook compliance: every suspect taken alive with zero unauthorized force.');
    } else if (s.unauthorized > 0) {
      notes.push(`Rule of engagement violation (${s.unauthorized}): challenge suspects, use flashbangs or non-lethal tools before firing.`);
    } else if (s.suspectsKilled > s.suspectsArrested) {
      notes.push('Heavy lethal force used — try Beanbag Shotgun, Taser, or C2 flashes to raise arrest scores.');
    }
    if (s.nonLethalHits > 0) notes.push(`Non-lethal tools deployed effectively (${s.nonLethalHits} hits).`);
    if (s.c2Used > 0) notes.push(`Explosive C2 breaches cleared locked entryways (${s.c2Used} charges used).`);
    if (this.bomb?.defused) notes.push(`Explosive device disarmed with ${Math.ceil(this.bomb.time)}s remaining.`);
    if (s.officersDown === 0) notes.push('Full squad survived the operation.');
    return notes;
  }

  private stepDoors(dt: number) {
    const leafR = 0.04;
    for (const d of this.level.doors) {
      const prev = d.open;
      const next = prev + Math.max(-dt * 2.8, Math.min(dt * 2.8, d.target - prev));
      if (Math.abs(next - prev) <= 1e-5) continue;
      d.open = next;
      const seg = doorLeafSegment(d);
      const swingSign = next > prev ? 1 : -1;
      const swx = -Math.sin(seg.theta) * swingSign;
      const swz = -Math.cos(seg.theta) * swingSign;
      let blocked = false;
      for (const a of this.actors) {
        if (!a.alive) continue;
        if (Math.abs(a.x - (d.cx + 0.5)) > 1.8 || Math.abs(a.z - (d.cz + 0.5)) > 1.8) continue;
        const c = closestOnSeg(a.x, a.z, seg.hx, seg.hz, seg.tx, seg.tz);
        const minD = a.r + leafR;
        if (c.d >= minD) continue;
        let nx = c.dx, nz = c.dz;
        if (c.d < 1e-4 || nx * swx + nz * swz < 0) { nx = swx; nz = swz; }
        else { nx /= c.d; nz /= c.d; }
        const push = minD - c.d + 0.015;
        a.x += nx * push; a.z += nz * push;
        this.resolve(a, d);
        const c2 = closestOnSeg(a.x, a.z, seg.hx, seg.hz, seg.tx, seg.tz);
        if (c2.d < minD - 0.035) { blocked = true; break; }
      }
      if (blocked) d.open = prev;
    }
  }

  private recordReplay() {
    if (this.replayFrames.length >= 1600) return;
    this.replayFrames.push({
      t: this.time,
      actors: this.actors.map(a => ({
        id: a.id, kind: a.kind, team: a.team, x: +a.x.toFixed(2), z: +a.z.toFixed(2),
        alive: a.alive, down: a.down, restrained: a.restrained,
      })),
    });
  }

  update(dt: number) {
    if (this.over) { this.stepDoors(dt); return; }
    this.time += dt;
    this.replayT -= dt;
    if (this.replayT <= 0) { this.replayT = 0.5; this.recordReplay(); }
    if (this.time - this.soloWarnT > 35 && this.officers.some(o => o.alive)) {
      const minD = Math.min(...this.officers.filter(o => o.alive).map(o => dist(o, this.player)));
      if (minD > 15 && this.teams.A.order.type !== 'follow' && this.teams.B.order.type !== 'follow') {
        this.soloWarnT = this.time;
        this.banter('Command, lead went solo again...');
      }
    }
    if (this.level.theme === 'office' || this.level.theme === 'bank' || this.level.theme === 'hotel') {
      this.phoneT -= dt;
      if (this.phoneT <= 0) {
        this.phoneT = 16 + (Math.floor(this.time * 7) % 12);
        const rm = this.level.rooms.find(r => r.spawn && Math.hypot(r.x + r.w / 2 - this.player.x, r.z + r.h / 2 - this.player.z) < 16);
        if (rm) this.events.push({ t: 'phone', x: rm.x + rm.w / 2, z: rm.z + rm.h / 2 });
      }
    }
    this.stepDoors(dt);
    if (this.bomb && !this.bomb.defused) {
      this.bomb.time -= dt;
      if (this.bomb.time <= 60 && !this.bomb.warned60) {
        this.bomb.warned60 = true;
        this.events.push({ t: 'info', text: 'WARNING: 60 seconds until bomb detonation!' });
      }
      if (this.bomb.time <= 20 && !this.bomb.warned20) {
        this.bomb.warned20 = true;
        this.events.push({ t: 'info', text: 'CRITICAL: 20 seconds until detonation!' });
      }
      if (this.bomb.time <= 0) {
        this.bomb.time = 0;
        this.replayEvents.push({ t: this.time, kind: 'bomb', x: this.bomb.x, z: this.bomb.z });
        this.events.push({ t: 'bomb', kind: 'detonate', x: this.bomb.x, z: this.bomb.z });
        this.finish(false, 'The bomb detonated!');
        return;
      }
    }
    for (const p of this.players) {
      if (p.alive) {
        p.nd += Math.hypot(p.x - p.nx, p.z - p.nz); p.nx = p.x; p.nz = p.z; p.nt += dt;
        if (p.nt >= 0.4) { const v = p.nd / p.nt; p.nd = 0; p.nt = 0; if (!p.prone && v < 9) { if (v > 4.4) this.noise(p.x, p.z, 12); else if (v > 2.4) this.noise(p.x, p.z, 6); } }
      }
      p.flash = Math.max(0, p.flash - dt * 0.22);
      if (p.defusing) {
        if (!p.alive || !this.bomb || this.bomb.defused || dist(p, this.bomb) > 2.4) { p.defusing = false; p.defuseT = 0; }
        else {
          p.defuseT += dt;
          if (p.defuseT >= 3.2) {
            this.bomb.defused = true; p.defusing = false; p.defuseT = 0;
            this.replayEvents.push({ t: this.time, kind: 'bomb', x: this.bomb.x, z: this.bomb.z });
            this.events.push({ t: 'bomb', kind: 'defused', x: this.bomb.x, z: this.bomb.z });
            this.events.push({ t: 'info', text: 'Bomb defused!' });
          }
        }
      }
      if (p.cuff) {
        const c = p.cuff;
        if (!p.alive || !c.alive || c.restrained || !c.surrendered || dist(c, p) > 2.3) p.cuff = null;
        else { p.cuffT += dt; if (p.cuffT > 1.6) { this.restrain(c, p); p.cuff = null; } }
      }
    }
    this.updateGroup('A', dt); this.updateGroup('B', dt); for (const o of this.officers) if (o.solo) this.updateGroup(o, dt);
    for (const a of this.actors) {
      a.fireCd -= dt; if (a.reloadT > 0) a.reloadT -= dt;
      if (!a.alive) { a.deadT += dt; continue; }
      if (a.restrained) continue;
      if (a.kind === 'officer') this.updateOfficer(a, dt); else if (a.kind === 'suspect') this.updateSuspect(a, dt); else if (a.kind === 'civ') this.updateCiv(a, dt);
    }
    const A = this.actors;
    for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
      const a = A[i], b = A[j]; if (!a.alive || !b.alive) continue;
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = a.r + b.r; if (d >= min || d < 1e-5) continue;
      if (a.down !== b.down) {
        const k = a.down ? a : b, o = a.down ? b : a;
        if (o.kind === 'player' || o.kind === 'officer') this.giveWay(k, o);
        const e = Math.hypot(o.x - k.x, o.z - k.z);
        if (e < min && e > 1e-5) {
          const q = min - e;
          o.x += ((o.x - k.x) / e) * q; o.z += ((o.z - k.z) / e) * q;
          this.resolve(o);
        }
        continue;
      }
      const push = min - d;
      if (!a.down && (a.kind === 'player' || b.kind === 'player') && a.kind !== b.kind) {
        const p = a.kind === 'player' ? a : b, ai = a.kind === 'player' ? b : a;
        const ux = (ai.x - p.x) / d, uz = (ai.z - p.z) / d;
        ai.x += ux * push * 0.35; ai.z += uz * push * 0.35; this.resolve(ai);
        const e = Math.hypot(p.x - ai.x, p.z - ai.z);
        if (e < min && e > 1e-5) {
          const rem = min - e;
          p.x += ((p.x - ai.x) / e) * rem; p.z += ((p.z - ai.z) / e) * rem; this.resolve(p);
        }
        continue;
      }
      a.x -= (dx / d) * push * 0.5; a.z -= (dz / d) * push * 0.5;
      b.x += (dx / d) * push * 0.5; b.z += (dz / d) * push * 0.5;
      this.resolve(a); this.resolve(b);
    }
    this.updateGrenades(dt);
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.5;
      const r = this.remaining();
      if (r.suspects === 0 && r.civs === 0 && (!this.bomb || this.bomb.defused)) this.finish(true);
    }
  }
}
