// Fast headless playthrough used as a playability regression gate.
// Bots every operation from both insertion points, then fails the run when the game is unwinnable,
// actors clip into geometry, the squad gets stuck, or the bomb flow regresses.
import { Sim, yawTo, fwd } from '../src/sim/sim';
import { MISSIONS } from '../src/sim/level';
import { findPath } from '../src/sim/nav';

const DT = 1 / 30;
let failures = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { failures++; console.log('  FAIL', msg); } };

interface Run {
  mission: number; name: string; seed: number; entry: number;
  win: boolean; result: 'WIN' | 'LOSE' | 'TIMEOUT'; reason: string; t: number;
  score: number; defused: boolean; suspectsLeft: number; civsLeft: number;
  maxStuck: number; insideWall: number; pathFails: number; hp: number;
}

function play(mission: number, seed: number, entry: number): Run {
  const sim = new Sim(mission, seed, 1, 1, {}, entry ? { entry } : {});
  const p = sim.player;
  const doors = [...sim.level.doors];
  let di = -1, state = 'next', st = 0, path: { x: number; z: number }[] | null = null;
  let maxStuck = 0, insideWall = 0, pathFails = 0, t = 0;

  const openDoor = (door: ReturnType<Sim['doorAtCell']>) => {
    if (!door || door.open >= 0.7) return;
    // Locked wooden doors are kicked; heavy metal ones are left to the bot's breach charge.
    if (door.locked) { if (!sim.kickDoor(door, p)) sim.setDoor(door, true, true); }
    else sim.setDoor(door, true);
  };
  const walkTo = (x: number, z: number) => {
    if (!path) { path = findPath(sim.level, p, { x, z }); if (!path?.length) { pathFails++; path = null; return false; } }
    const wp = path[0], dx = wp.x - p.x, dz = wp.z - p.z, d = Math.hypot(dx, dz);
    if (d < 0.25) { path.shift(); return path.length === 0; }
    p.yaw = yawTo(dx, dz);
    const f = fwd(p.yaw);
    const door = sim.doorAtCell(Math.floor(p.x + f.x * 0.8), Math.floor(p.z + f.z * 0.8));
    if (door && door.open < 0.7) { openDoor(door); return false; }
    sim.movePlayer((dx / d) * 3.5 * DT, (dz / d) * 3.5 * DT);
    return false;
  };

  for (; t < 60 * 10 && !sim.over; t += DT) {
    st += DT;
    const bomb = sim.bomb;
    // Bomb first: a defused device stops the clock, then the club is cleared at leisure.
    if (bomb && !bomb.defused && (sim.level.objective === 'bomb' || sim.remaining().suspects === 0)) {
      const d = Math.hypot(bomb.x - p.x, bomb.z - p.z);
      if (d > 1.9) walkTo(bomb.x, bomb.z);
      else if (!p.defusing) sim.playerUse(p);
    } else if (state === 'next') { di++; if (di >= doors.length) di = -1; state = 'go'; st = 0; path = null; }
    else if (state === 'go') {
      const d = doors[Math.max(0, di)];
      const side = d.horiz ? (p.z > d.cz + .5 ? 1 : -1) : (p.x > d.cx + .5 ? 1 : -1);
      const tx = d.horiz ? d.cx + .5 : d.cx + .5 + side * 2.5, tz = d.horiz ? d.cz + .5 + side * 2.5 : d.cz + .5;
      if (walkTo(tx, tz) || st > 25) {
        p.yaw = yawTo(d.cx + .5 - p.x, d.cz + .5 - p.z);
        sim.command({ team: 'ALL', action: sim.rng() < .5 ? 'bang' : 'breach' }); state = 'wait'; st = 0;
      }
    } else if (state === 'wait') { if (st > 9) { sim.command({ team: 'ALL', action: 'restrain' }); state = 'cuff'; st = 0; } }
    else if (state === 'cuff') {
      if (st > 1 && Math.floor(st * 30) % 30 === 0) sim.playerShout();
      if (st > 8) { sim.command({ team: 'ALL', action: 'follow' }); state = 'regroup'; st = 0; }
    } else if (state === 'regroup') { if (st > 2.5) state = 'next'; }

    if (Math.floor(t * 30) % 40 === 0) sim.playerShout();
    const threat = sim.suspects.find(x => x.alive && !x.down && x.armed && (x.hostile || x.hasFired)
      && Math.hypot(x.x - p.x, x.z - p.z) < 25 && sim.los(p.x, p.z, x.x, x.z));
    if (threat && Math.floor(t * 30) % 6 === 0) {
      const dx = threat.x - p.x, dz = threat.z - p.z, d = Math.hypot(dx, dz), j = () => (sim.rng() - .5) * .12;
      p.yaw = yawTo(dx, dz);
      sim.fire(p, p.x, 1.6, p.z, dx / d + j(), -0.15 / d + j() * .5, dz / d + j(), 34);
    }
    sim.update(DT);
    sim.events.length = 0;
    if (p.alive && sim.solidCell(Math.floor(p.x), Math.floor(p.z)) && sim.cell(Math.floor(p.x), Math.floor(p.z)) !== 3) insideWall++;
    for (const a of sim.actors) {
      ok(Number.isFinite(a.x) && Number.isFinite(a.z), `NaN position in ${MISSIONS[mission].name} seed ${seed}`);
      maxStuck = Math.max(maxStuck, a.stuckT);
      if (a.alive && !a.down && sim.solidCell(Math.floor(a.x), Math.floor(a.z)) && sim.cell(Math.floor(a.x), Math.floor(a.z)) !== 3) insideWall++;
    }
  }

  const r = sim.remaining();
  return {
    mission, name: MISSIONS[mission].name, seed, entry,
    win: !!sim.over?.win, result: sim.over ? (sim.over.win ? 'WIN' : 'LOSE') : 'TIMEOUT',
    reason: sim.over?.reason ?? '', t: Math.round(t), score: sim.score().total,
    defused: !!sim.bomb?.defused, suspectsLeft: r.suspects, civsLeft: r.civs,
    maxStuck, insideWall, pathFails, hp: Math.max(0, Math.round(p.hp)),
  };
}

// ---- targeted regression checks -------------------------------------------------
{
  // The backstage insertion is six metres from the bomb, behind a locked door. It must be usable.
  const sim = new Sim(4, 1, 1, 1, {}, { entry: 1 });
  const p = sim.player, bomb = sim.bomb!;
  let path = findPath(sim.level, p, { x: bomb.x, z: bomb.z }), t = 0, reached = false;
  while (t < 20 && path?.length) {
    const wp = path[0], dx = wp.x - p.x, dz = wp.z - p.z, d = Math.hypot(dx, dz);
    if (d < 0.3) { path.shift(); continue; }
    p.yaw = yawTo(dx, dz);
    const f = fwd(p.yaw), door = sim.doorAtCell(Math.floor(p.x + f.x * 0.8), Math.floor(p.z + f.z * 0.8));
    if (door && door.open < 0.7) { if (door.locked) sim.kickDoor(door, p); else sim.setDoor(door, true); }
    else sim.movePlayer((dx / d) * 3.5 * DT, (dz / d) * 3.5 * DT);
    sim.update(DT); sim.events.length = 0; t += DT;
    if (Math.hypot(bomb.x - p.x, bomb.z - p.z) < 1.9) { reached = true; break; }
  }
  ok(reached, 'Club Eclipse backstage insertion can reach the bomb through the locked door');
}

{
  // Deployment grace: standing at the insertion point must not be a shooting gallery.
  for (const [m, seed] of [[4, 1], [4, 2], [4, 3], [4, 4]] as const) {
    const sim = new Sim(m, seed);
    const hp0 = sim.player.hp;
    for (let i = 0; i < 2.5 * 30; i++) { sim.update(DT); sim.events.length = 0; }
    ok(sim.player.hp === hp0, `no damage during deployment grace (Club Eclipse seed ${seed})`);
  }
}

// ---- full playthrough -----------------------------------------------------------
const rows: Run[] = [];
for (let m = 0; m < MISSIONS.length; m++) for (const seed of [1, 2]) for (const entry of [0, 1]) rows.push(play(m, seed, entry));

for (const r of rows) {
  ok(r.insideWall === 0, `${r.name} seed ${r.seed} entry ${r.entry}: actor clipped into solid geometry (${r.insideWall} frames)`);
  ok(r.maxStuck <= 2.5, `${r.name} seed ${r.seed} entry ${r.entry}: stuck for ${r.maxStuck.toFixed(1)}s`);
  ok(r.pathFails === 0, `${r.name} seed ${r.seed} entry ${r.entry}: ${r.pathFails} unreachable move targets`);
}

const wins = rows.filter(r => r.win).length;
ok(wins / rows.length >= 0.6, `overall win rate ${wins}/${rows.length} is below 60%`);

for (const name of new Set(rows.map(r => r.name))) {
  const rs = rows.filter(r => r.name === name);
  const w = rs.filter(r => r.win).length;
  ok(w > 0, `${name}: no successful run in ${rs.length} attempts`);
  const avgT = Math.round(rs.reduce((a, r) => a + r.t, 0) / rs.length);
  console.log(`  ${name.padEnd(19)} win ${w}/${rs.length}  avg ${String(avgT).padStart(3)}s  avg score ${Math.round(rs.reduce((a, r) => a + r.score, 0) / rs.length)}`);
}

const bombRuns = rows.filter(r => r.name === 'Club Eclipse');
ok(bombRuns.some(r => r.defused), 'Club Eclipse: the bomb was never defused');

console.log(`\nplaytest: ${rows.length} operations, ${wins} wins, ${failures} failure(s)`);
if (failures) process.exit(1);
console.log('PLAYTEST OK');
