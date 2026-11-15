import { Sim, yawTo, fwd } from '../src/sim/sim';
import { parseCommand } from '../src/sim/commands';
import { findPath } from '../src/sim/nav';
import { MISSIONS } from '../src/sim/level';
import { encodeSnap, applySnap, encodeEv, decodeEv } from '../src/sim/netstate';

let fails = 0;
const ok = (c: boolean, msg: string) => { if (!c) { fails++; console.log('  FAIL', msg); } };

// ---- parser ----
const cases: [string, string][] = [
  ['Team A go left', 'A move left'], ['Team B you cover me', 'B cover'], ['team b, follow me', 'B follow'],
  ['everyone hold', 'ALL hold'], ['Bravo breach the room', 'B breach'], ['alpha stack up on the door', 'A stack'],
  ['team a flashbang and go in', 'A bang'], ['Police! Drop the weapon!', 'ALL shout'], ['open the door team a', 'A open'],
  ['team b cuff them', 'B restrain'], ['red team right', 'A move right'], ['blue team go over there', 'B move there'],
  ['hold fire', 'ALL fireHold'], ['team a weapons free', 'A fireFree'], ['Team A move left', 'A move left'], ['team two cover me', 'B cover'],
  ['everyone on me', 'ALL follow'], ['team one move up', 'A move forward'], ['team a and team b follow me', 'ALL follow'], ['hello how are you', 'null'],
  ['team a fall back', 'A move back'], ['Team A opens the door', 'A open'], ['team-a close the door', 'A close'], ['bravo door', 'B stack'], ['team b breaching', 'B breach'], ['shut the door', 'ALL close'],
  ['Police! Get on the ground!', 'ALL shout'], ['show me your hands', 'ALL shout'], ['team b wait', 'B hold'], ['alpha sitrep', 'A report'], ['bravo bang and clear', 'B bang'], ['team a secure them', 'A restrain'],
];
for (const [t, exp] of cases) { const c = parseCommand(t); const got = c ? [c.team, c.action, c.dir].filter(Boolean).join(' ') : 'null'; ok(got === exp, `parse "${t}" => ${got} (expected ${exp})`); }
console.log('parser cases:', cases.length);

// ---- headless bot playthrough ----
function play(mission: number, seed: number, verbose = false) {
  const sim = new Sim(mission, seed, 1); const p = sim.player; const dt = 1 / 30;
  const doors = [...sim.level.doors]; let di = -1, state = 'next', st = 0, path: { x: number; z: number }[] | null = null;
  let maxStuck = 0; const says: string[] = [];
  const walkTo = (x: number, z: number) => {
    if (!path) path = findPath(sim.level, p, { x, z }); if (!path || !path.length) { path = null; return true; }
    const wp = path[0], dx = wp.x - p.x, dz = wp.z - p.z, d = Math.hypot(dx, dz);
    if (d < 0.25) { path.shift(); return path.length === 0; }
    p.yaw = yawTo(dx, dz);
    const f = fwd(p.yaw); const cx = Math.floor(p.x + f.x * 0.8), cz = Math.floor(p.z + f.z * 0.8); const door = sim.doorAtCell(cx, cz); if (door && door.open < 0.7) { sim.setDoor(door, true); return false; }
    sim.movePlayer((dx / d) * 3.5 * dt, (dz / d) * 3.5 * dt); return false;
  };
  let t = 0;
  for (; t < 60 * 20 && !sim.over; t += dt) {
    st += dt;
    if (state === 'next') { di++; if (di >= doors.length) { di = -1; } state = 'go'; st = 0; path = null; }
    else if (state === 'go') {
      const d = doors[Math.max(0, di)]; const side = d.horiz ? (p.z > d.cz + .5 ? 1 : -1) : (p.x > d.cx + .5 ? 1 : -1);
      const tx = d.horiz ? d.cx + .5 : d.cx + .5 + side * 2.5, tz = d.horiz ? d.cz + .5 + side * 2.5 : d.cz + .5;
      if (walkTo(tx, tz) || st > 25) { p.yaw = yawTo(d.cx + .5 - p.x, d.cz + .5 - p.z); sim.command({ team: 'ALL', action: sim.rng() < .5 ? 'bang' : 'breach' }); state = 'wait'; st = 0; }
    } else if (state === 'wait') {
      if (st > 9) { sim.command({ team: 'ALL', action: 'restrain' }); state = 'cuff'; st = 0; }
    } else if (state === 'cuff') {
      if (st > 1 && Math.floor(st * 30) % 30 === 0) { sim.playerShout(); }
      if (st > 8) { sim.command({ team: 'ALL', action: 'follow' }); state = 'regroup'; st = 0; }
    } else if (state === 'regroup') { if (st > 2.5) state = 'next'; }
    if (Math.floor(t * 30) % 40 === 0) sim.playerShout();
    const th = sim.suspects.find(x => x.alive && !x.down && x.armed && (x.hostile || x.hasFired) && Math.hypot(x.x - p.x, x.z - p.z) < 25 && sim.los(p.x, p.z, x.x, x.z));
    if (th && Math.floor(t * 30) % 6 === 0) { const dx = th.x - p.x, dz = th.z - p.z, d = Math.hypot(dx, dz), j = () => (sim.rng() - .5) * .12; p.yaw = yawTo(dx, dz); const v = [dx / d + j(), -0.15 / d + j() * .5, dz / d + j()]; sim.fire(p, p.x, 1.6, p.z, v[0], v[1], v[2], 34); }
    sim.update(dt);
    for (const e of sim.events) { if (e.t === 'say') says.push(e.text); }
    sim.events.length = 0;
    for (const a of sim.actors) { ok(Number.isFinite(a.x) && Number.isFinite(a.z), 'NaN position'); if (a.alive && !a.down && sim.solidCell(Math.floor(a.x), Math.floor(a.z)) && sim.cell(Math.floor(a.x), Math.floor(a.z)) !== 3) { fails++; if (fails < 20) console.log('  FAIL actor inside solid', a.name, a.x.toFixed(2), a.z.toFixed(2), sim.cell(Math.floor(a.x), Math.floor(a.z))); } maxStuck = Math.max(maxStuck, a.stuckT); }
  }
  const r = sim.remaining(), sc = sim.score();
  console.log(`mission ${mission} "${MISSIONS[mission].name}" seed ${seed}: ${sim.over ? (sim.over.win ? 'WIN' : 'LOSE') : 'timeout'} t=${t.toFixed(0)}s remaining=${JSON.stringify(r)} score=${sc.total} stats=${JSON.stringify(sim.stats)} playerHp=${p.hp.toFixed(0)} officers=${sim.officers.map(o => o.hp.toFixed(0)).join('/')}`);
  if (verbose) console.log([...new Set(says)].join(' | '));
  return sim;
}
// ---- co-op: host sim + mirrored client sim ----
{
  const host = new Sim(0, 7, 1, 3), mir = new Sim(0, 7, 1, 3); const me = mir.players[1]; mir.player = me;
  ok(host.actors.length === mir.actors.length && host.players.length === 3, 'coop actor count');
  const solo = new Sim(0, 7, 1, 1); ok(solo.suspects.every((x, i) => x.x === host.suspects[i].x && x.id === host.suspects[i].id), 'extra players must not change the level');
  host.command({ team: 'A', action: 'follow' }, null, host.players[1]); host.command({ team: 'B', action: 'breach' }, null, host.players[0]);
  let evs = 0;
  for (let i = 0; i < 400; i++) {
    const rp = host.players[1]; rp.z -= 0.02; host.pushTrail(rp); // remote player walks north
    host.update(1 / 30);
    const wire = JSON.parse(JSON.stringify({ s: encodeSnap(host), e: host.events.map(encodeEv) })); host.events.length = 0;
    applySnap(mir, wire.s, me); for (const e of wire.e) { const d = decodeEv(mir, e); evs++; if ('a' in d) ok(d.a === mir.actors[(d.a as any).id], 'event actor decode'); }
  }
  ok(mir.officers.every((o, i) => Math.abs(o.x - host.officers[i].x) < 0.02 && Math.abs(o.z - host.officers[i].z) < 0.02), 'mirror positions');
  ok(mir.teams.A.order.type === host.teams.A.order.type && mir.level.doors.every((d, i) => Math.abs(d.open - host.level.doors[i].open) < 0.02), 'mirror orders/doors');
  const a1 = host.officers[0], rp = host.players[1]; ok(Math.hypot(a1.x - rp.x, a1.z - rp.z) < 5, 'team A follows the remote player: ' + Math.hypot(a1.x - rp.x, a1.z - rp.z).toFixed(1));
  ok(evs > 0, 'events forwarded');
  host.damage(host.players[0], 9999, host.suspects[0], false); ok(!host.over, 'mission continues while a player is alive');
  host.damage(host.players[1], 9999, host.suspects[0], false); host.damage(host.players[2], 9999, host.suspects[0], false); ok(!!host.over && !host.over.win, 'mission fails when all players are down');
  console.log('co-op mirror test done');
}
{ // a kneeling or cuffed person in a doorway must give way instead of blocking it
  let stuck = 0, cases = 0;
  for (const m of [0, 1, 2]) {
    const sim = new Sim(m, 3, 1) as any; const p = sim.player, c = sim.civs[0];
    for (const o of sim.officers) { o.x = -50 - o.slot * 3; o.z = -50; }
    for (const s of sim.suspects) s.alive = false; for (const x of sim.civs) if (x !== c) x.alive = false;
    for (const d of sim.level.doors) for (const sign of [-1, 1]) for (const off of [0, 0.15, -0.25]) {
      d.open = 1; d.target = 1; const ax = sim.solidCell(d.cx - 1, d.cz) ? [0, 1] : [1, 0];
      c.x = d.cx + 0.5 + ax[1] * off; c.z = d.cz + 0.5 + ax[0] * off; c.surrendered = true; c.restrained = true;
      p.x = d.cx + 0.5 - ax[0] * 1.2 * sign; p.z = d.cz + 0.5 - ax[1] * 1.2 * sign; const x0 = p.x, z0 = p.z;
      for (let i = 0; i < 90; i++) { sim.movePlayer(ax[0] * sign * 0.07, ax[1] * sign * 0.07); sim.checkT = 9; sim.update(1 / 30); d.open = 1; d.target = 1; }
      cases++; if ((p.x - x0) * ax[0] * sign + (p.z - z0) * ax[1] * sign < 2.4 || sim.solidCell(Math.floor(c.x), Math.floor(c.z))) stuck++;
    }
  }
  ok(stuck === 0, `player blocked by a kneeling person in ${stuck}/${cases} doorway cases`);
  console.log('doorway test done');
}
let wins = 0, n = 0;
for (let m = 0; m < 3; m++) for (let s = 1; s <= 4; s++) { const sim = play(m, s, m === 0 && s === 1); n++; if (sim.over?.win) wins++; }
console.log(`wins ${wins}/${n}`);
ok(wins >= 3, 'bot should be able to win some missions');
console.log(fails ? `FAILED (${fails})` : 'ALL OK'); process.exit(fails ? 1 : 0);
