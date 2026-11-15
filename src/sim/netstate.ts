// Host-authoritative co-op: the host runs the Sim, clients keep a mirror Sim built from the same
// mission+seed (identical level and actor ids) and apply compact snapshots + forwarded events.
import { Sim, Actor, Ev, Team, Order } from './sim';
import type { Door } from './level';

const r2 = (v: number) => Math.round(v * 100) / 100;
export interface Snap {
  a: number[][]; d: number[]; o: [string, string, number][]; so?: string[];
  g: number[][]; p: number[][];
  pw?: number; bm?: [number, number] | null; bw?: number[];
  over: number; time: number; st?: unknown;
}

export function encodeSnap(sim: Sim): Snap {
  return {
    a: sim.actors.map(a => [r2(a.x), r2(a.z), r2(a.yaw), Math.round(a.hp),
      (a.alive ? 1 : 0) | (a.surrendered ? 2 : 0) | (a.restrained ? 4 : 0) | (a.armed ? 8 : 0) | (a.moving ? 16 : 0) | (a.target ? 32 : 0) | (a.crouch ? 64 : 0) | (a.hostile ? 128 : 0) | (a.prone ? 256 : 0) | (a.team === 'B' ? 512 : 0),
      r2(a.walk % (Math.PI * 2)), r2(a.stun)]),
    d: sim.level.doors.map(d => Math.round(d.open * 100) + d.target * 1000 + (d.locked ? 10000 : 0) + (d.wedged ? 20000 : 0)),
    o: (['A', 'B'] as Team[]).map(t => [sim.teams[t].order.type, sim.teams[t].fire, sim.teams[t].order.leader?.id ?? -1]),
    so: sim.officers.map(o => o.solo ? o.solo.order.type : ''),
    g: sim.grenades.map(g => [r2(g.x), r2(g.y), r2(g.z)]),
    p: sim.players.map(p => [p.bangs, r2(p.flash), p.cuff ? p.cuff.id : -1, r2(p.cuffT), p.c2, p.wedges]),
    pw: sim.powerOn ? 1 : 0,
    bm: sim.bomb ? [r2(sim.bomb.time), sim.bomb.defused ? 1 : 0] : null,
    bw: sim.brokenWindows.size ? [...sim.brokenWindows] : undefined,
    over: sim.over ? (sim.over.win ? 2 : 1) : 0, time: r2(sim.time), st: sim.over ? sim.stats : undefined,
  };
}

export function applySnap(sim: Sim, s: Snap, me: Actor) {
  s.a.forEach((v, i) => {
    const a = sim.actors[i]; if (!a) return; const f = v[4];
    if (a !== me) { a.x = v[0]; a.z = v[1]; a.yaw = v[2]; a.crouch = !!(f & 64); a.prone = !!(f & 256); a.moving = !!(f & 16); a.walk = v[5]; }
    a.hp = v[3]; a.alive = !!(f & 1); a.surrendered = !!(f & 2); a.restrained = !!(f & 4); a.armed = !!(f & 8); a.target = f & 32 ? a : null; a.hostile = !!(f & 128); a.stun = v[6];
    if (a.kind === 'officer') a.team = f & 512 ? 'B' : 'A';
    if (!a.alive) a.moving = false;
  });
  sim.reindexTeams();
  s.d.forEach((v, i) => {
    const d = sim.level.doors[i];
    d.wedged = v >= 20000;
    const rem = v % 20000;
    d.locked = rem >= 10000;
    const rem2 = rem % 10000;
    d.target = rem2 >= 1000 ? 1 : 0;
    d.open = (rem2 % 1000) / 100;
  });
  s.o.forEach((v, i) => { const T = sim.teams[i ? 'B' : 'A']; T.order = { type: v[0] as Order['type'], phase: 0, t: 0, leader: sim.actors[v[2]] }; T.fire = v[1] as 'free' | 'hold'; });
  s.so?.forEach((v, i) => { const o = sim.officers[i]; if (o) o.solo = v ? { order: { type: v as Order['type'], phase: 0, t: 0 } } : null; });
  sim.grenades = s.g.map(g => ({ x: g[0], y: g[1], z: g[2], vx: 0, vy: 0, vz: 0, t: 1 }));
  s.p.forEach((v, i) => {
    const p = sim.players[i]; if (!p) return;
    p.bangs = v[0]; p.flash = v[1]; p.cuff = v[2] >= 0 ? sim.actors[v[2]] : null; p.cuffT = v[3];
    if (v.length > 4) { p.c2 = v[4]; p.wedges = v[5]; }
  });
  if (s.pw !== undefined) sim.powerOn = !!s.pw;
  if (s.bm && sim.bomb) { sim.bomb.time = s.bm[0]; sim.bomb.defused = !!s.bm[1]; }
  if (s.bw) for (const k of s.bw) sim.brokenWindows.add(k);
  sim.time = s.time;
  if (s.over && !sim.over) { if (s.st) Object.assign(sim.stats, s.st); sim.over = { win: s.over === 2 }; }
}

export function encodeEv(e: Ev): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) o[k] = v instanceof Actor ? { $a: v.id } : k === 'door' ? { $d: (v as Door).id } : typeof v === 'number' ? r2(v) : v;
  return o;
}
export function decodeEv(sim: Sim, o: Record<string, any>): Ev {
  const e: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) e[k] = v && typeof v === 'object' && '$a' in v ? sim.actors[v.$a] : v && typeof v === 'object' && '$d' in v ? sim.level.doors[v.$d] : v;
  return e as unknown as Ev;
}
