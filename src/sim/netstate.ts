// Host-authoritative co-op: the host runs the Sim, clients keep a mirror Sim built from the same
// mission+seed (identical level and actor ids) and apply compact snapshots + forwarded events.
import { Sim, Actor, Ev, Team, Order, ReplayFrame, ReplayEvent, GrenadeKind } from './sim';
import type { Door } from './level';

const r2 = (v: number) => Math.round(v * 100) / 100;
export interface Snap {
  a: number[][]; d: number[]; dt?: number[]; o: [string, string, number][]; so?: string[];
  g: number[][]; cl?: [number, number, number, number, number][]; p: number[][];
  ev?: [number, number, number, number, number, number][];
  sp?: [number, number, number][]; ln?: number[];
  pw?: number; bm?: [number, number] | null; bw?: number[]; bp?: number[]; bd?: number[];
  bs?: number;
  over: number; time: number; st?: unknown;
  mvp?: { name: string; arrests: number; kills: number; shots: number; hits: number; dmgTaken: number }[];
  rf?: ReplayFrame[]; re?: ReplayEvent[];
}

export interface NetTarget { x: number; z: number; yaw: number }

export function encodeSnap(sim: Sim): Snap {
  return {
    a: sim.actors.map(a => [r2(a.x), r2(a.z), r2(a.yaw), Math.round(a.hp),
      (a.alive ? 1 : 0) | (a.surrendered ? 2 : 0) | (a.restrained ? 4 : 0) | (a.armed ? 8 : 0)
      | (a.moving ? 16 : 0) | (a.target ? 32 : 0) | (a.crouch ? 64 : 0) | (a.hostile ? 128 : 0)
      | (a.prone ? 256 : 0) | (a.team === 'B' ? 512 : 0)
      | (a.downed ? 1024 : 0) | (a.torch ? 2048 : 0) | (a.ads ? 4096 : 0)
      | (a.shield ? 8192 : 0) | (a.speaking ? 16384 : 0) | (a.readyBreach ? 32768 : 0),
      r2(a.walk % (Math.PI * 2)), r2(a.stun),
      ...(a.kind === 'player' ? [r2(a.pitch), a.weapon] : [])]),
    d: sim.level.doors.map(d => Math.round(d.open * 100) + d.target * 1000 + (d.locked ? 10000 : 0) + (d.wedged ? 20000 : 0)),
    dt: sim.level.doors.some(d => d.trapped || d.trapKnown) ? sim.level.doors.map(d => (d.trapped ? 1 : 0) | (d.trapKnown ? 2 : 0)) : undefined,
    o: (['A', 'B'] as Team[]).map(t => [sim.teams[t].order.type, sim.teams[t].fire, sim.teams[t].order.leader?.id ?? -1]),
    so: sim.officers.map(o => o.solo ? o.solo.order.type : ''),
    g: sim.grenades.map(g => [r2(g.x), r2(g.y), r2(g.z), g.kind === 'smoke' ? 1 : g.kind === 'gas' ? 2 : 0]),
    cl: sim.clouds.length ? sim.clouds.map(c => [c.kind === 'gas' ? 1 : 0, r2(c.x), r2(c.z), r2(c.r), r2(c.t)]) : undefined,
    p: sim.players.map(p => [p.bangs, r2(p.flash), p.cuff ? p.cuff.id : -1, r2(p.cuffT), p.c2, p.wedges, Math.round(p.bleedT), p.reviving ? p.reviving.id : -1, r2(p.reviveT), p.smokes, p.gases, p.sensors]),
    ev: sim.evidence.length ? sim.evidence.map(e => [e.id, r2(e.x), r2(e.z), r2(e.yaw), e.kind === 'shotgun' ? 2 : e.kind === 'rifle' ? 1 : 0, e.secured ? 1 : 0]) : undefined,
    sp: sim.sensorPings.length ? sim.sensorPings.map(pg => [r2(pg.x), r2(pg.z), pg.kind === 'suspect' ? 1 : 0]) : undefined,
    ln: sim.actors.map(a => r2(a.lean)),
    pw: sim.powerOn ? 1 : 0,
    bm: sim.bomb ? [r2(sim.bomb.time), sim.bomb.defused ? 1 : 0] : null,
    bw: sim.brokenWindows.size ? [...sim.brokenWindows] : undefined,
    bp: sim.brokenProps.size ? [...sim.brokenProps] : undefined,
    bd: sim.brokenDoorGlass.size ? [...sim.brokenDoorGlass] : undefined,
    bs: sim.breachSyncT > 0 ? r2(sim.breachSyncT) : 0,
    over: sim.over ? (sim.over.win ? 2 : 1) : 0, time: r2(sim.time), st: sim.over ? sim.stats : undefined,
    mvp: sim.over ? sim.players.map(pl => ({ name: pl.name, arrests: pl.arrests, kills: pl.kills, shots: pl.shots, hits: pl.hits, dmgTaken: pl.dmgTaken })) : undefined,
    rf: sim.over ? sim.replayFrames : undefined,
    re: sim.over ? sim.replayEvents : undefined,
  };
}

export function applySnap(sim: Sim, s: Snap, me: Actor, targets?: Map<Actor, NetTarget>) {
  s.a.forEach((v, i) => {
    const a = sim.actors[i]; if (!a) return; const f = v[4];
    if (a !== me) {
      if (targets) {
        const cur = targets.get(a);
        // Snap immediately on large teleports (reconnect/spawn), otherwise lerp smoothly
        if (!cur || Math.hypot(v[0] - a.x, v[1] - a.z) > 3.5) {
          a.x = v[0]; a.z = v[1]; a.yaw = v[2];
        }
        targets.set(a, { x: v[0], z: v[1], yaw: v[2] });
      } else {
        a.x = v[0]; a.z = v[1]; a.yaw = v[2];
      }
      a.crouch = !!(f & 64); a.prone = !!(f & 256); a.moving = !!(f & 16); a.walk = v[5];
      a.lean = Math.max(-1, Math.min(1, s.ln?.[i] ?? 0));
      a.torch = !!(f & 2048); a.ads = !!(f & 4096); a.shield = !!(f & 8192); a.speaking = !!(f & 16384);
      if (v.length > 7) { a.pitch = v[7]; a.weapon = v[8]; }
    }
    a.hp = v[3]; a.alive = !!(f & 1); a.surrendered = !!(f & 2); a.restrained = !!(f & 4); a.armed = !!(f & 8); a.target = f & 32 ? a : null; a.hostile = !!(f & 128); a.stun = v[6];
    a.downed = !!(f & 1024); a.readyBreach = !!(f & 32768);
    if (a.kind === 'officer') a.team = f & 512 ? 'B' : 'A';
    if (!a.alive || a.downed) a.moving = false;
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
    const tf = s.dt?.[i] ?? 0;
    d.trapped = !!(tf & 1);
    d.trapKnown = !!(tf & 2);
  });
  s.o.forEach((v, i) => { const T = sim.teams[i ? 'B' : 'A']; T.order = { type: v[0] as Order['type'], phase: 0, t: 0, leader: sim.actors[v[2]] }; T.fire = v[1] as 'free' | 'hold'; });
  s.so?.forEach((v, i) => { const o = sim.officers[i]; if (o) o.solo = v ? { order: { type: v as Order['type'], phase: 0, t: 0 } } : null; });
  sim.grenades = s.g.map(g => ({ kind: (g[3] === 1 ? 'smoke' : g[3] === 2 ? 'gas' : 'bang') as GrenadeKind, x: g[0], y: g[1], z: g[2], vx: 0, vy: 0, vz: 0, t: 1 }));
  sim.clouds = s.cl ? s.cl.map(c => ({ kind: (c[0] === 1 ? 'gas' : 'smoke') as 'smoke' | 'gas', x: c[1], z: c[2], r: c[3], t: c[4], maxT: 18 })) : [];
  sim.evidence = s.ev ? s.ev.map(e => ({ id: e[0], x: e[1], z: e[2], yaw: e[3], kind: e[4] === 2 ? 'shotgun' : e[4] === 1 ? 'rifle' : 'pistol', secured: !!e[5], ownerId: -1 })) : [];
  sim.sensorPings = s.sp ? s.sp.map(pg => ({ x: pg[0], z: pg[1], kind: (pg[2] ? 'suspect' : 'civ') as 'suspect' | 'civ', t: 1.0 })) : [];
  s.p.forEach((v, i) => {
    const p = sim.players[i]; if (!p) return;
    p.bangs = v[0]; p.flash = v[1]; p.cuff = v[2] >= 0 ? sim.actors[v[2]] : null; p.cuffT = v[3];
    if (v.length > 4) { p.c2 = v[4]; p.wedges = v[5]; }
    if (v.length > 6) { p.bleedT = v[6]; p.reviving = v[7] >= 0 ? sim.actors[v[7]] : null; p.reviveT = v[8]; }
    if (v.length > 9) { p.smokes = v[9]; p.gases = v[10]; }
    if (v.length > 11) p.sensors = v[11];
  });
  if (s.pw !== undefined) sim.powerOn = !!s.pw;
  if (s.bm && sim.bomb) { sim.bomb.time = s.bm[0]; sim.bomb.defused = !!s.bm[1]; }
  if (s.bw) for (const k of s.bw) sim.brokenWindows.add(k);
  if (s.bp) for (const k of s.bp) sim.brokenProps.add(k);
  if (s.bd) for (const k of s.bd) sim.brokenDoorGlass.add(k);
  if (s.bs !== undefined) sim.breachSyncT = s.bs;
  sim.time = s.time;
  if (s.over && !sim.over) {
    if (s.st) Object.assign(sim.stats, s.st);
    if (s.mvp) s.mvp.forEach((m, idx) => { const pl = sim.players[idx]; if (pl) Object.assign(pl, m); });
    if (s.rf) sim.replayFrames = s.rf;
    if (s.re) sim.replayEvents = s.re;
    sim.over = { win: s.over === 2 };
  }
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
