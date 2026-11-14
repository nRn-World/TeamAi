// TeamAi tactical simulation. Pure logic: no DOM, no three.js – runs headless in tests.
import { Level, Door, Pt, Room, buildLevel, mulberry32, roomAt, WALL, DOOR, LOW, HIGH } from './level';
import { findPath, nearestWalkable, walkLine } from './nav';

export type Team = 'A' | 'B';
export type Action = 'follow' | 'hold' | 'move' | 'cover' | 'stack' | 'breach' | 'bang' | 'open' | 'close' | 'restrain' | 'fireFree' | 'fireHold' | 'report' | 'shout';
export type Dir = 'left' | 'right' | 'forward' | 'back' | 'there';
export interface Command { team: Team | 'ALL'; action: Action; dir?: Dir; }
export type Kind = 'player' | 'officer' | 'suspect' | 'civ';

export interface Order {
  type: 'follow' | 'hold' | 'move' | 'cover' | 'stack' | 'breach' | 'door' | 'restrain';
  pts?: Pt[]; face?: number; door?: Door; bang?: boolean; open?: boolean; off?: number; leader?: Actor; phase: number; t: number; side?: number; prev?: Order;
}

export type Ev =
  | { t: 'shot'; by: Actor; x: number; y: number; z: number; x2: number; y2: number; z2: number; hit: 'wall' | 'actor' | 'none' }
  | { t: 'hurt'; a: Actor; head: boolean } | { t: 'death'; a: Actor }
  | { t: 'door'; door: Door; open: boolean } | { t: 'say'; a: Actor; text: string; shout?: boolean }
  | { t: 'shout'; a: Actor } | { t: 'bang'; x: number; z: number } | { t: 'throw'; x: number; z: number }
  | { t: 'cuff'; a: Actor; by: Actor } | { t: 'surrender'; a: Actor } | { t: 'marker'; x: number; z: number; team: Team }
  | { t: 'bark'; a: Actor; kind: 'spot' | 'surrender' | 'pain' | 'die' | 'panic' | 'unrest' }
  | { t: 'info'; text: string } | { t: 'end'; win: boolean };

export class Actor {
  x = 0; z = 0; yaw = 0; r = 0.3; hp = 100; alive = true; speed = 3.2;
  path: Pt[] | null = null; goal: Pt | null = null; repathT = 0; moving = false; stuckT = 0; walk = 0;
  stun = 0; surrendered = false; restrained = false; armed = false; morale = 0.5; rolls = 0; lastRoll = -9;
  target: Actor | null = null; aimT = 0; fireCd = 0; burst = 0; ammo = 30; reloadT = 0; lastShotT = -9;
  hostile = false; hasFired = false; react = -1; alertT = 0; lastSeen: Pt | null = null; hunter = false; timer = 0; lostT = 0;
  challengeT = -9; firstChallengeT = Infinity; unwatchedT = 0; panicT = 0; seeT = 0; room = -1;
  team: Team = 'A'; ti = 0; slot = 0; cuff: Actor | null = null; cuffT = 0; claimedBy: Actor | null = null;
  prone = false; jumpY = 0; /** footstep-noise bookkeeping */ nx = 0; nz = 0; nd = 0; nt = 0;
  percT = 0; deadT = 0; crouch = false; variant = 0; flash = 0; pitch = 0; trail: Pt[] = []; bangs = 3; pi = 0;
  constructor(public id: number, public kind: Kind, public name: string) { }
  get down() { return this.surrendered || this.restrained; }
  get active() { return this.alive && !this.restrained; }
}

export const fwd = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
export const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz);
export const angDiff = (a: number, b: number) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const turn = (a: number, b: number, max: number) => { const d = angDiff(a, b); return a + Math.max(-max, Math.min(max, d)); };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z);

export interface Stats { shotsFired: number; suspectsKilled: number; suspectsArrested: number; civsSecured: number; civsKilled: number; civsKilledByPolice: number; officersDown: number; unauthorized: number; }

export class Sim {
  level: Level; rng: () => number; actors: Actor[] = []; player: Actor; officers: Actor[] = []; suspects: Actor[] = []; civs: Actor[] = [];
  events: Ev[] = []; time = 0; trail: Pt[] = []; over: { win: boolean } | null = null;
  teams: Record<Team, { order: Order; fire: 'free' | 'hold'; cuffSay?: number }>;
  grenades: { x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number }[] = [];
  stats: Stats = { shotsFired: 0, suspectsKilled: 0, suspectsArrested: 0, civsSecured: 0, civsKilled: 0, civsKilledByPolice: 0, officersDown: 0, unauthorized: 0 };
  players: Actor[] = []; private checkT = 0;

  constructor(public mission: number, seed: number, public difficulty = 1, nPlayers = 1) {
    this.level = buildLevel(mission, seed); this.rng = mulberry32(seed + 99);
    const l = this.level, sp = l.playerSpawn; let id = 0;
    this.player = new Actor(id++, 'player', 'Du'); Object.assign(this.player, { x: sp.x, z: sp.z, yaw: sp.yaw, armed: true });
    this.actors.push(this.player); this.players.push(this.player); this.player.trail.push({ x: sp.x, z: sp.z });
    const names = ['A1', 'A2', 'B1', 'B2'];
    names.forEach((n, i) => {
      const o = new Actor(id++, 'officer', n); o.team = i < 2 ? 'A' : 'B'; o.ti = i % 2; o.slot = i; o.armed = true; o.speed = 3.9;
      const p = nearestWalkable(l, sp.x + (i % 2 ? 0.9 : -0.9), sp.z + 1.1 + Math.floor(i / 2) * 1.0) ?? sp;
      o.x = sp.x + (i % 2 ? 0.8 : -0.8); o.z = sp.z + 1.0 + Math.floor(i / 2) * 0.9; if (this.solidCell(Math.floor(o.x), Math.floor(o.z))) { o.x = p.x; o.z = p.z; }
      o.yaw = sp.yaw; this.officers.push(o); this.actors.push(o);
    });
    for (const s of l.suspects) {
      const a = new Actor(id++, 'suspect', 'Misstänkt'); Object.assign(a, { x: s.x, z: s.z, room: s.room, armed: true, yaw: this.rng() * 6.28, speed: 3.0 });
      a.morale = 0.2 + this.rng() * 0.75 + (difficulty - 1) * 0.1; a.hunter = this.rng() < 0.45; a.variant = Math.floor(this.rng() * 6); a.timer = this.rng() * 5;
      this.suspects.push(a); this.actors.push(a);
    }
    for (const s of l.civs) {
      const a = new Actor(id++, 'civ', 'Civil'); Object.assign(a, { x: s.x, z: s.z, room: s.room, yaw: this.rng() * 6.28, speed: 3.4 });
      a.variant = Math.floor(this.rng() * 6); a.morale = this.rng(); this.civs.push(a); this.actors.push(a);
    }
    this.teams = { A: { order: { type: 'follow', phase: 0, t: 0 }, fire: 'free' }, B: { order: { type: 'follow', phase: 0, t: 0 }, fire: 'free' } };
    // extra co-op players are appended last so ids/RNG of everything else stay identical
    for (let i = 1; i < nPlayers; i++) {
      const a = new Actor(id++, 'player', 'Spelare ' + (i + 1)); a.pi = i; a.armed = true; a.yaw = sp.yaw;
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
    if (c === WALL || c === LOW || c === HIGH) return true;
    if (c === DOOR) return this.doorAtCell(cx, cz)!.open < 0.7;
    return false;
  }
  opaqueCell(cx: number, cz: number) {
    const c = this.cell(cx, cz);
    if (c === WALL || c === HIGH) return true;
    if (c === DOOR) return this.doorAtCell(cx, cz)!.open < 0.5;
    return false;
  }
  los(x1: number, z1: number, x2: number, z2: number) {
    const dx = x2 - x1, dz = z2 - z1, d = Math.hypot(dx, dz), n = Math.ceil(d / 0.2);
    for (let i = 1; i < n; i++) if (this.opaqueCell(Math.floor(x1 + (dx * i) / n), Math.floor(z1 + (dz * i) / n))) return false;
    return true;
  }
  sees(a: Actor, b: Actor, range: number, fov: number) {
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
    if (d > range) return false;
    if (d > 2.5 && Math.abs(angDiff(a.yaw, yawTo(dx, dz))) > fov / 2) return false;
    return this.los(a.x, a.z, b.x, b.z);
  }
  height(a: Actor) { return a.down ? 1.15 : a.prone ? 0.55 : a.crouch ? 1.25 : 1.8; }

  /** 3D ray march against walls, props, floor/ceiling and actors. */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number, ignore?: Actor) {
    const step = 0.06; let x = ox, y = oy, z = oz;
    const cand = this.actors.filter(a => a.alive && a !== ignore);
    for (let d = 0; d < maxD; d += step) {
      x += dx * step; y += dy * step; z += dz * step;
      if (y <= 0) return { kind: 'wall' as const, x, y: 0, z, d, actor: null, head: false };
      const cx = Math.floor(x), cz = Math.floor(z), c = this.cell(cx, cz);
      if (y >= 3 && c !== 0) return { kind: 'wall' as const, x, y: 3, z, d, actor: null, head: false };
      if (y > 12) break;
      if (y < 3 && (c === WALL || (c === HIGH && y < 2.2) || (c === LOW && y < 0.85) || (c === DOOR && this.doorAtCell(cx, cz)!.open < 0.5 && y < 2.2) || (c === DOOR && y >= 2.2)))
        return { kind: 'wall' as const, x, y, z, d, actor: null, head: false };
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
  private resolve(a: Actor) {
    const r = a.r, x0 = Math.floor(a.x - r), x1 = Math.floor(a.x + r), z0 = Math.floor(a.z - r), z1 = Math.floor(a.z + r);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      if (!this.solidCell(cx, cz)) continue;
      const nx = Math.max(cx, Math.min(a.x, cx + 1)), nz = Math.max(cz, Math.min(a.z, cz + 1));
      let ex = a.x - nx, ez = a.z - nz; const d2 = ex * ex + ez * ez;
      if (d2 >= r * r) continue;
      if (d2 < 1e-9) { // centre inside the cell: push to nearest free side
        const opts: [number, number, number][] = [[a.x - cx, -1, 0], [cx + 1 - a.x, 1, 0], [a.z - cz, 0, -1], [cz + 1 - a.z, 0, 1]];
        opts.sort((p, q) => p[0] - q[0]);
        for (const [d, sx, sz] of opts) if (!this.solidCell(cx + sx, cz + sz)) { a.x += sx * (d + r); a.z += sz * (d + r); break; }
        continue;
      }
      const d = Math.sqrt(d2); ex /= d; ez /= d; a.x = nx + ex * r; a.z = nz + ez * r;
    }
  }
  movePlayer(dx: number, dz: number) {
    const p = this.player; if (!p.alive) return;
    if (p.cuff) { dx *= 0.2; dz *= 0.2; }
    this.moveCircle(p, dx, dz); this.pushTrail(p);
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
      if (this.cell(cx, cz) === DOOR) { const door = this.doorAtCell(cx, cz)!; if (door.open < 0.7) { this.setDoor(door, true); a.moving = false; a.yaw = turn(a.yaw, yawTo(dx, dz), 8 * dt); return; } }
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
  setDoor(door: Door, open: boolean) {
    const t = open ? 1 : 0; if (door.target === t) return;
    if (!open && this.actors.some(a => a.alive && Math.floor(a.x) === door.cx && Math.floor(a.z) === door.cz)) return;
    door.target = t; this.events.push({ t: 'door', door, open });
  }

  // ---------- combat ----------
  /** A player made a sound (e.g. landing after a jump). */
  playerNoise(p: Actor, radius: number) { this.noise(p.x, p.z, radius); }
  private noise(x: number, z: number, radius: number) {
    for (const s of this.suspects) if (s.active && !s.surrendered && Math.hypot(s.x - x, s.z - z) < radius) { if (s.alertT <= 0) s.lastSeen = { x, z }; s.alertT = Math.max(s.alertT, 8); }
  }
  fire(by: Actor, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, dmg: number) {
    const h = this.ray(ox, oy, oz, dx, dy, dz, 70, by);
    this.events.push({ t: 'shot', by, x: ox, y: oy, z: oz, x2: h.x, y2: h.y, z2: h.z, hit: h.kind });
    by.lastShotT = this.time; by.hasFired = true; this.stats.shotsFired += by.kind === 'suspect' ? 0 : 1;
    this.noise(ox, oz, 20);
    if (by.kind !== 'suspect') for (const c of this.civs) if (c.active && !c.surrendered && Math.hypot(c.x - ox, c.z - oz) < 12 && this.rng() < 0.2) c.panicT = 0;
    if (h.actor) this.damage(h.actor, dmg * (h.head ? 3 : 1), by, h.head);
    return h;
  }
  private aiFire(a: Actor, tg: Actor, spread: number, dmg: number) {
    if (a.reloadT > 0 || a.fireCd > 0) return;
    if (a.ammo <= 0) { a.reloadT = 2.2; a.ammo = 30; return; }
    const ty = tg.down ? 0.8 : tg.kind === 'player' && tg.prone ? 0.3 : tg.kind === 'player' && tg.crouch ? 0.9 : 1.2;
    let dx = tg.x - a.x, dy = ty - 1.4, dz = tg.z - a.z; const d = Math.hypot(dx, dy, dz); dx /= d; dy /= d; dz /= d;
    if (a.kind === 'officer') { // never shoot through friends or innocents
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
  damage(a: Actor, dmg: number, by: Actor, head: boolean) {
    if (!a.alive) return;
    if (a.kind === 'officer') dmg *= 0.42; if (a.kind === 'player') dmg *= [0.25, 0.36, 0.55][this.difficulty] ?? 0.36;
    a.hp -= dmg; this.events.push({ t: 'hurt', a, head });
    if (a.kind !== 'player') this.events.push({ t: 'bark', a, kind: a.hp <= 0 ? 'die' : 'pain' });
    const police = by.kind === 'player' || by.kind === 'officer';
    if (a.hp <= 0) {
      a.alive = false; a.hp = 0; a.moving = false; a.path = null; this.events.push({ t: 'death', a });
      if (a.kind === 'suspect') { this.stats.suspectsKilled++; if (police && (a.down || (!a.hostile && !a.hasFired && a.firstChallengeT === Infinity))) { this.stats.unauthorized++; this.events.push({ t: 'info', text: 'Otillåtet våld: misstänkt sköts utan varning' }); } }
      if (a.kind === 'civ') { this.stats.civsKilled++; if (police) { this.stats.civsKilledByPolice++; this.events.push({ t: 'info', text: 'En civil har dödats av polisen!' }); } }
      if (a.kind === 'officer') { this.stats.officersDown++; const m = this.officers.find(o => o.alive && o.team === a.team) ?? this.officers.find(o => o.alive); if (m) this.say(m, `${a.name} är nere!`); }
      if (a.kind === 'player') { if (!this.players.some(p => p.alive)) this.finish(false); else this.events.push({ t: 'info', text: `${a.name} är nere!` }); }
      if (a.claimedBy) { a.claimedBy.cuff = null; a.claimedBy = null; }
      return;
    }
    if (a.kind === 'suspect' && !a.down) {
      a.alertT = 8; if (!a.lastSeen) a.lastSeen = { x: by.x, z: by.z }; a.stun = Math.max(a.stun, 0.25);
      if (this.rng() < 0.22) this.surrender(a);
    }
    if (a.kind === 'officer' && a.hp < 45 && this.rng() < 0.5) this.say(a, 'Jag är träffad!');
  }
  private surrender(a: Actor) {
    if (a.surrendered) return;
    a.surrendered = true; a.armed = false; a.path = null; a.moving = false; a.target = null; a.unwatchedT = 0;
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
    if (this.rng() < p) this.surrender(a); else a.alertT = 8;
  }
  playerShout(p: Actor = this.player) {
    const f = fwd(p.yaw); this.events.push({ t: 'shout', a: p }); let n = 0;
    for (const a of this.actors) {
      if ((a.kind !== 'suspect' && a.kind !== 'civ') || !a.active || a.surrendered) continue;
      const dx = a.x - p.x, dz = a.z - p.z, d = Math.hypot(dx, dz);
      if (d > 14 || !this.los(p.x, p.z, a.x, a.z)) continue;
      if (d > 3 && (dx * f.x + dz * f.z) / d < 0.25) continue;
      this.challenge(a, 0.05); n++;
    }
    this.noise(p.x, p.z, 9);
    return n;
  }
  throwBang(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, speed = 11) {
    this.grenades.push({ x: ox, y: oy, z: oz, vx: dx * speed, vy: dy * speed + 1.5, vz: dz * speed, t: 1.5 });
    this.events.push({ t: 'throw', x: ox, z: oz });
  }
  private updateGrenades(dt: number) {
    for (const g of this.grenades) {
      g.t -= dt; g.vy -= 9.8 * dt;
      const nx = g.x + g.vx * dt, nz = g.z + g.vz * dt;
      const blk = (x: number, z: number) => { const c = this.cell(Math.floor(x), Math.floor(z)); return this.opaqueCell(Math.floor(x), Math.floor(z)) || (c === LOW && g.y < 0.85); };
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
    for (const a of this.actors) {
      if (!a.alive) continue; const d = Math.hypot(a.x - x, a.z - z);
      if (d > 9 || !this.los(x, z, a.x, a.z)) continue;
      const k = 1 - d / 10;
      if (a.kind === 'player') { const facing = Math.abs(angDiff(a.yaw, yawTo(x - a.x, z - a.z))) < 1.2; a.flash = Math.max(a.flash, facing ? k : k * 0.4); }
      else if (a.kind === 'officer') a.stun = Math.max(a.stun, 1.5 * k);
      else { a.stun = Math.max(a.stun, 2.5 + 4.5 * k); a.path = null; a.moving = false; if (a.kind === 'civ' || this.rng() < 0.45) this.surrender(a); }
    }
  }

  // ---------- speech ----------
  say(a: Actor, text: string, shout = false) { this.events.push({ t: 'say', a, text, shout }); }
  private lead(team: Team) { return this.officers.find(o => o.alive && o.team === team); }
  members(team: Team) { return this.officers.filter(o => o.alive && o.team === team); }

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
  private stackPts(door: Door, side: number, offset: number): Pt[] {
    const out: Pt[] = []; const c = { x: door.cx + 0.5, z: door.cz + 0.5 };
    const mk = (lat: number, row: number) => door.horiz ? { x: c.x + lat, z: c.z + side * row } : { x: c.x + side * row, z: c.z + lat };
    for (const [lat, row] of [[-1, 1], [1, 1], [-1, 2], [1, 2], [0, 2.2], [0, 3.2], [-1, 3], [1, 3]]) {
      const p = mk(lat, row); if (!this.solidCell(Math.floor(p.x), Math.floor(p.z)) && this.cell(Math.floor(p.x), Math.floor(p.z)) !== DOOR) out.push(p);
    }
    while (out.length < offset + 2) out.push(mk(0, 1.2 + out.length));
    return out.slice(offset, offset + 2);
  }
  private clearPts(door: Door, side: number, offset: number): Pt[] {
    const c = { x: door.cx + 0.5, z: door.cz + 0.5 };
    const beyond = door.horiz ? { x: c.x, z: c.z - side } : { x: c.x - side, z: c.z };
    const room: Room | null = roomAt(this.level, beyond.x, beyond.z);
    let pts: Pt[] = [];
    if (room) {
      const x0 = room.x + 1.5, x1 = room.x + room.w - 1.5, z0 = room.z + 1.5, z1 = room.z + room.h - 1.5;
      const ix = Math.min(1.5, (x1 - x0) / 3), iz = Math.min(1.5, (z1 - z0) / 3);
      for (const [x, z] of [[x0 + ix, z0 + iz], [x1 - ix, z0 + iz], [x0 + ix, z1 - iz], [x1 - ix, z1 - iz]]) {
        // keep points within ~9 m of the door for huge rooms
        let q = { x, z }; const dd = dist(q, beyond); if (dd > 9) q = { x: beyond.x + ((x - beyond.x) * 9) / dd, z: beyond.z + ((z - beyond.z) * 9) / dd };
        const n = nearestWalkable(this.level, q.x, q.z, 3); if (n) pts.push(n);
      }
      pts.sort((a, b) => dist(a, beyond) - dist(b, beyond));
    } else {
      const mk = (lat: number, row: number) => door.horiz ? { x: c.x + lat, z: c.z - side * row } : { x: c.x - side * row, z: c.z + lat };
      for (const [lat, row] of [[-1.5, 2], [1.5, 2], [-1.5, 4], [1.5, 4]]) { const n = nearestWalkable(this.level, mk(lat, row).x, mk(lat, row).z, 2); if (n) pts.push(n); }
    }
    while (pts.length < 4) pts.push(beyond);
    return pts.slice(offset, offset + 2);
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

  command(cmd: Command, aim: Pt | null = null, by: Actor = this.player): boolean {
    if (this.over) return false;
    const teams: Team[] = cmd.team === 'ALL' ? ['A', 'B'] : [cmd.team]; let any = false;
    for (const team of teams) {
      const lead = this.lead(team); if (!lead) continue; any = true;
      const off = cmd.team === 'ALL' && team === 'B' ? 2 : 0, T = this.teams[team];
      const set = (o: Order) => { for (const m of this.members(team)) { m.path = null; m.goal = null; if (m.cuff && o.type !== 'restrain') { m.cuff.claimedBy = null; m.cuff = null; } } T.order = o; };
      const tag = `Team ${team}: `;
      switch (cmd.action) {
        case 'follow': set({ type: 'follow', phase: 0, t: 0, leader: by }); this.say(lead, tag + 'Uppfattat, följer dig.'); break;
        case 'cover': set({ type: 'cover', phase: 0, t: 0, leader: by }); this.say(lead, tag + 'Vi täcker dig.'); break;
        case 'hold': set({ type: 'hold', phase: 0, t: 0, pts: this.officers.filter(o => o.team === team).map(o => ({ x: o.x, z: o.z })) }); this.say(lead, tag + 'Håller position.'); break;
        case 'move': {
          const tg = this.dirTarget(cmd.dir ?? 'forward', aim, by);
          if (!tg) { this.say(lead, tag + 'Kan inte ta mig dit.'); break; }
          const f = fwd(tg.face), side = { x: -f.z, z: f.x }; const pts: Pt[] = [];
          for (let i = 0; i < 2; i++) { const k = (i ? 0.7 : -0.7) * (off ? 1.9 : 1); const q = { x: tg.p.x + side.x * k, z: tg.p.z + side.z * k }; pts.push(!this.solidCell(Math.floor(q.x), Math.floor(q.z)) && walkLine(this.level, tg.p, q) ? q : tg.p); }
          set({ type: 'move', phase: 0, t: 0, pts, face: tg.face }); this.events.push({ t: 'marker', x: tg.p.x, z: tg.p.z, team });
          this.say(lead, tag + ({ left: 'Går vänster.', right: 'Går höger.', forward: 'Rycker fram.', back: 'Drar oss tillbaka.', there: 'Förflyttar oss dit.' } as const)[cmd.dir ?? 'forward']); break;
        }
        case 'stack': case 'breach': case 'bang': case 'open': case 'close': {
          const door = this.aimedDoor(by); if (!door) { this.say(lead, tag + 'Ser ingen dörr.'); break; }
          const side = this.doorSide(door, by), pts = this.stackPts(door, side, off);
          const c = { x: door.cx + 0.5, z: door.cz + 0.5 }; this.events.push({ t: 'marker', x: c.x, z: c.z, team });
          if (cmd.action === 'stack') { set({ type: 'stack', phase: 0, t: 0, pts, door, side }); this.say(lead, tag + 'Ställer upp vid dörren.'); }
          else if (cmd.action === 'open' || cmd.action === 'close') { set({ type: 'door', phase: 0, t: 0, pts, door, side, open: cmd.action === 'open' }); this.say(lead, tag + (cmd.action === 'open' ? 'Öppnar dörren.' : 'Stänger dörren.')); }
          else { set({ type: 'breach', phase: 0, t: 0, pts, door, side, off, bang: cmd.action === 'bang' }); this.say(lead, tag + (cmd.action === 'bang' ? 'Chockgranat och in!' : 'Stormar!')); }
          break;
        }
        case 'restrain': {
          const n = this.assignCuffs(team, 16);
          if (n) { if (T.order.type !== 'restrain') set({ type: 'restrain', phase: 0, t: 0, prev: T.order }); this.assignCuffs(team, 16); this.say(lead, tag + 'Säkrar.'); }
          else this.say(lead, tag + 'Ingen att säkra här.');
          break;
        }
        case 'fireHold': T.fire = 'hold'; this.say(lead, tag + 'Eld upphör. Skjuter bara om vi blir beskjutna.'); break;
        case 'fireFree': T.fire = 'free'; this.say(lead, tag + 'Fri eld.'); break;
        case 'report': { const m = this.members(team); this.say(lead, tag + `${m.length} man. ${m.some(o => o.hp < 60) ? 'Vi har skadade.' : 'Inga skador.'}`); break; }
        case 'shout': break;
      }
    }
    return any;
  }
  private assignCuffs(team: Team, range: number) {
    let n = 0;
    for (const o of this.members(team)) {
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

  private updateTeam(team: Team, dt: number) {
    const T = this.teams[team], o = T.order, mem = this.members(team); if (!mem.length) return;
    o.t += dt;
    // officers cuff anyone who has given up nearby without being told (otherwise civilians run off again)
    if ((o.type === 'follow' || o.type === 'hold' || o.type === 'cover' || o.type === 'move') && Math.floor(this.time * 2) !== Math.floor((this.time - dt) * 2) && !mem.some(m => m.target)) {
      const had = mem.filter(m => m.cuff).length; if (this.assignCuffs(team, 7) > had && this.time - (T.cuffSay ?? -99) > 6) { T.cuffSay = this.time; this.say(mem[0], `Team ${team}: Säkrar personer.`); }
    }
    const arrived = () => mem.every(m => dist(m, o.pts![m.ti] ?? m) < 0.7);
    if (o.type === 'door') {
      if (arrived() || o.t > 6) { this.setDoor(o.door!, !!o.open); T.order = { type: 'stack', phase: 0, t: 0, pts: o.pts, door: o.door, side: o.side }; }
    } else if (o.type === 'breach') {
      const door = o.door!, c = { x: door.cx + 0.5, z: door.cz + 0.5 }, side = o.side!;
      if (o.phase === 0 && (arrived() || o.t > 6)) {
        o.phase = 1; o.t = 0; this.setDoor(door, true);
        if (o.bang) { const d = door.horiz ? { x: 0, z: -side } : { x: -side, z: 0 }; this.grenades.push({ x: c.x + d.x * 0.7, y: 1.0, z: c.z + d.z * 0.7, vx: d.x * 5.5, vy: 1, vz: d.z * 5.5, t: 1.3 }); this.events.push({ t: 'throw', x: c.x, z: c.z }); this.say(mem[0], 'Granat ute!'); }
      } else if (o.phase === 1 && o.t > (o.bang ? 1.45 : 0.45)) {
        o.phase = 2; o.t = 0; o.pts = this.clearPts(door, side, o.off ?? 0);
        for (const m of mem) { m.path = null; m.goal = null; }
      } else if (o.phase === 2 && ((arrived() && o.t > 1.5) || o.t > 9) && !mem.some(m => m.target)) {
        const got = this.assignCuffs(team, 9);
        this.say(mem[0], `Team ${team}: Rummet säkrat.` + (got ? ' Säkrar personer.' : ''));
        const hold: Order = { type: 'hold', phase: 0, t: 0, pts: o.pts };
        T.order = got ? { type: 'restrain', phase: 0, t: 0, prev: hold } : hold;
      }
    } else if (o.type === 'restrain') {
      if (!mem.some(m => m.cuff) && !this.assignCuffs(team, 9)) { T.order = o.prev ?? { type: 'follow', phase: 0, t: 0, leader: o.leader }; T.order.t = 0; for (const m of mem) { m.path = null; m.goal = null; } }
    }
  }

  private pickThreat(o: Actor): Actor | null {
    let best: Actor | null = null, bd = 1e9;
    for (const s of this.suspects) {
      if (!s.alive || s.down || !s.armed) continue;
      const d = dist(o, s); if (d > 40 || d >= bd) continue;
      const recent = this.time - s.lastShotT < 2.5;
      if (recent ? this.los(o.x, o.z, s.x, s.z) : this.sees(o, s, 40, 3.4)) { bd = d; best = s; }
    }
    return best;
  }
  private updateOfficer(o: Actor, dt: number) {
    if (o.stun > 0) { o.stun -= dt; o.moving = false; return; }
    const T = this.teams[o.team], ord = T.order;
    o.percT -= dt; if (o.percT <= 0) { o.percT = 0.12; o.target = this.pickThreat(o); }
    const th = o.target;
    if (th && th.alive && !th.down) {
      const want = yawTo(th.x - o.x, th.z - o.z); o.yaw = turn(o.yaw, want, 10 * dt); o.moving = false;
      if (this.time - th.challengeT > 2.5) { this.say(o, 'Polis! Släpp vapnet!', true); this.challenge(th, dist(o, th) < 8 ? 0.05 : 0); if (th.down) return; }
      const mayFire = th.hasFired || (T.fire === 'free' && (th.hostile || this.time - th.firstChallengeT > 0.9));
      if (Math.abs(angDiff(o.yaw, want)) < 0.12) o.aimT += dt; else o.aimT = 0;
      if (mayFire && o.aimT > 0.22) this.aiFire(o, th, 0.035, 34);
      return;
    }
    o.aimT = 0;
    if (o.cuff) {
      const c = o.cuff;
      if (!c.alive || c.restrained || !c.surrendered) { c.claimedBy = null; o.cuff = null; }
      else if (dist(o, c) > 1.0) { this.goTo(o, c.x, c.z, dt, 1, 0.95); return; }
      else { o.moving = false; o.yaw = turn(o.yaw, yawTo(c.x - o.x, c.z - o.z), 8 * dt); o.cuffT += dt; if (o.cuffT > 2) { this.restrain(c, o); o.cuff = null; o.cuffT = 0; } return; }
    }
    let dest: Pt | null = null, face: number | null = null;
    const p = this.leaderOf(ord.type === 'restrain' && ord.prev ? ord.prev : ord);
    if (ord.type === 'follow' || ord.type === 'restrain') { dest = this.trailPoint(1.4 + o.slot * 1.05, p); if (dist(o, p) < 1.3 + o.slot * 0.5 && !o.path) dest = null; }
    else if (ord.type === 'cover') { dest = this.trailPoint(1.1 + o.ti * 0.9, p); face = p.yaw + Math.PI + (o.ti ? 0.9 : -0.9); if (dist(o, p) < 1.4 + o.ti * 0.6 && !o.path) dest = null; }
    else if (ord.pts) { dest = ord.pts[o.ti] ?? ord.pts[0]; face = ord.face ?? null; }
    if (ord.type === 'breach' && ord.phase === 1) { dest = null; }
    if ((ord.type === 'stack' || ord.type === 'door' || (ord.type === 'breach' && ord.phase < 2)) && ord.door) face = yawTo(ord.door.cx + 0.5 - o.x, ord.door.cz + 0.5 - o.z);
    const arrived = dest ? this.goTo(o, dest.x, dest.z, dt, ord.type === 'breach' && ord.phase === 2 ? 1.15 : 1) : (o.moving = false, true);
    if (arrived && face !== null) o.yaw = turn(o.yaw, face, 5 * dt);
    else if (arrived && (ord.type === 'follow') && dist(o, p) < 4) o.yaw = turn(o.yaw, p.yaw + (o.slot % 2 ? -0.5 : 0.5) * (o.slot > 1 ? 2.2 : 1), 3 * dt);
  }
  private restrain(c: Actor, by: Actor) {
    c.restrained = true; c.surrendered = true; c.armed = false; c.claimedBy = null; this.events.push({ t: 'cuff', a: c, by });
    if (c.kind === 'suspect') this.stats.suspectsArrested++; else this.stats.civsSecured++;
    if (by.kind === 'officer') this.say(by, c.kind === 'suspect' ? 'Misstänkt säkrad.' : 'Civil säkrad.');
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
      const watched = this.actors.some(o => (o.kind === 'player' || o.kind === 'officer') && o.alive && dist(o, s) < 14 && this.los(o.x, o.z, s.x, s.z));
      s.unwatchedT = watched ? 0 : s.unwatchedT + dt;
      if (s.unwatchedT > 10 && s.morale > 0.65 && !s.claimedBy) { s.surrendered = false; s.armed = true; s.unwatchedT = 0; s.alertT = 8; s.rolls = 2; this.events.push({ t: 'bark', a: s, kind: 'unrest' }); }
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
        if (s.hunter && s.lostT > 1.2) { if (this.goTo(s, s.lastSeen.x, s.lastSeen.z, dt, 0.8, 0.8)) s.lastSeen = null; }
        else { s.moving = false; s.yaw = turn(s.yaw, yawTo(s.lastSeen.x - s.x, s.lastSeen.z - s.z), 4 * dt); }
      } else s.moving = false;
      return;
    }
    s.timer -= dt;
    if (s.timer <= 0) { s.timer = 4 + this.rng() * 8; s.goal = null; s.path = null; s.lastSeen = this.rng() < 0.6 ? this.randomRoomPoint(s.room) : null; }
    if (s.lastSeen) { if (this.goTo(s, s.lastSeen.x, s.lastSeen.z, dt, 0.4)) s.lastSeen = null; } else s.moving = false;
  }
  private updateCiv(c: Actor, dt: number) {
    if (c.stun > 0) { c.stun -= dt; c.moving = false; return; }
    const police = (r: number) => this.actors.some(o => (o.kind === 'player' || o.kind === 'officer') && o.alive && dist(o, c) < r && this.los(o.x, o.z, c.x, c.z));
    if (c.surrendered) { // on the knees, hands up – but without handcuffs they get up and run once nobody is watching
      c.unwatchedT = c.claimedBy || this.players.some(pl => pl.cuff === c) || police(11) ? 0 : c.unwatchedT + dt;
      if (c.unwatchedT > 7) { c.surrendered = false; c.unwatchedT = 0; c.seeT = -4; c.panicT = 6 + this.rng() * 4; c.lastSeen = this.randomRoomPoint(Math.floor(this.rng() * this.level.rooms.length)); this.events.push({ t: 'bark', a: c, kind: 'panic' }); this.events.push({ t: 'info', text: 'En civil utan handbojor sprang iväg.' }); }
      return;
    }
    if (c.panicT > 0) {
      c.panicT -= dt;
      if (!c.lastSeen) c.lastSeen = this.randomRoomPoint(c.room);
      if (!c.lastSeen || this.goTo(c, c.lastSeen.x, c.lastSeen.z, dt, 1)) c.lastSeen = null;
      return;
    }
    c.moving = false; c.path = null;
    // a civilian who sees the police close by gives up on their own: down on the knees, hands up
    c.seeT = police(8) ? c.seeT + dt : Math.min(0, c.seeT); if (c.seeT > 0.9) { c.seeT = 0; this.surrender(c); }
  }

  // ---------- player interaction ----------
  interactTarget(p: Actor = this.player): { actor?: Actor; door?: Door } | null {
    const f = fwd(p.yaw);
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
    if (t.door) this.setDoor(t.door, t.door.target === 0);
    else if (t.actor) { if (t.actor.claimedBy) { t.actor.claimedBy.cuff = null; t.actor.claimedBy = null; } p.cuff = t.actor; p.cuffT = 0; }
  }

  /** Call after removing a player (disconnect): fails the mission when nobody is left. */
  checkPlayers() { if (!this.players.some(p => p.alive)) this.finish(false); }
  private finish(win: boolean) { if (this.over) return; this.over = { win }; this.events.push({ t: 'end', win }); }
  remaining() {
    return { suspects: this.suspects.filter(s => s.alive && !s.restrained).length, civs: this.civs.filter(c => c.alive && !c.restrained).length };
  }
  score() {
    const s = this.stats, ns = this.suspects.length, nc = this.civs.length, done = this.over?.win ? 1 : 0;
    const parts = [
      { label: 'Uppdraget slutfört', pts: 40 * done, max: 40 },
      { label: `Misstänkta gripna levande (${s.suspectsArrested}/${ns})`, pts: Math.round((25 * s.suspectsArrested) / ns), max: 25 },
      { label: `Civila i säkerhet (${this.civs.filter(c => c.alive && c.restrained).length}/${nc})`, pts: Math.round((20 * this.civs.filter(c => c.alive && c.restrained).length) / nc), max: 20 },
      { label: `Teamet oskadat (${4 - s.officersDown}/4)`, pts: Math.round((15 * (4 - s.officersDown)) / 4), max: 15 },
      { label: `Otillåtet våld (${s.unauthorized})`, pts: -10 * s.unauthorized, max: 0 },
      { label: `Civila dödade av polis (${s.civsKilledByPolice})`, pts: -20 * s.civsKilledByPolice, max: 0 },
    ];
    const total = Math.max(0, Math.min(100, parts.reduce((a, p) => a + p.pts, 0)));
    const rank = total >= 90 ? 'Insatschef' : total >= 75 ? 'Veteran' : total >= 55 ? 'Operatör' : total >= 35 ? 'Aspirant' : 'Underkänd';
    return { parts, total, rank };
  }

  update(dt: number) {
    if (this.over) { for (const d of this.level.doors) d.open += Math.max(-dt * 2.8, Math.min(dt * 2.8, d.target - d.open)); return; }
    this.time += dt;
    for (const d of this.level.doors) d.open += Math.max(-dt * 2.8, Math.min(dt * 2.8, d.target - d.open));
    for (const p of this.players) {
      // footsteps: running is heard far away, walking nearby; sneaking, crouching and crawling are silent
      if (p.alive) {
        p.nd += Math.hypot(p.x - p.nx, p.z - p.nz); p.nx = p.x; p.nz = p.z; p.nt += dt;
        if (p.nt >= 0.4) { const v = p.nd / p.nt; p.nd = 0; p.nt = 0; if (!p.prone && v < 9) { if (v > 4.4) this.noise(p.x, p.z, 12); else if (v > 2.4) this.noise(p.x, p.z, 6); } }
      }
      p.flash = Math.max(0, p.flash - dt * 0.22);
      if (p.cuff) {
        const c = p.cuff;
        if (!p.alive || !c.alive || c.restrained || !c.surrendered || dist(c, p) > 2.3) p.cuff = null;
        else { p.cuffT += dt; if (p.cuffT > 1.6) { this.restrain(c, p); p.cuff = null; } }
      }
    }
    this.updateTeam('A', dt); this.updateTeam('B', dt);
    for (const a of this.actors) {
      a.fireCd -= dt; if (a.reloadT > 0) a.reloadT -= dt;
      if (!a.alive) { a.deadT += dt; continue; }
      if (a.restrained) continue;
      if (a.kind === 'officer') this.updateOfficer(a, dt); else if (a.kind === 'suspect') this.updateSuspect(a, dt); else if (a.kind === 'civ') this.updateCiv(a, dt);
    }
    // separation
    const A = this.actors;
    for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
      const a = A[i], b = A[j]; if (!a.alive || !b.alive) continue;
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = a.r + b.r; if (d >= min || d < 1e-5) continue;
      const fa = a.kind === 'player' || a.down ? 0 : 1, fb = b.kind === 'player' || b.down ? 0 : 1; if (!fa && !fb) { if (a.kind === 'player') { a.x -= (dx / d) * (min - d); a.z -= (dz / d) * (min - d); this.resolve(a); } continue; }
      const push = min - d, wa = fa / (fa + fb), wb = fb / (fa + fb);
      a.x -= (dx / d) * push * wa; a.z -= (dz / d) * push * wa; b.x += (dx / d) * push * wb; b.z += (dz / d) * push * wb;
      if (fa) this.resolve(a); if (fb) this.resolve(b);
    }
    this.updateGrenades(dt);
    this.checkT -= dt;
    if (this.checkT <= 0) { this.checkT = 0.5; const r = this.remaining(); if (r.suspects === 0 && r.civs === 0) this.finish(true); }
  }
}
